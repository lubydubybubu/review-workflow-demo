# 계약 — `review-ops.extraction-input/v1`, `review-ops.extraction-output/v1`

JSON Schema 전체를 지원한다는 주장이 아니다. 아래 규칙을 `evalkit/contract.py`가 표준 라이브러리로 그대로 검사한다. 모든 진단은 `필드.경로: 메시지` 형식이며, 값은 강제 변환·잘라내기·기본값 채우기를 하지 않는다.

## 공통 규칙
- 모든 객체는 **정확한 키 집합**. 누락은 `경로: missing`, 추가 키는 `경로: unknown key`.
- 정수 오프셋은 `bool`을 정수로 인정하지 않는다(`true`, `1.0`, 음수, 문자열 거부).
- 날짜는 `YYYY-MM-DD`, 실제 존재하는 날짜, 2000–2999년. 시각 포함·슬래시·자리수 부족은 거부.
- id: `[a-z0-9][a-z0-9-]{0,63}`. 해시: 소문자 hex 64자.
- 문자열 상한: brand 120, product 200, reason 300, quote 300, notes 500, 근거 span 필드당 최대 5개, 원문 8000 바이트, replay case 최대 50, JSON 파일 1MB. 제어문자·bidi override 금지(notes만 탭/개행 허용). JSON 중복 키와 NaN/Infinity도 거부.

## 오프셋 규약
원문 파일의 **UTF-8 바이트 오프셋, 반열림 `[start, end)`**. `bytes[start:end]`를 엄격 UTF-8로 디코드한 결과가 `quote`와 정확히 같아야 한다. 범위가 파일 밖이거나 인용이 다르면 **검증 오류(전체 실행 실패)**. 파일 안이지만 문서 문맥 범위(본문) 밖이면 오류가 아니라 평가에서 `unsupported_evidence`.

## 입력 envelope (`build_input` / `validate_input`)
`contract`, `case_id`, `doc_id`, `source_sha256`, `source_text`, `context{start,end}`, `offset_unit = "utf8_byte_half_open"`, `source_text_is_untrusted_data = true`, `output_contract`. `source_text`의 SHA-256이 `source_sha256`과 같아야 하고 문맥 범위가 원문 안에 있어야 한다. 원문 속 지시문은 데이터일 뿐이다.

## 출력 envelope — 추출 제안 (승인 아님)
```
{ contract: "review-ops.extraction-output/v1",
  kind: "extraction_proposal",          // 다른 값 거부
  case_id, doc_id, source_sha256,       // case의 문서·고정 해시와 정확히 일치
  requires_human_approval: true,        // 불리언 true만 허용
  fields: { brand_name, product_name, source_type,
            deadlines: { write_by, publish, embargo, return_by } },
  notes: string|null }                  // 채점하지 않음
claim = { status: "value"|"unknown"|"abstain", value, reason, evidence: [ {start,end,quote} ] }
```
- `value`: 값 필수 + 근거 span 1개 이상. `source_type` 값은 `gift|loan|purchase`.
- `unknown`(원문에 없다고 판단) / `abstain`(판단 보류): `value`는 null, `reason`은 비어 있지 않은 문자열.
- 제안은 승인·리뷰 생성·상태 변경 효과가 없다. 승인은 기존 앱의 사람 결정 경로만 수행한다(이 저장소 범위 밖). `approved`, `action`, `confidence` 같은 키는 unknown key로 거부된다.

## 정답 파일 `review-ops.extraction-truth/v1`
문서(`doc_id`, 상대 `path`, `sha256`, `context`, `context_note`)와 case(`case_id`, `doc_id`, `fields`). 정답 claim은 `known`(값 + 근거 1개 이상) 또는 `unknown`(값 null + 이유). 모든 근거는 바이트 결합과 문맥 범위 안을 검사한다. 파일 해시 불일치·중복 id·알 수 없는 문서·`..`/절대 경로는 오류.

## 기존 `schema.ts`(mailCandidateSchema)와의 대응 — 런타임 어댑터는 만들지 않음
| v1 출력 | schema.ts | 비고 |
|---|---|---|
| `fields.brand_name` / `product_name` (status value) | `extracted.brand_name` / `product_name` | unknown/abstain → `null`. 이유(reason)는 손실 |
| `fields.source_type` | `extracted.source_type` (`MAIL_SOURCE_TYPES`) | unknown/abstain → `"unknown"`으로 보낼 수 있다고 **가정**. 실제 enum 값은 복사된 입력에 없어 미확인 |
| `fields.deadlines.*` | `extracted.deadlines.*` | 같은 YYYY-MM-DD, 2000–2999 규칙. unknown/abstain → `null` |
| `notes` | `extracted.notes` | 같은 500자 상한 |
| evidence span의 `quote` | `evidence[]` (최대 5줄, 줄당 300자) | 필드 연결·오프셋은 손실. 7필드 합계가 5줄을 넘을 수 있어 선택 규칙이 필요(미정) |
| (없음) | `confidence` (0–1, 필수) | **의도적으로 생략**. confidence를 정확도로 쓰지 않기 위함. 어댑터를 만든다면 별도 결정 필요 |
| (없음) | `source`, `message_id`, `thread_id`, `received_at`, `from_*`, `subject`, `snippet` | 메일 메타데이터는 producer 몫. 이 계약 범위 밖 |
| `kind`, `requires_human_approval`, `status`, `reason` | (없음) | 앱 쪽은 후보 저장 = pending이므로 별도 필드 불필요 |
