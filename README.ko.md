# Review Workflow — 데모 패키지 (공개 후보 · release candidate)

제품 리뷰 의뢰를 **후보**로 받아, 사람이 실제 웹 화면에서 확인·승인한 것만 리뷰 업무가 되고, 승인된 리뷰가 리뷰 상세·캘린더·대시보드에 나타나는 흐름을 보여주는 내부 업무 도구 사례입니다. 사례 설명은 [CASE-STUDY.ko.md](CASE-STUDY.ko.md)에 있습니다.

## 두 가지를 구분해 주세요
| | 무엇 | 쓰는 법 |
|---|---|---|
| **정적 체험판** [`web-demo/`](web-demo/index.html) | 브라우저 안에서만 도는 시뮬레이터. 합성 데이터가 내장되어 있고 승인·무시·초기화는 탭 메모리만 바꿉니다. 조작·입력 상태를 서버로 보내지 않습니다. **실제 운영 앱이 아니고 백엔드와 연결되지 않습니다.** | 정적 파일 서버로 `web-demo/index.html`을 열거나, 게시된 뒤의 GitHub Pages 주소(게시 예정, 아직 운영 중 아님): `https://lubydubybubu.github.io/review-workflow-demo/` |
| **소스 + 로컬 백엔드** (`app/` 등) | 실제 Next.js + PostgreSQL 앱과 도구. [스토리보드](docs/STORYBOARD.ko.md)의 스크린샷은 이 앱을 로컬에서 실행한 화면이며 체험판 화면이 아닙니다. | 소스를 내려받아 각자 로컬에서 실행(아래 2절) |

- 보안·위협 모델: [SECURITY.md](SECURITY.md) · 게시 절차: [docs/PUBLISHING.ko.md](docs/PUBLISHING.ko.md)
- 공개 예정 저장소: `https://github.com/lubydubybubu/review-workflow-demo` (게시 후보이며 게시 여부는 저장소에서 확인)
- 아무 보증 없이 있는 그대로 제공합니다. 원래 앱은 로컬 평가용이며 인터넷에 노출하지 마세요.
- 역할: 요구사항·설계·안전 경계·작업 조율·수락 결정은 소유자가, 구현은 AI 코딩 도구가 했고 별도의 독립 검토를 거쳤습니다.

- 입력 메일과 사람·회사·제품은 모두 **합성**입니다.
- "추출 결과" JSON은 사람이 작성한 **replay 자료**이며 LLM 출력이나 모델 정확도가 아닙니다.
- 화면은 이 패키지의 실제 앱을 로컬에서 실행해 헤드리스 Chrome(샌드박스 켜짐)으로 새로 찍은 것입니다: [docs/STORYBOARD.ko.md](docs/STORYBOARD.ko.md)
- 이 패키지에서 실제로 돌린 검사 범위: [docs/EVIDENCE.ko.md](docs/EVIDENCE.ko.md)

## 범위와 한계 (먼저 읽어 주세요)
- 검증은 **Linux 한 대의 로컬 환경**(loopback PostgreSQL, Chrome 154)에서만 했습니다. 다른 OS·브라우저는 확인하지 않았습니다.
- 실제 메일 수신, 실제 LLM 추출, 모델 품질·비용 평가는 하지 않았습니다.
- 계정별 권한(RBAC)은 [설계 문서](docs/ACCOUNT-ROLES-DESIGN.ko.md)만 있고 구현되지 않았습니다. 재무/매출 기능은 없습니다. 외부 클라우드 배포는 확인하지 않았습니다.
- 원래 앱은 어디에도 배포되어 있지 않습니다(로컬 실행용). 공개 대상은 소스와 정적 체험판뿐이며, 현재는 게시 **후보** 단계입니다. 의존성은 포함하지 않으며(아래 참고), 오프라인 설치를 보장하지 않습니다.
- 라이선스 범위: [NOTICE.md](NOTICE.md)

## 구성
| 경로 | 내용 |
|---|---|
| `app/` | Next.js + PostgreSQL 업무 앱(리뷰·보드·캘린더·할 일·메일 의뢰 후보·승인 트랜잭션), 마이그레이션, vitest 단위/통합 테스트 |
| `producer/` | 후보를 앱의 수집 API로 보내는 표준 라이브러리 Python 스크립트와 테스트 |
| `offline-eval/` | 합성 원문·정답·replay 자료와 오프라인 평가기(모델 호출 없음)와 테스트 |
| `demo/` | 실행 스크립트 `run_demo.py`, 실제 브라우저 클릭 `browser_walkthrough.mjs`, DB 조회 도구, 합성 후보 fixture |
| `tests/` | 패키지 검사(fixture 근거·실행기 안전장치·증거 fail-closed·내보내기 도구·번들 suite) |
| `tools/` | 고정 허용목록 내보내기 도구 `export_package.py`·`PUBLIC_FILES.txt`, Pages 전용 `export_pages.py`·`PAGES_FILES.txt`, 체험판 실제 브라우저 검사 `web_demo_browser_check.mjs` |
| `web-demo/` | 정적 체험판(HTML/CSS/JS, 빌드·의존성 없음) |
| `docs/` | 스토리보드, 증거 요약, 권한 설계안, 게시 절차, 스크린샷 7장(원래 앱의 로컬 실행 화면) |
| `.github/workflows/ci.yml` | 테스트만 실행하는 CI(읽기 권한, secret·배포 없음) |

## 1. 의존성 없이 돌리는 검사
Python 3(표준 라이브러리)만 필요합니다. 패키지 루트에서:

```
python3 -B -m unittest discover -s tests -t .
```

producer·offline-eval suite도 이 안에서 하위 프로세스로 실행됩니다. 패키지 안에 파일을 쓰지 않습니다(임시 파일은 시스템 임시 폴더).

정적 체험판 검사는 Node.js 내장 테스트 실행기만 씁니다(설치 필요 없음):

```
node --test tests/web-demo/state.test.mjs tests/web-demo/static.test.mjs
```

실제 Chrome으로 체험판을 조작하는 검사(선택, `playwright-core`가 이미 설치된 경로와 Chrome 필요, 샌드박스 켜짐, 127.0.0.1 임시 포트):

```
node tools/web_demo_browser_check.mjs --playwright-core /path/to/node_modules/playwright-core \
  --chrome /path/to/chrome --out /tmp/rwd-browser-1 [--site-dir <Pages 내보내기 폴더>]
```
결과는 새 출력 폴더의 `result.json`과 `screenshots/`에만 씁니다.

## 2. 전체 데모 실행 (로컬 Linux)
필요한 것(포함되어 있지 않음, 직접 준비):
- Node.js(검증에 쓴 버전 26.7), `app/package-lock.json` 기준으로 **미리 설치된** `node_modules` 디렉터리(`next`, `playwright-core`, `pg`, `tsx`, `vitest` 포함)
- PostgreSQL 서버 바이너리(`initdb`, `pg_ctl`이 있는 bin 디렉터리)
- Google Chrome 실행 파일(샌드박스가 동작하는 환경)
- 선택: Pretendard(OFL) `pretendard.css`와 `pretendard/*.woff2`가 있는 폴더 — 한글 글꼴용. 없으면 시스템 글꼴을 씁니다.

```
python3 -B demo/run_demo.py --output-dir /tmp/rwd-run-1 \
  --node /path/to/node --node-modules /path/to/node_modules \
  --pg-bin /path/to/postgresql/bin --chrome /path/to/chrome \
  [--font-dir /path/to/fonts] [--tmp-root /tmp] [--app-port 55885] [--pg-port 55485] \
  [--forbid-port <다른 서비스용 포트> ...]
```

같은 값을 환경변수 `RWD_NODE`, `RWD_NODE_MODULES`, `RWD_PG_BIN`, `RWD_CHROME`, `RWD_FONT_DIR`, `RWD_TMP_ROOT`로 줄 수도 있습니다. 경로가 하나라도 없으면 아무것도 시작하지 않고 거절합니다.

실행기가 쓰는 곳은 `--output-dir`(이미 있으면 거절, 패키지 안이면 거절)과, Chrome·tsx 소켓 경로 길이 제한 때문에 `--tmp-root`(없으면 시스템 임시 폴더) 아래에 만드는 짧은 `rwd-*` 임시 폴더(종료 시 삭제)뿐입니다. 패키지와 `--node-modules`는 읽기만 합니다. 런타임 앱의 `node_modules`는 출력 폴더 안의 실제 디렉터리이고 그 안에 패키지별 링크만 두므로, Vite/Vitest가 `node_modules` 바로 아래에 만드는 캐시(`.vite`, `.vite-temp`, `.vitest-cache`)는 출력 폴더 안에 생겼다가 런타임 복사본과 함께 삭제됩니다. 실행 전후로 `--node-modules`의 모든 항목(경로·링크 대상·크기·수정 시각)을 비교해 하나라도 달라지면 실패로 처리합니다. 하는 일: 앱 복사본 빌드, 127.0.0.1 전용 임시 PostgreSQL, `next start`, producer 전송, 실제 Chrome 로그인·승인 클릭·스크린샷, offline-eval과 앱 vitest(단위+통합) 실행, 그리고 모든 자식 프로세스 종료·클러스터·비밀값 삭제·패키지 무변경 확인까지 합니다. 결과는 `evidence.json`, `logs/`, `screenshots/`이며 모든 검사가 통과하고 필수 스크린샷 7장이 모두 있을 때만 exit 0입니다. 사용 중인 포트는 건드리지 않고 거절합니다.

## 3. 공개본 내보내기
```
python3 -B tools/export_package.py --dest /tmp/review-workflow-demo --archive /tmp/review-workflow-demo.tar.gz
```
`tools/PUBLIC_FILES.txt`에 적힌 파일만 복사하고 바이트 비교합니다. 대상이 이미 있거나, 목록의 파일이 없거나 심볼릭 링크이거나, 의존성·빌드·로그·비밀값 경로이면 아무것도 쓰지 않고 거절합니다. `.github/` 아래는 테스트용 `.github/workflows/ci.yml` 한 파일만 예외로 허용합니다.

정적 체험판만 따로 내보내기(GitHub Pages용):
```
python3 -B tools/export_pages.py --dest /tmp/review-workflow-pages
```
`tools/PAGES_FILES.txt`의 `web-demo/` 파일과 빈 `.nojekyll`만 만듭니다. 게시 절차·확인·되돌리기는 [docs/PUBLISHING.ko.md](docs/PUBLISHING.ko.md)에 있습니다.
