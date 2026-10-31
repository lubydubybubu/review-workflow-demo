# 게시 절차 (release candidate) — 사람이 직접 하는 단계

이 문서는 게시 **후보**를 공개할 때의 절차입니다. 저장소에는 자동 배포 workflow가 없습니다. 아래의 저장소 이름과 주소는 **게시 예정** 값이며, 이 문서가 그 주소가 이미 운영 중이라는 뜻은 아닙니다.

- 소스 저장소(예정): `https://github.com/lubydubybubu/review-workflow-demo`
- 정적 체험판(예정): `https://lubydubybubu.github.io/review-workflow-demo/`
- 이 패키지는 소유자의 다른 공개 저장소(MIT 등)와 별개이며, 그 저장소의 라이선스가 이 패키지에 적용되지 않습니다([NOTICE.md](../NOTICE.md)).

## 1. 두 가지 내보내기
```
python3 -B tools/export_package.py --dest /tmp/rwd-source --archive /tmp/rwd-source.tar.gz
python3 -B tools/export_pages.py --dest /tmp/rwd-pages
```
- `main` 브랜치에는 소스 내보내기(`tools/PUBLIC_FILES.txt` 목록) 내용만 둡니다. CI는 테스트만 실행합니다.
- `gh-pages` 브랜치에는 Pages 내보내기 결과만 둡니다: `index.html`, `styles.css`, `state.js`, `app.js`, `icon.svg`, `.nojekyll`. 저장소 루트나 `app/`를 Pages로 게시하지 않습니다.
- 두 도구 모두 대상 폴더가 이미 있으면 아무것도 쓰지 않고 거절합니다.

## 2. gh-pages 브랜치 (예: 별도 작업 폴더에서)
1. 빈 orphan 브랜치 `gh-pages`를 만들고 Pages 내보내기 폴더의 파일 6개만 커밋합니다(다른 파일이 없는지 `git ls-files`로 확인).
2. 저장소 Settings → Pages → Source: "Deploy from a branch", Branch `gh-pages`, 폴더 `/ (root)`.
3. Actions 권한·secret은 추가하지 않습니다.

## 3. 기준 경로(base path)
프로젝트 Pages는 `/review-workflow-demo/` 아래에서 제공됩니다. 체험판은 모든 자원을 상대 경로(`styles.css`, `app.js` …)로 불러오므로 그 하위 경로에서 그대로 동작합니다. `tools/web_demo_browser_check.mjs`는 같은 하위 경로로 로컬 서버를 띄워 검사합니다. 사용자 도메인 루트로 옮겨도 상대 경로라 수정이 필요 없습니다.

## 4. 게시 후 확인 (사람이 브라우저나 `curl -I`로)
- `…/review-workflow-demo/` → 200, 상단에 "합성 데이터 체험판 · 서버 전송 없음 · 실제 운영 앱 아님".
- 다음은 모두 **404**여야 합니다: `…/review-workflow-demo/app/`, `…/server/`, `…/.env`, `…/fixtures/`, `…/reports/`, `…/tools/export_pages.py`, `…/app/package.json`, `…/.git/config`.
- 브라우저 개발자 도구 Network 탭: 같은 origin의 정적 파일 요청만 있고, Console에 CSP 오류가 없어야 합니다.

## 5. 되돌리기(rollback)
- 즉시 내리기: Settings → Pages에서 Source를 "None"으로 바꾸거나 `gh-pages` 브랜치를 삭제합니다.
- 이전 버전으로: `gh-pages`에서 직전 커밋으로 되돌린 커밋을 추가합니다(force push 대신 revert 권장).
- 이미 공개된 내용은 캐시·아카이브에 남을 수 있으므로, 게시 전에 내보내기 결과를 다시 확인합니다.

## 6. 하지 않는 것
- 원래 앱(Next.js + PostgreSQL)의 공개 배포. 원래 앱은 로컬 실행용입니다([SECURITY.md](../SECURITY.md)).
- 자동 배포 workflow, 배포용 secret, 분석 도구·외부 글꼴 추가.
