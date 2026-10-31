# P-M002 — AI 입력/출력 계약과 오프라인 replay 평가 자료

Review Ops의 "메일 → 후보 → 사람 승인" 흐름 중 **AI 추출이 들어갈 자리의 계약**과, 그 출력을 정답과 비교하는 **작은 오프라인 평가기**다. 모든 원문·정답·예측은 사람이 손으로 쓴 합성 자료이며, 이 저장소에는 **실제 추출기나 모델 호출이 없다.**

## 실행 (이 디렉터리에서, Python 3 표준 라이브러리만)
- 테스트: `/usr/bin/python3 -m unittest discover -s tests -t .`
- replay: `/usr/bin/python3 replay.py`
  - 한 세트만: `/usr/bin/python3 replay.py --predictions corpus/replays/bad.json`
  - exit 0 = 기대값 모두 일치, 1 = 기대값 불일치, 2 = 입력 오류(진단은 stderr, 부분 보고 없음)
- 네트워크·DB·백그라운드 프로세스·설치가 필요 없다. 출력에 시각(timestamp)이 없고 순서가 고정되어 있어 같은 입력이면 바이트가 같다.

## 구성
| 경로 | 내용 |
|---|---|
| `CONTRACT.ko.md` | 입력/출력 envelope 계약, 검증 규칙, 기존 `schema.ts`와의 대응·누락 |
| `corpus/PROVENANCE.ko.md` | 문서 5건의 출처, 문맥 경계, 필드별 라벨 감사 |
| `corpus/sources/*.txt` | 합성 원문 5건 (d1, d2는 P-M001 원문과 바이트 동일) |
| `corpus/truth.json` | 7개 필드 정답 + 근거 범위(UTF-8 바이트 오프셋, 반열림) |
| `corpus/replays/*.json` | 손으로 쓴 예측: `positive`, `deliberately-bad`, `malformed` |
| `corpus/expected.json` | 각 replay 세트의 기대 결과 |
| `evalkit/contract.py` | 엄격 검증기 (키·타입·크기·날짜·해시·인용 결합) |
| `evalkit/evaluate.py` | 필드 분류와 보고서 생성 |
| `replay.py` | 오프라인 CLI |

## 평가 분류 (필드 하나당 정확히 하나)
`correct`, `valid_unknown`, `abstained`, `false_unknown`, `wrong_value`, `hallucinated_value`, `unsupported_evidence`, `missing_prediction`.
- 분모는 항상 `정답 case 수 × 7`. 예측이 빠진 case는 7칸 모두 `missing_prediction`으로 남는다. 정답에 없는 case(extra)나 중복 case는 오류로 전체 실행을 실패시킨다.
- `unknown`(원문에 없다고 주장)과 `abstain`(판단 보류)은 다른 상태다. 정답이 unknown인데 날짜를 내면 오류로 센다. 추측한 날짜는 정답이 될 수 없다.
- 값이 틀리면 인용이 아무리 정확해도 `correct`가 될 수 없다. 값이 맞아도 인용이 문맥 범위 밖이거나 같은 필드의 정답 근거 범위와 겹치지 않으면 `unsupported_evidence`.
- 근거 범위 충족(coverage): 값이 맞고 모든 인용이 위 조건을 통과해도, 인용 span들의 바이트 합집합이 같은 필드의 정답 근거 span **각각**을 덮어야 `correct`다. 정답 span 하나를 덮는다는 것은 (a) 그 span의 모든 바이트, 또는 (b) 그 span 안에 글자 그대로 있는 정답 값의 바이트 전체를 덮는 것이다. 정답 문장 `Please publish on 2032-03-06.`에서 `Please`만 인용하면 둘 다 아니므로 `unsupported_evidence`. 인접 span 여러 개로 나눠 덮어도 되고, 정답 span보다 넓은 인용(문맥 안)은 감점하지 않는다. 정답 span이 여러 개면 모두 덮어야 한다.

## 현재 replay 결과 (합성 fixture 점검값, 모델 오류율 아님)
- `positive`: correct 17, valid_unknown 18 (35칸)
- `deliberately-bad`: correct 4, valid_unknown 10, abstained 3, false_unknown 1, wrong_value 2, hallucinated_value 5, unsupported_evidence 3, missing_prediction 7 (35칸)
- `malformed`: 거부 — 진단 5건 (unknown key `approved`, `requires_human_approval: 1`, 불리언 오프셋, 존재하지 않는 날짜, extra case)
- accuracy / model_quality / cost / latency: **모두 `null`, UNMEASURED.** 위 숫자는 일부러 만든 예측이 의도대로 분류되는지 확인한 값이다.

## 범위와 한계
- 실제 메일 수집, LLM/추출기, 모델 품질 측정, HTTP 어댑터, 운영 route/인증/DB 변경은 **없다.** `schema.ts`는 읽기 전용 참고다.
- "자동 승인하라"는 원문 문장(d1)은 데이터일 뿐이다. 출력 계약은 `kind: extraction_proposal`, `requires_human_approval: true`만 허용하고 `approved` 같은 키는 거부한다. 평가기는 승인 기능 자체가 없다(`approvals_performed: 0`). 이는 승인 경계를 계약으로 고정한 것이지 모델의 지시 무시 능력을 측정한 것이 아니다.
- 근거 판정은 유한한 정답 근거 범위에만 의존한다. 정답이 나열하지 않은 다른 올바른 문장을 인용하면 `unsupported_evidence`로 센다(보수적).
- coverage는 바이트 검사일 뿐 의미 함의(entailment) 판정이 아니다. (b) 값 바이트 규칙 때문에 `2026-11-20`만 인용해도 `... on 2026-11-20 or later.`의 정답을 덮은 것으로 보며, `or later` 같은 수식어 누락은 잡지 못한다. 반대로 정답 span 전체를 포함하는 넓은 인용도 그대로 `correct`다. 정답 span 선정이 곧 근거 기준이므로 정답 작성 품질에 의존한다.
- `hallucinated_value` vs `wrong_value` 구분은 "예측 값 문자열이 문맥 범위에 글자 그대로 있는가"라는 단순 규칙이다. 형식만 바꾼 날짜(예: `01/12` → `2026-12-01`)도 hallucinated로 분류된다.
- 값 비교는 정확한 문자열 일치다(대소문자·별칭 정규화 없음).
- 문서 5건, case 5건의 작은 자료이며 통계적 의미가 없다.
