"""
moderation.py
-------------
판정 로직의 **어댑터 계층**.

바깥(main.py)에서는 오직 `load_model()` / `moderate_batch()` / `current_mode()` 만 호출한다.
따라서 판정 방식을 바꿔도 라우팅/스키마/익스텐션은 건드릴 필요가 없다.

현재 판정 구성 (2단 구조)
  1) 모델: smilegate-ai/kor_unsmile (HuggingFace)
       -> 욕설 / 혐오표현 담당. 멀티라벨 분류(sigmoid).
  2) 규칙: 아래 _RULES 의 키워드 정규식
       -> 성희롱 / 스팸 담당. 모델에 해당 라벨이 없기 때문에 항상 함께 돌린다.

  두 결과 중 severity 가 높은 쪽을 최종 채택한다.
  => 모델이 '정상'이라고 봐도 스팸 규칙에 걸리면 스팸으로 판정된다.

모델 로딩에 실패하면 서버를 죽이지 않고, 규칙만 쓰는 폴백 모드로 자동 강등된다.
(이때는 욕설/혐오표현 규칙까지 전부 활성화된다.)
"""

from __future__ import annotations

import logging
import re

import anyio

from schemas import CommentIn, ModerationResult

logger = logging.getLogger("moderation")

# ---------------------------------------------------------------------------
# 모델 설정
# ---------------------------------------------------------------------------

MODEL_NAME = "smilegate-ai/kor_unsmile"

# 추론 파라미터
MAX_LENGTH = 128  # 유튜브 댓글은 대부분 짧다. 넘치면 잘라낸다.
BATCH_SIZE = 16  # 파이프라인 내부 배치 크기

# sigmoid 출력의 기본 판정 경계값. 이 미만이면 '정상'으로 본다.
# 0.5 는 멀티라벨 분류의 자연스러운 경계이며, 익스텐션 기본 블러 임계값 50과도 일치한다.
MODEL_THRESHOLD = 0.5

# ★ 라벨별 경계값 (없으면 MODEL_THRESHOLD 사용)
#
# '악플/욕설' 라벨만 유독 기준이 높은 이유:
#   이 라벨은 이름 그대로 '악플'을 포함한다. 즉 욕설이 한 글자도 없어도
#   비난/조롱하는 어조면 반응한다. 실측 예:
#       "아니 이게 축구냐 ... 이러놓고선 1등도 못해"  -> 67.5%
#       "아.쪽팔린다..."                              -> 70.5%
#       "ㅅㅂ 진짜 어이없네"                          -> 91.1%
#   단순 불평과 진짜 욕설이 60~90% 구간에 섞여 있어, 0.5 로 두면 오탐이 쏟아진다.
#   반면 혐오 라벨 8종은 특정 표현에 정확히 반응하지만 점수가 낮게 나오는 편이라
#   (예: '틀딱' -> 연령 77.4%) 기준을 올리면 진짜 혐오표현을 놓친다.
#   => 그래서 라벨마다 다른 기준을 쓴다. 전역 임계값 하나로는 둘 다 만족시킬 수 없다.
#
# TODO: 이 값들은 소수의 관측치로 정한 추정치다.
#       유튜브 댓글을 모아 점수 분포를 보고 재조정할 것.
LABEL_THRESHOLDS: dict[str, float] = {
    "악플/욕설": 0.85,
}

# kor_unsmile 의 10개 라벨 -> 우리 4개 카테고리 매핑.
# (config.json 의 id2label 과 문자열이 정확히 일치해야 한다)
CLEAN_LABEL = "clean"
LABEL_TO_CATEGORY: dict[str, str] = {
    "악플/욕설": "욕설",
    "여성/가족": "혐오표현",
    "남성": "혐오표현",
    "성소수자": "혐오표현",
    "인종/국적": "혐오표현",
    "연령": "혐오표현",
    "지역": "혐오표현",
    "종교": "혐오표현",
    "기타 혐오": "혐오표현",
    # CLEAN_LABEL 은 매핑에 넣지 않는다 -> '정상'을 의미
}

# 서버 시작 시 한 번만 채워지는 싱글톤. 요청마다 재로딩하지 않는다.
_PIPELINE = None
_LOAD_ERROR: str | None = None


def load_model() -> bool:
    """모델을 메모리에 올린다. main.py 의 lifespan 에서 부팅 시 1회 호출.

    이미 로드돼 있으면 아무것도 하지 않는다(멱등).
    실패해도 예외를 던지지 않고 False 를 돌려준다 -> 규칙 폴백 모드로 동작.
    """
    global _PIPELINE, _LOAD_ERROR

    if _PIPELINE is not None:
        return True

    try:
        # import 자체가 무겁기 때문에 함수 안에서 한다.
        from transformers import (
            AutoTokenizer,
            BertForSequenceClassification,
            TextClassificationPipeline,
        )

        logger.info("모델 로딩 시작: %s (최초 실행 시 다운로드로 수 분 걸릴 수 있음)", MODEL_NAME)

        model = BertForSequenceClassification.from_pretrained(MODEL_NAME)
        tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)

        _PIPELINE = TextClassificationPipeline(
            model=model,
            tokenizer=tokenizer,
            device=-1,  # CPU. GPU 를 쓰려면 0 (또는 GPU 번호)으로.
            top_k=None,  # 모든 라벨의 점수를 받는다 (구 return_all_scores=True)
            function_to_apply="sigmoid",  # ★ 멀티라벨 모델이므로 softmax 가 아니라 sigmoid
        )
        _LOAD_ERROR = None
        logger.info("모델 로딩 완료: %s", MODEL_NAME)
        return True

    except Exception as e:  # noqa: BLE001 - 어떤 이유든 폴백으로 넘어가야 한다
        _LOAD_ERROR = f"{type(e).__name__}: {e}"
        logger.warning("모델 로딩 실패 -> 규칙 기반 폴백으로 동작합니다. (%s)", _LOAD_ERROR)
        return False


def is_model_ready() -> bool:
    return _PIPELINE is not None


def current_mode() -> str:
    """/health 에 노출되는 현재 판정 모드. 익스텐션 사이드 패널에 그대로 표시된다."""
    return "kor_unsmile" if is_model_ready() else "rule-based-fallback"


# ---------------------------------------------------------------------------
# 규칙 기반 판정
#   - 성희롱 / 스팸: 모델에 라벨이 없으므로 '항상' 사용한다.
#   - 욕설 / 혐오표현: 모델이 담당하므로 평소엔 쓰지 않고,
#                     모델 로딩 실패 시에만 안전망으로 켜진다.
# ---------------------------------------------------------------------------

# (정규식, 카테고리, severity, 사유)
_RULES: list[tuple[str, str, int, str]] = [
    # --- 성희롱 (모델에 라벨 없음 -> 항상 사용) ---
    (r"(몸매|가슴|다리)\s*(좋|죽인|예술)", "성희롱", 85, "외모/신체에 대한 성적 대상화 표현입니다."),
    (r"(야한|섹스|야동|19금)", "성희롱", 70, "성적인 표현이 포함되어 있습니다."),
    # --- 스팸 (모델에 라벨 없음 -> 항상 사용) ---
    (r"(https?://|www\.)\S*(\.top|\.xyz|bit\.ly|cutt\.ly)", "스팸", 90, "의심스러운 단축/외부 링크가 포함되어 있습니다."),
    (r"(카톡|텔레\s*그램|오픈\s*채팅|디엠)\s*(주세요|ㄱㄱ|추가)", "스팸", 80, "외부 채널 유도 문구입니다."),
    (r"(무료|공짜|수익|부업|토토|먹튀|홀덤|코인\s*리딩)", "스팸", 65, "광고성 문구로 보입니다."),
    (r"(구독|맞구독)\s*(하면|하고)\s*(구독|맞구독)", "스팸", 55, "맞구독 유도로 보입니다."),
    # --- 욕설 (항상 사용) ---
    # 노골적인 욕설만 담는다. 모호한 표현은 넣지 말 것 — 모델이 담당하는 영역이고,
    # 여기에 넣으면 오탐이 바로 늘어난다.
    # (참고: 예전에 있던 (바보|멍청이|한심) 규칙은 오탐이 많아 제거했다.
    #        "한심하다"는 사람이 아니라 상황에 대한 말인 경우가 대부분이다.)
    (r"(시발|씨발|ㅅㅂ|병신|ㅂㅅ|좆|지랄|개새끼|미친놈|꺼져)", "욕설", 80, "욕설 표현이 포함되어 있습니다."),
    (r"(fuck|shit|bitch|asshole)", "욕설", 75, "영문 비속어가 포함되어 있습니다."),
    # --- 혐오표현 (평소엔 모델이 담당. 폴백 전용) ---
    (r"(맘충|한남|김치녀|틀딱|급식충|외노자|짱깨|쪽바리)", "혐오표현", 90, "특정 집단을 비하하는 혐오 표현입니다."),
    (r"(다\s*죽어야|없어져야\s*할)", "혐오표현", 85, "특정 대상에 대한 적대적 표현입니다."),
]

_COMPILED = [(re.compile(p, re.IGNORECASE), c, s, r) for p, c, s, r in _RULES]

# 모델과 무관하게 항상 규칙으로 확인하는 카테고리.
#   성희롱/스팸 - 모델에 라벨 자체가 없다.
#   욕설       - 명백한 욕설 키워드는 규칙의 정확도가 오히려 높다.
#                모델의 '악플/욕설' 기준을 0.85 로 올린 만큼, 놓치는 노골적 욕설을
#                규칙이 받아준다(모델은 애매한 악플, 규칙은 확실한 욕설 담당).
ALWAYS_ON_RULE_CATEGORIES = frozenset({"성희롱", "스팸", "욕설"})

# 감탄사/문장부호 도배 가중치
_REPEAT = re.compile(r"(ㅋ{5,}|ㅎ{5,}|!{3,}|\?{3,})")


def _rule_candidate(text: str, allowed: frozenset[str] | None) -> tuple[str, int, str] | None:
    """규칙으로 (카테고리, severity, 사유) 를 뽑는다. 걸리는 게 없으면 None.

    allowed 가 주어지면 해당 카테고리 규칙만 검사한다.
    """
    best: tuple[str, int, str] | None = None

    for pattern, category, severity, reason in _COMPILED:
        if allowed is not None and category not in allowed:
            continue
        if pattern.search(text) and (best is None or severity > best[1]):
            best = (category, severity, reason)

    if best is None:
        return None

    category, severity, reason = best
    if _REPEAT.search(text):
        severity = min(100, severity + 5)

    return category, severity, f"{reason} (규칙 기반)"


# ---------------------------------------------------------------------------
# 모델 추론
# ---------------------------------------------------------------------------


def _infer_sync(texts: list[str]) -> list[list[dict]]:
    """파이프라인 배치 추론 (동기).

    반환: 댓글별 [{'label': str, 'score': float}, ...] 리스트.
    CPU 를 오래 잡는 작업이라 반드시 워커 스레드에서 호출할 것.
    """
    return _PIPELINE(
        texts,
        batch_size=BATCH_SIZE,
        truncation=True,
        max_length=MAX_LENGTH,
    )


def _model_candidate(scores: list[dict]) -> tuple[str | None, int, str]:
    """한 댓글의 라벨 점수들로부터 (카테고리, severity, 사유) 를 만든다.

    clean 을 제외한 라벨 각각을 '그 라벨 고유의 경계값'과 비교해서 통과한 것만 남기고,
    그중 점수가 가장 높은 것을 채택한다.

    주의: '점수 최고를 먼저 고르고 경계값을 검사'하면 안 된다.
          예를 들어 악플/욕설 0.80(기준 0.85 미달)과 연령 0.60(기준 0.50 통과)이
          같이 나온 댓글에서, 최고점만 보면 악플이 뽑히고 탈락해 '정상'이 되어버린다.
          실제로는 연령 혐오로 잡혀야 한다.
    """
    harmful = [s for s in scores if s["label"] != CLEAN_LABEL]
    if not harmful:
        return None, 0, "모델 판정 정상"

    passed = [
        s for s in harmful if float(s["score"]) >= LABEL_THRESHOLDS.get(s["label"], MODEL_THRESHOLD)
    ]

    if not passed:
        # 아무 라벨도 기준을 넘지 못함 -> 정상. 참고용으로 최고 점수 라벨을 사유에 남긴다.
        top = max(harmful, key=lambda s: s["score"])
        return None, 0, f"모델 판정 정상 (최고 유해 라벨 '{top['label']}' {float(top['score']) * 100:.1f}%)"

    top = max(passed, key=lambda s: s["score"])
    label, score = top["label"], float(top["score"])
    pct = score * 100

    category = LABEL_TO_CATEGORY.get(label)
    if category is None:
        # 모델이 알 수 없는 라벨을 뱉은 경우(매핑 누락). 안전하게 정상 처리하고 로그를 남긴다.
        logger.warning("매핑되지 않은 라벨: %r — LABEL_TO_CATEGORY 확인 필요", label)
        return None, 0, f"미매핑 라벨 '{label}' ({pct:.1f}%)"

    reason = f"모델이 '{label}' 라벨을 {pct:.1f}% 확률로 감지하여 {category}(으)로 판정했습니다."
    return category, round(pct), reason


# ---------------------------------------------------------------------------
# 공개 진입점
# ---------------------------------------------------------------------------


async def moderate_batch(comments: list[CommentIn]) -> list[ModerationResult]:
    """댓글 배치를 판정해서 결과 리스트를 돌려준다.

    main.py 는 이 함수만 알면 된다.
    입력 순서와 출력 순서/개수는 항상 1:1로 대응한다.
    """
    if not comments:
        return []

    texts = [(c.text or "") for c in comments]

    # --- 폴백 모드: 모델이 없으면 전체 규칙으로만 판정 ---
    if not is_model_ready():
        results = []
        for comment, text in zip(comments, texts):
            hit = _rule_candidate(text, allowed=None)
            if hit is None:
                results.append(
                    ModerationResult(id=comment.id, category=None, severity=0, reason="특이사항 없음")
                )
            else:
                category, severity, reason = hit
                results.append(
                    ModerationResult(id=comment.id, category=category, severity=severity, reason=reason)
                )
        return results

    # --- 정상 모드: 모델 + 규칙 병합 ---
    # 추론은 CPU 를 오래 잡는 동기 작업이므로 워커 스레드로 넘긴다.
    # (이걸 안 하면 추론 중에 이벤트 루프가 멈춰 서버 전체가 응답하지 않는다)
    try:
        batch_scores = await anyio.to_thread.run_sync(_infer_sync, texts)
    except Exception as e:  # noqa: BLE001
        logger.error("추론 실패, 이번 배치는 규칙으로만 판정합니다: %s", e)
        batch_scores = [[] for _ in texts]

    results: list[ModerationResult] = []
    for comment, text, scores in zip(comments, texts, batch_scores):
        m_category, m_severity, m_reason = _model_candidate(scores)

        # 성희롱/스팸(모델에 라벨 없음) + 욕설(명백한 키워드는 규칙이 더 정확)은 항상 확인한다.
        rule_hit = _rule_candidate(text, allowed=ALWAYS_ON_RULE_CATEGORIES)

        # 두 후보 중 severity 가 높은 쪽을 채택.
        # -> 모델이 정상이라 봐도 스팸 규칙에 걸리면 스팸이 된다.
        if rule_hit is not None and rule_hit[1] > m_severity:
            category, severity, reason = rule_hit
        else:
            category, severity, reason = m_category, m_severity, m_reason

        results.append(
            ModerationResult(
                id=comment.id,
                category=category,
                severity=severity,
                reason=reason or "특이사항 없음",
            )
        )

    return results


# ---------------------------------------------------------------------------
# TODO (다음 단계)
# ---------------------------------------------------------------------------
# - 성희롱 라벨은 어떤 공개 데이터셋에도 없다. 직접 라벨링 후 별도 분류기 학습 필요.
# - 동일 텍스트 재추론을 줄이기 위한 캐시(텍스트 해시 -> 결과) 도입.
# - severity 는 엄밀히는 '심각도'가 아니라 모델의 '확신도'다.
#   심각도를 제대로 다루려면 강도 라벨이 붙은 데이터가 따로 필요하다.
# - kor_unsmile 학습 데이터(UnSmile)는 CC-BY-NC-ND 4.0 이다.
#   상업적 이용 전에 반드시 라이선스를 확인할 것.
