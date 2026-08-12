"""
main.py
-------
FastAPI 앱 조립 파일.

책임은 네 가지:
  1) HTTP 라우팅 (POST /moderate, GET /health)
  2) 요청/응답 검증 (schemas.py 의 모델 사용)
  3) CORS 허용 (크롬 익스텐션의 service worker 에서 fetch 하기 때문)
  4) 서버 부팅 시 판정 모델을 1회 로드 (lifespan)

판정 로직은 여기에 절대 쓰지 말 것 -> moderation.py 담당.

실행:
    .venv\\Scripts\\activate
    uvicorn main:app --reload --port 8000      # backend/ 디렉터리에서

주의: 최초 실행 시 HuggingFace 에서 모델(약 500MB)을 내려받으므로
      부팅이 수 분 걸릴 수 있다. 두 번째부터는 캐시를 쓰므로 빠르다.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from moderation import MODEL_NAME, current_mode, load_model, moderate_batch
from schemas import ModerateRequest, ModerateResponse

logger = logging.getLogger("moderation")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 수명주기 훅.

    부팅 시 모델을 딱 한 번 로드한다. 이후 요청은 이 인스턴스를 재사용하며,
    요청마다 다시 로드하는 일은 없다.
    로딩에 실패해도 서버는 뜨고, 규칙 기반 폴백 모드로 동작한다.
    """
    logger.info("모델 준비 중... (%s)", MODEL_NAME)
    load_model()
    logger.info("판정 모드: %s", current_mode())
    yield
    # 종료 시 정리할 리소스는 아직 없음.


app = FastAPI(
    title="YouTube Comment Moderation API",
    description="유튜브 댓글 유해성 판정 백엔드 (smilegate-ai/kor_unsmile + 규칙 폴백)",
    version="0.2.0",
    lifespan=lifespan,
)

# 크롬 익스텐션의 Origin 은 chrome-extension://<확장ID> 형태이고,
# 확장 ID 는 로드할 때마다 달라질 수 있어 개발 단계에서는 전체 허용한다.
# TODO: 배포 시에는 allow_origins 를 실제 확장 ID 로 좁힐 것.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    """익스텐션 사이드 패널의 '백엔드 연결 상태' 표시에 사용.

    mode 값이 패널에 그대로 노출된다:
      "kor_unsmile"          -> 모델 정상 동작
      "rule-based-fallback"  -> 모델 로딩 실패, 규칙으로만 판정 중
    """
    return {"status": "ok", "mode": current_mode()}


@app.post("/moderate", response_model=ModerateResponse)
async def moderate(req: ModerateRequest) -> ModerateResponse:
    """댓글 배치를 받아 유해성 판정 결과를 돌려준다.

    요청: {"comments": [{"id", "text"}, ...]}
    응답: {"results":  [{"id", "category", "severity", "reason"}, ...]}
    """
    results = await moderate_batch(req.comments)

    harmful = sum(1 for r in results if r.category is not None)
    logger.info("moderate: %d건 수신, %d건 유해 판정", len(req.comments), harmful)

    return ModerateResponse(results=results)
