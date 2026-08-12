# 유튜브 댓글 AI 유해 모더레이션 (뼈대)

유튜브 댓글을 수집해 유해성을 판정하고, 유해 댓글을 **블러 처리**하는 크롬 익스텐션(MV3) +
FastAPI 백엔드입니다.

판정은 **2단 구조**입니다.

| 담당 | 카테고리 | 방식 |
|---|---|---|
| 모델 [`smilegate-ai/kor_unsmile`](https://huggingface.co/smilegate-ai/kor_unsmile) | 욕설, 혐오표현 | 멀티라벨 분류(sigmoid) |
| 키워드 규칙 | 성희롱, 스팸 | 정규식 (모델에 해당 라벨이 없음) |

두 결과 중 **severity가 높은 쪽**을 최종 채택합니다. 모델 로딩에 실패하면 서버가 죽지 않고
규칙만 쓰는 폴백 모드(`rule-based-fallback`)로 자동 강등됩니다.

## 파일 구조

```
Project_outlist_moderation/
├── backend/
│   ├── main.py            FastAPI 앱. POST /moderate, GET /health, CORS만 담당
│   ├── schemas.py         요청/응답 Pydantic 모델 = 데이터 계약의 단일 출처
│   ├── moderation.py      ★ 판정 어댑터. kor_unsmile 모델 + 규칙 폴백. 교체 지점은 여기 한 곳
│   └── requirements.txt   .venv 설치 버전 기준 (fastapi/uvicorn/pydantic/torch/transformers)
└── extension/
    ├── manifest.json      MV3 매니페스트
    ├── content.js         댓글 DOM 수집 → 배치 전송 → 블러 + [원문 보기]
    ├── content.css        블러/경고 배지 스타일
    ├── background.js      service worker. 백엔드 중계 + 탭별 통계 저장
    ├── sidepanel.html/css/js   통계 패널 (총/유해 댓글 수, 카테고리별 집계)
```

## 데이터 계약

**요청** `POST /moderate`

```json
{ "comments": [{ "id": "c1", "text": "댓글 원문" }] }
```

**응답**

```json
{ "results": [{ "id": "c1", "category": "욕설", "severity": 82, "reason": "욕설 표현이 포함되어 있습니다." }] }
```

- `category` : `욕설` | `혐오표현` | `성희롱` | `스팸`, **정상 댓글이면 `null`**
- `severity` : 0~100 (0이면 정상)
- 요청과 응답은 항상 1:1 대응 — 정상 댓글도 결과에 포함됩니다.
  (결과를 누락시키면 클라이언트가 "정상"과 "아직 판정 안 됨"을 구분할 수 없기 때문)

## 실행법

### 1) 백엔드

```powershell
cd C:\Project_outlist_moderation
.\.venv\Scripts\Activate.ps1

# torch 는 CPU 전용 휠로 받는 게 훨씬 가볍다 (최초 1회)
pip install torch --index-url https://download.pytorch.org/whl/cpu
pip install -r backend\requirements.txt

cd backend
uvicorn main:app --port 8000
```

⚠️ **최초 실행 시 모델 가중치(약 500MB)를 HuggingFace에서 내려받습니다.** 그동안 부팅이 지연됩니다.
두 번째부터는 `C:\Users\<사용자>\.cache\huggingface` 캐시를 써서 몇 초면 뜹니다.

확인:

```powershell
curl http://localhost:8000/health
# {"status":"ok","mode":"kor_unsmile"}          <- 모델 정상
# {"status":"ok","mode":"rule-based-fallback"}  <- 모델 로딩 실패, 규칙만 동작 중
```

> `--reload` 옵션을 쓰면 코드가 바뀔 때마다 모델을 다시 로드해 느립니다. 백엔드를 자주 안 고칠 거면 빼는 편이 낫습니다.
> `--reload`로 띄운 서버는 자식 프로세스가 남아 포트를 계속 점유할 수 있으니, 종료 후 8000번이 안 풀리면
> `Get-NetTCPConnection -LocalPort 8000 -State Listen` 으로 PID를 찾아 정리하세요.

API 문서는 http://localhost:8000/docs 에서 바로 테스트할 수 있습니다.

### 2) 익스텐션 로드

1. 크롬에서 `chrome://extensions` 접속
2. 우측 상단 **개발자 모드** 켜기
3. **압축해제된 확장 프로그램을 로드합니다** 클릭
4. `C:\Project_outlist_moderation\extension` 폴더 선택
5. 유튜브 영상 페이지로 이동 → 댓글 영역까지 스크롤
6. 툴바의 확장 아이콘 클릭 → **사이드 패널**에 통계 표시

> 백엔드가 꺼져 있으면 패널의 상태 표시가 "백엔드 꺼짐"이 되고, 블러는 적용되지 않습니다
> (페이지가 깨지지 않도록 fail-open 처리).

### 동작 확인 팁

API만 빠르게 확인하려면:

```powershell
curl -X POST http://localhost:8000/moderate -H "Content-Type: application/json" `
  -d '{\"comments\":[{\"id\":\"1\",\"text\":\"이 병신아\"},{\"id\":\"2\",\"text\":\"영상 잘 봤습니다\"}]}'
```

## 사이드 패널 기능

- 수집된 댓글 수 / 유해 판정 수 / 유해 비율
- 카테고리별 집계 (막대 그래프)
- 블러 on/off, 블러 임계값(severity) 슬라이더 — 변경 시 이미 판정된 댓글에도 즉시 반영
- 백엔드 연결 상태 표시

## 판정 동작 상세

**라벨 매핑** (`moderation.py`의 `LABEL_TO_CATEGORY`)

| kor_unsmile 라벨 | 우리 카테고리 |
|---|---|
| `악플/욕설` | 욕설 |
| `여성/가족`, `남성`, `성소수자`, `인종/국적`, `연령`, `지역`, `종교`, `기타 혐오` | 혐오표현 |
| `clean` | 정상 (category = null) |

`clean`을 제외한 9개 라벨 중 **점수가 가장 높은 것**을 고르고, 그 점수가 `MODEL_THRESHOLD`(0.5)
이상일 때만 유해로 판정합니다. `severity = round(확률 × 100)`.

**실측 예시**

| 댓글 | 결과 |
|---|---|
| 영상 잘 봤습니다 | 정상 (최고 유해 라벨 `악플/욕설` 5.0%) |
| 이래서 여자는 게임을 하면 안된다 | 혐오표현 83 (`여성/가족` 82.5%) |
| 틀딱들은 조용히 해라 | 혐오표현 77 (`연령` 77.4%) |
| ㅅㅂ 진짜 어이없네 | 욕설 91 (`악플/욕설` 91.1%) |
| 카톡 주세요 무료 수익 | 스팸 80 (규칙 기반) |

5건 배치 기준 CPU 추론 약 150ms.

## 남은 TODO

- **성희롱 분류기** — 공개 데이터셋에 라벨이 없어 현재 키워드 규칙으로만 처리 중. 직접 라벨링 필요
- **severity 의 의미** — 지금은 모델의 '확신도'이지 '심각도'가 아님. 강도 라벨 데이터가 따로 필요
- 동일 텍스트 결과 캐싱 — `backend/moderation.py`
- 실패 배치 재시도(지수 백오프) — `extension/content.js`
- 배포 시 CORS `allow_origins` 를 실제 확장 ID로 좁히기 — `backend/main.py`
- 익스텐션 아이콘 리소스 추가 (`manifest.json` 의 `icons`)

## ⚠️ 라이선스 주의

`kor_unsmile` 모델의 학습 데이터인 **Korean UnSmile Dataset은 CC-BY-NC-ND 4.0**(비영리 + 변형 금지)입니다.
모델 자체의 배포 조건은 별도로 확인이 필요하며, **상업적 이용 전에 반드시 스마일게이트에 문의해야 합니다**
(`smilegate_ai@smilegate.com`).

## 알려진 제약

- 유튜브 DOM 셀렉터(`ytd-comment-thread-renderer`, `#content-text`)에 의존하므로,
  유튜브가 마크업을 바꾸면 `content.js` 상단 상수를 수정해야 합니다.
- 임계값 변경은 재판정 없이 저장된 severity 로만 다시 계산합니다(재요청 없음).
