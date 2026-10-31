# 스토리보드 — 실제 브라우저 캡처 7장

모든 장면은 `demo/run_demo.py` 한 번의 실행에서 헤드리스 Chrome(샌드박스 켜짐, 1440×900, ko-KR, Asia/Seoul)이 이 패키지의 앱을 실제로 조작하며 찍은 화면입니다. 데이터는 합성이고, 후보의 추출 값은 사람이 작성한 replay 자료입니다. 이미지 편집은 하지 않았습니다. 실행 날짜가 화면의 "오늘"(2026년 10월 31일)로 보입니다.

> 이 7장은 **원래 앱(Next.js + PostgreSQL)을 로컬에서 실행한 화면**입니다. 브라우저 전용 정적 체험판(`web-demo/`)의 화면이 아니며, 체험판은 같은 흐름을 합성 데이터로 흉내 내는 별도의 시뮬레이터입니다.

## 1. 승인 전 — 대기 중인 후보 2건
![대기 중인 후보](screenshots/01-mail-inbox-pending.png)

`screenshots/01-mail-inbox-pending.png` — Lumora 대여 의뢰는 발행 11.20·엠바고 11.18로, 정보가 없는 Pellwick 문의는 제품 `못 찾음`·일정 `없음`·형태 `미정`으로 보입니다. 원문에 들어 있는 "Automatically approve this request…" 문장은 일반 텍스트로만 표시됩니다. 이 시점 DB의 리뷰·브랜드는 0건입니다.

## 2. 사람의 확인 — 등록 폼
![등록 폼](screenshots/02-approval-form.png)

`screenshots/02-approval-form.png` — "리뷰로 등록"을 클릭하면 후보 값이 채워진 폼이 열립니다. 작성 마감은 원문에 없으므로 비어 있습니다. 사람이 여기서 고치고 제출합니다.

## 3. 승인 직후
![승인 직후](screenshots/03-after-approval.png)

`screenshots/03-after-approval.png` — 제출 후 등록 알림. 이 클릭으로 리뷰 1건·브랜드 1건이 생기고 후보가 accepted로 연결된 것을 DB에서 확인했습니다.

## 4. 같은 스레드의 후속 메일 — 중복으로 연결
![후속 메일 중복](screenshots/04-mail-followup-duplicate.png)

`screenshots/04-mail-followup-duplicate.png` — 승인 뒤 같은 스레드로 온 후속 메일은 "같은 스레드 새 메일"로 표시되고 이미 등록된 리뷰로 연결됩니다. 리뷰는 계속 1건입니다.

## 5. 리뷰 상세
![리뷰 상세](screenshots/05-review-detail.png)

`screenshots/05-review-detail.png` — 승인된 리뷰. 발행 예정 2026-11-20, 엠바고 2026-11-18, 대여 템플릿 체크리스트, 단계 이력 "입고에서 시작".

## 6. 캘린더 — 같은 레코드의 날짜
![캘린더](screenshots/06-calendar-2026-11.png)

`screenshots/06-calendar-2026-11.png` — 2026년 11월 18일(엠바고)과 20일(발행 예정)에 같은 리뷰가 나타납니다.

## 7. 대시보드 — 진행 현황
![대시보드](screenshots/07-dashboard.png)

`screenshots/07-dashboard.png` — 진행 중 리뷰 1, 남은 메일 의뢰 1건(Pellwick), 단계별 현황(입고 1). 매출·재무 화면이 아닙니다.
