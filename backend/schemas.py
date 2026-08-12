"""
schemas.py
----------
프론트(크롬 익스텐션) <-> 백엔드 사이의 **데이터 계약(Data Contract)** 정의.

이 파일이 계약의 단일 출처(single source of truth)다.
요청/응답 형태를 바꿔야 한다면 반드시 여기부터 수정하고,
extension/background.js 의 주석에 적힌 계약도 함께 맞춰줄 것.

요청:  {"comments": [{"id": "c1", "text": "..."} , ...]}
응답:  {"results":  [{"id": "c1", "category": "욕설", "severity": 82, "reason": "..."} , ...]}
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

# 유해 카테고리. 실제 탐지 API를 붙일 때도 이 4종으로 매핑해서 반환할 것.
Category = Literal["욕설", "혐오표현", "성희롱", "스팸"]


class CommentIn(BaseModel):
    """판정 대상 댓글 1건 (익스텐션이 유튜브 DOM에서 수집한 것)."""

    id: str = Field(..., description="익스텐션이 부여한 댓글 고유 ID (탭 내에서 유일)")
    text: str = Field(..., description="댓글 원문 텍스트")


class ModerateRequest(BaseModel):
    """POST /moderate 요청 본문."""

    comments: list[CommentIn] = Field(default_factory=list)


class ModerationResult(BaseModel):
    """판정 결과 1건.

    category 가 None 이면 '정상 댓글'을 의미한다(이때 severity 는 0).
    유해로 판정된 경우에만 Category 4종 중 하나가 들어간다.
    -> 결과를 아예 누락시키면 클라이언트가 '정상'과 '아직 판정 안 됨'을
       구분할 수 없기 때문에, 정상 댓글도 반드시 결과에 포함시킨다.
    """

    id: str
    category: Optional[Category] = Field(None, description="유해 카테고리. 정상이면 null")
    severity: int = Field(0, ge=0, le=100, description="유해도 0~100")
    reason: str = Field("", description="판정 근거 (사용자에게 노출될 수 있는 짧은 설명)")


class ModerateResponse(BaseModel):
    """POST /moderate 응답 본문."""

    results: list[ModerationResult] = Field(default_factory=list)
