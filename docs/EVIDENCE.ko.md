# 증거 요약 — 이 패키지에서 실제로 실행한 것만

## 스크린샷을 만든 실행
`docs/screenshots/`의 7장은 패키지를 묶기 직전, 이 패키지와 같은 앱·producer·offline-eval·브라우저 스크립트 소스로 `demo/run_demo.py`를 한 번 실행해 얻은 PNG를 바이트 그대로 넣은 것입니다(2026-10-31, 로컬 Linux). 그 뒤 실행기에는 "사용 금지 포트"를 코드 상수 대신 `--forbid-port` 설정으로 받는 수정만 있었습니다.

| 항목 | 결과 |
|---|---|
| 실행기 검사 | 28/28 통과, exit 0 |
| 필수 스크린샷 | 7/7, 누락 0 |
| 브라우저 | Chrome 154.0.8037.57, 헤드리스, `chromiumSandbox: true`, 명령줄에 `--no-sandbox` 없음, Chrome 자체 sandbox 페이지: Namespace·Seccomp-BPF 활성("adequately sandboxed") |
| 네트워크 | 앱(127.0.0.1) 외 요청 차단 목록 0건 |
| 경계 | 수집 직후 리뷰·브랜드 0건, 승인 클릭 후 리뷰 1·브랜드 1, 후보 accepted·연결, 사람이 확인한 값과 일치 |
| 중복/미상 | 재전송 시 제목 변경 없음, 후속 메일 duplicate·기존 리뷰 연결·리뷰 1건 유지, 정보 없는 후보는 `없음`/`못 찾음` 그대로 pending |
| 수집 API 거절 | 잘못된 토큰 401, 잘못된 Host 401, 모르는 키(`approved`) 400 |
| offline-eval | replay exit 0, 테스트 74개 통과 |
| 앱 vitest | 단위 232개(16파일), 통합 164개(12파일, 실행기가 띄운 임시 PostgreSQL의 새 DB) 통과 |
| 정리 | 앱·PostgreSQL 프로세스 종료, 포트 닫힘, 임시 클러스터·비밀값·런타임 복사본 삭제, 패키지 파일 무변경 |

offline-eval 수치는 replay 자료와 평가기의 일관성 검사이며 모델 추출 정확도가 아닙니다.

## 정정: 의존성 폴더 쓰기
위 표의 실행에 쓴 이전 실행기는 런타임 `node_modules`를 미리 설치된 의존성 폴더 자체에 대한 링크로 만들었습니다. 그래서 앱 vitest가 기본 설정대로 만든 캐시(`.vitest-cache`의 변환 모듈, `.vite/vitest`의 결과 캐시)가 그 의존성 폴더에 기록되었고, 위 "정리" 행은 이를 확인하지 못했습니다. 그 기록은 되돌려지지 않았으며 이 패키지가 정리하지 않습니다.
현재 실행기는 런타임 `node_modules`를 출력 폴더 안의 실제 디렉터리(패키지별 링크)로 만들어 이런 캐시를 출력 폴더에 두고, 실행 전후 의존성 폴더 전체 항목을 비교하는 `dependency-dir-unchanged` 검사를 추가했습니다(검사 수가 하나 늘어남). 이 정정은 앱 소스와 화면을 바꾸지 않았으므로 스크린샷은 위 실행의 것을 그대로 둡니다. `tests/test_dependency_isolation.py`가 일회용 의존성 폴더로 이 경계를 검사합니다.

## 패키지에 들어 있는 재실행 가능한 검사
- `python3 -B -m unittest discover -s tests -t .` — fixture 근거(원문 해시·인용·미상 처리), 실행기 안전장치(출력 폴더·포트·도구 경로·환경 정리·Chrome 샌드박스), 증거 fail-closed(스크린샷 하나 누락·명시적 단언 하나 실패·원문 해시 불일치마다 실패), 내보내기 도구(정확한 파일 집합·바이트 동일·결정적 아카이브·거절 경로), producer와 offline-eval suite.
- `python3 -B demo/run_demo.py …` — 위 표의 전체 실행. 결과는 실행할 때마다 `--output-dir`의 `evidence.json`에 새로 기록됩니다.

## 정적 체험판(`web-demo/`) 검사
위 표는 원래 앱의 실행 결과이며 체험판과 무관합니다. 체험판에는 별도의 재실행 가능한 검사가 있습니다.
- `node --test tests/web-demo/state.test.mjs tests/web-demo/static.test.mjs` — 승인·중복 거절·후속 메일 중복 연결·무시·초기화 규칙, 결정성, CSP 문자열·HTML sink·네트워크 API·저장소·외부 주소 금지 검사.
- `python3 -B -m unittest discover -s tests -t .` 안의 `tests/test_export_pages.py` — Pages 내보내기가 `web-demo/` 파일과 `.nojekyll`만 만들고 비공개 보고서·앱·서버·env·fixture 경로를 거절함.
- `node tools/web_demo_browser_check.mjs …` — 샌드박스 켠 실제 Chrome으로 승인→리뷰·캘린더·대시보드 일치, 중복 거절, 무시·초기화, 키보드·모바일 탐색, CSP 차단, 같은 origin 정적 파일만 요청, 콘솔 오류 없음을 확인. 결과는 실행할 때마다 새 출력 폴더에 기록됩니다.

## 이 문서에 넣지 않은 것
- 이전 내부 단계의 테스트 수치(이 공개본에서 돌린 것이 아니므로).
- 실행 머신의 경로·계정·프로세스 번호 등 환경 정보.
