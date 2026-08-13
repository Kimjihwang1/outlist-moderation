# 유튜브 댓글 AI 유해 모더레이션

유튜브 댓글을 자동으로 읽어서 **욕설·혐오표현·성희롱·스팸을 찾아내고 흐릿하게 가려주는** 크롬 확장 프로그램입니다.

---

## 시작하기 전에 — 이것만 알면 됩니다

이 프로젝트는 **프로그램이 2개**입니다. 이게 가장 헷갈리는 부분이라 먼저 짚고 갑니다.

```
 [ 크롬 확장 ]  ──── "이 댓글 유해해?" ───→  [ 파이썬 서버 ]
   유튜브에서                                    AI가 판정해서
   댓글을 긁어와                                 답을 돌려줌
   흐리게 가림    ←──── "욕설, 91점" ─────
        ✋                                            🧠
```

| | 이름 | 하는 일 | 어디서 도나 |
|---|---|---|---|
| 🧠 | **백엔드** (`backend/`) | 댓글이 유해한지 판정 | 내 컴퓨터. 쓸 때마다 켜야 함 |
| ✋ | **확장** (`extension/`) | 유튜브에서 댓글 수집·블러 | 크롬. 한 번 등록하면 끝 |

**둘 다 켜져 있어야 작동합니다.** 서버가 꺼져 있으면 확장은 아무 일도 하지 않습니다
(페이지가 깨지지 않도록 조용히 넘어가는 fail-open 설계).

---

## 1단계 — 처음 한 번만 하는 설치

> 이미 설치를 마쳤다면 [2단계](#2단계--실행하기-매번-하는-것)로 건너뛰세요.

### 준비물

- **Python 3.13** — [python.org](https://www.python.org/downloads/)에서 설치.
  설치 화면에서 **`Add Python to PATH` 체크박스를 반드시 켜세요.**
- **Git** — [git-scm.com](https://git-scm.com/downloads)
- **크롬 브라우저**

### 설치 (PowerShell에 한 줄씩 붙여넣기)

윈도우 시작 메뉴에서 `PowerShell`을 검색해 실행한 뒤, 아래를 **한 줄씩** 복사해서 엔터를 누르세요.

```powershell
git clone https://github.com/Kimjihwang1/outlist-moderation.git
```
```powershell
cd outlist-moderation
```
```powershell
python -m venv .venv
```
```powershell
.\.venv\Scripts\Activate.ps1
```

여기까지 하면 프롬프트 맨 앞에 **`(.venv)`** 가 붙습니다. 이게 보여야 다음으로 넘어갑니다.

```
(.venv) PS C:\...\outlist-moderation>
 ^^^^^^ 이게 붙어야 정상
```

이어서 패키지를 설치합니다. **아래 두 줄은 순서를 지켜야 합니다.**

```powershell
pip install torch --index-url https://download.pytorch.org/whl/cpu
```
```powershell
pip install -r backend\requirements.txt
```

> ⚠️ **첫 줄을 건너뛰지 마세요.** 바로 `requirements.txt`를 설치하면 GPU용 torch(**약 2.5GB**)를
> 받습니다. 이 프로젝트는 GPU를 쓰지 않으므로 CPU용(**약 200MB**)이면 충분합니다.

<details>
<summary>맥 / 리눅스를 쓴다면</summary>

명령어 3개만 다릅니다. 나머지는 동일합니다.

```bash
python3 -m venv .venv
source .venv/bin/activate          # 윈도우의 .\.venv\Scripts\Activate.ps1 대신
pip install -r backend/requirements.txt    # 역슬래시(\)가 아니라 슬래시(/)
```

맥·리눅스에서는 `pip install torch`가 기본으로 CPU 버전을 받으므로,
`--index-url` 이 붙은 줄은 생략하고 그냥 `pip install torch` 하면 됩니다.
</details>

### 크롬 확장 등록

1. 크롬 주소창에 `chrome://extensions` 를 입력하고 엔터
2. **오른쪽 위**의 `개발자 모드` 스위치를 켭니다 (파랗게 변하면 켜진 것)
3. 그러면 **왼쪽 위**에 버튼들이 나타납니다 → `압축해제된 확장 프로그램을 로드합니다` 클릭
4. 폴더 선택창에서 방금 클론한 폴더 안의 **`extension` 폴더를 한 번만 클릭해 선택**하고 `폴더 선택`

> ⚠️ **여기서 가장 많이 틀립니다.** `extension` 폴더를 **더블클릭해 안으로 들어가면 안 됩니다.**
> 폴더를 한 번만 클릭해 파랗게 선택된 상태에서 확인을 눌러야 합니다.

목록에 `YouTube 댓글 유해 모더레이션` 카드가 생기면 성공입니다.

---

## 2단계 — 실행하기 (매번 하는 것)

### ① 서버 켜기

PowerShell을 열고 아래 4줄을 순서대로 칩니다.

```powershell
cd C:\경로\outlist-moderation
```
```powershell
.\.venv\Scripts\Activate.ps1
```
```powershell
cd backend
```
```powershell
uvicorn main:app --port 8000
```

> **`python main.py` 로는 켜지지 않습니다.** 아무 메시지 없이 그냥 끝나버립니다.
> `main.py`는 "이런 요청이 오면 이렇게 답해라"라고 적어둔 **설명서**일 뿐이고,
> 실제로 서버를 띄워 요청을 받아주는 프로그램은 `uvicorn` 입니다.
> `main:app` 의 구분자는 점(`.`)이 아니라 **콜론(`:`)** 입니다.

10초쯤 뒤 아래처럼 멈추면 **성공**입니다.

```
INFO:     Application startup complete.
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

> 💡 **멈춘 것처럼 보이는 게 정상입니다.** 요청을 기다리는 중이에요.
> **이 창을 끄면 서버도 함께 죽습니다.** 끄지 말고 최소화해 두세요. 종료는 `Ctrl+C`.

잘 켜졌는지 확인하려면 브라우저에서 <http://localhost:8000/health> 를 열어보세요.

```json
{"status":"ok","mode":"kor_unsmile"}          ← AI 모델 정상 동작
{"status":"ok","mode":"rule-based-fallback"}  ← 모델 로딩 실패, 키워드 규칙으로만 동작 중
```

> ⚠️ **맨 처음 실행할 때는 AI 모델(약 500MB)을 자동으로 내려받느라 몇 분 걸립니다.**
> 멈춘 게 아니니 기다려 주세요. 두 번째부터는 캐시를 쓰므로 10초면 켜집니다.

### ② 유튜브에서 쓰기

1. 유튜브에서 **댓글이 많은 영상**을 엽니다
2. **마우스 휠로 아래로 스크롤**해 댓글이 화면에 보이게 합니다
   - 유튜브는 스크롤을 해야 댓글을 불러옵니다. 스크롤하지 않으면 아무 일도 일어나지 않습니다
3. 유해 댓글이 **뿌옇게 흐려지고** 옆에 `[원문 보기]` 버튼이 붙습니다
4. 통계를 보려면 주소창 오른쪽의 **퍼즐 아이콘 🧩** → 이 확장 이름 클릭 →
   화면 오른쪽에 **사이드 패널**이 열립니다

**사이드 패널에서 할 수 있는 것**

- 수집된 댓글 수 / 유해 판정 수 / 유해 비율
- 카테고리별 집계 막대 그래프
- 블러 켜기·끄기
- 블러 임계값 슬라이더 (기본 50) — 바꾸면 이미 판정된 댓글에도 즉시 반영됩니다
- 백엔드 연결 상태 표시

---

## 잘 안 될 때

### 서버가 안 켜질 때

| 화면에 뜨는 메시지 | 원인 | 해결 |
|---|---|---|
| `uvicorn : 용어가 인식되지 않습니다` | `.venv` 활성화를 안 함 | 프롬프트에 `(.venv)`가 있는지 확인. 없으면 `.\.venv\Scripts\Activate.ps1` 부터 다시 |
| `Error loading ASGI app. Could not import module "main"` | `backend` 폴더 밖에 있음 | `cd backend` 하고 다시 |
| `이 시스템에서 스크립트를 실행할 수 없으므로` | 윈도우 스크립트 실행 차단 | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 실행 후 `Y` |
| `주소가 이미 사용 중` / `address already in use` | 서버가 이미 켜져 있음 | 그대로 쓰면 됩니다. 정리하려면 아래 참고 |
| `python : 용어가 인식되지 않습니다` | 파이썬 설치 시 PATH 미등록 | 파이썬을 다시 설치하며 `Add Python to PATH` 체크 |

<details>
<summary>8000번 포트가 안 풀릴 때</summary>

```powershell
Get-NetTCPConnection -LocalPort 8000 -State Listen
```

나온 `OwningProcess` 번호로 종료합니다.

```powershell
Stop-Process -Id <번호>
```
</details>

### 댓글이 안 흐려질 때

**확인 순서대로** 짚어보세요.

1. **사이드 패널에 "백엔드 꺼짐"이라고 뜨나요?** → 서버가 꺼진 것입니다. [①번](#-서버-켜기)을 다시 하세요
2. **댓글까지 스크롤했나요?** → 유튜브는 스크롤해야 댓글을 로드합니다
3. **확장을 방금 등록했나요?** → 유튜브 탭에서 `F5`로 새로고침해야 적용됩니다
4. **유해 댓글이 실제로 있나요?** → severity가 임계값(기본 50)을 넘어야 가려집니다.
   패널의 슬라이더를 낮춰 보세요
5. 그래도 안 되면 유튜브 페이지에서 `F12` → `Console` 탭을 확인하세요.
   `content.js`의 `DEBUG`가 켜져 있어 판정 과정이 로그로 찍힙니다

### 코드를 수정했을 때

| 무엇을 고쳤나 | 무엇을 해야 하나 |
|---|---|
| `backend/` 안의 `.py` | PowerShell에서 `Ctrl+C` → `uvicorn main:app --port 8000` 다시 |
| `extension/` 안의 파일 | `chrome://extensions`에서 새로고침 아이콘 클릭 → 유튜브 탭 `F5` |

> `uvicorn --reload` 옵션은 쓰지 마세요. 코드가 바뀔 때마다 AI 모델을 통째로 다시 로드해서
> 매우 느리고, 자식 프로세스가 남아 8000번 포트를 계속 점유합니다.

---

## 팀원과 함께 쓸 때

**`.venv` 폴더는 깃허브로 공유하지 않습니다.** `.gitignore`에 등록돼 있어 애초에 올라가지 않습니다.

```
   내 PC              팀원 A             팀원 B
 .venv (2GB)       .venv (2GB)       .venv (2GB)
      ↑                 ↑                 ↑
        각자 자기 컴퓨터에서 직접 만듦

                       ↑
          공유되는 건 requirements.txt 한 장
          ("이 버전들을 깔아라"고 적힌 목록)
```

이유는 두 가지입니다. 용량이 2GB에 달해 깃에 올릴 것이 못 되고, 윈도우에서 만든 `.venv`는
맥·리눅스에서 아예 동작하지 않습니다. 그래서 **팀원은 위 [1단계](#1단계--처음-한-번만-하는-설치)를
자기 컴퓨터에서 그대로 따라 하면 됩니다.**

> `.venv` 없이 전역에 설치해도 실행은 됩니다. 다만 이 프로젝트는 `torch==2.13.0`,
> `transformers==5.15.0` 처럼 버전이 고정돼 있어서, 다른 프로젝트에서 다른 버전을 쓰고 있었다면
> 그쪽이 덮어써져 망가집니다. `.venv`는 명령 두 줄로 이 사고를 막아 줍니다.

---

# 개발자용 문서

여기부터는 코드를 고칠 사람을 위한 내용입니다. 실행만 할 거라면 읽지 않아도 됩니다.

## 파일 구조

```
outlist-moderation/
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

## 판정 구조

판정은 **2단 구조**입니다.

| 담당 | 카테고리 | 방식 |
|---|---|---|
| 모델 [`smilegate-ai/kor_unsmile`](https://huggingface.co/smilegate-ai/kor_unsmile) | 욕설, 혐오표현 | 멀티라벨 분류(sigmoid) |
| 키워드 규칙 | 성희롱, 스팸 | 정규식 (모델에 해당 라벨이 없음) |

두 결과 중 **severity가 높은 쪽**을 최종 채택합니다. 모델 로딩에 실패하면 서버가 죽지 않고
규칙만 쓰는 폴백 모드(`rule-based-fallback`)로 자동 강등됩니다.

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

`backend/schemas.py`가 이 계약의 단일 출처입니다. 여기를 고치면 `extension/background.js`의
주석에 적힌 계약도 함께 맞춰야 합니다.

## API 직접 테스트

브라우저에서 <http://localhost:8000/docs> 를 열면 됩니다.
`POST /moderate` → `Try it out` → 아래를 붙여넣고 `Execute`.

```json
{ "comments": [{ "id": "1", "text": "이 병신아" }, { "id": "2", "text": "영상 잘 봤습니다" }] }
```

> PowerShell의 `curl`은 `Invoke-WebRequest`의 별칭이라 리눅스 `curl` 문법이 통하지 않고,
> 한글 응답도 깨져 보입니다. `/docs`를 쓰는 편이 확실합니다.

## 남은 TODO

- **성희롱 분류기** — 공개 데이터셋에 라벨이 없어 현재 키워드 규칙으로만 처리 중. 직접 라벨링 필요
- **severity 의 의미** — 지금은 모델의 '확신도'이지 '심각도'가 아님. 강도 라벨 데이터가 따로 필요
- 동일 텍스트 결과 캐싱 — `backend/moderation.py` (`content.js`에는 이미 텍스트 단위 캐시가 있음)
- 실패 배치 재시도(지수 백오프) — `extension/content.js`
- 배포 시 CORS `allow_origins` 를 실제 확장 ID로 좁히기 — `backend/main.py`
- 익스텐션 아이콘 리소스 추가 (`manifest.json` 의 `icons`)
- 배포 전 `content.js` 의 `DEBUG` 를 `false` 로

## 알려진 제약

- 유튜브 DOM 셀렉터(`ytd-comment-thread-renderer`, `#content-text`)에 의존하므로,
  유튜브가 마크업을 바꾸면 `content.js` 상단 상수를 수정해야 합니다.
- 유튜브는 스크롤 시 댓글 DOM 노드를 **재활용**합니다. 그래서 `content.js`는 요소가 아니라
  **본문 텍스트**를 신원의 기준으로 삼습니다. 이 파일을 고칠 때 반드시 유의하세요.
- 임계값 변경은 재판정 없이 저장된 severity 로만 다시 계산합니다(재요청 없음).

## ⚠️ 라이선스 주의

`kor_unsmile` 모델의 학습 데이터인 **Korean UnSmile Dataset은 CC-BY-NC-ND 4.0**(비영리 + 변형 금지)입니다.
모델 자체의 배포 조건은 별도로 확인이 필요하며, **상업적 이용 전에 반드시 스마일게이트에 문의해야 합니다**
(`smilegate_ai@smilegate.com`).
