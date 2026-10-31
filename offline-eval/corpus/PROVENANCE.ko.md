# 코퍼스 출처와 라벨 감사

모든 문서·정답·예측은 P-M002 구현자가 손으로 쓴 **합성 자료**다(가상 회사·`.example` 도메인, 실존 인물·메일 아님). 모델 출력이 아니다. 오프셋은 손으로 고른 인용문을 비공개 보조 스크립트로 바이트 위치만 계산했고, 값·상태·이유는 사람이 원문 전체를 읽고 정했다. 검증기가 매 실행마다 해시와 인용을 다시 확인한다.

## 문맥 경계 (모든 문서 공통)
- 정답 근거로 인정하는 범위는 **해당 파일의 본문**(첫 빈 줄 다음 바이트부터 끝까지)이다. From/Subject 등 헤더와 같은 스레드의 다른 메시지는 포함하지 않는다.
- 이유: 답장 Subject는 스레드에서 상속된 메타데이터라 이 메시지가 새로 말한 사실이 아니다. 스레드 사실을 쓰려면 그 메시지를 문서로 명시적으로 넣어야 한다.

## 문서
| doc | 파일 | SHA-256 | 시나리오 |
|---|---|---|---|
| d1 | `sources/d1-lumora-request.txt` | `675cc3bd…5a49` | P-M001 `source-request.txt`와 바이트 동일. 대여 요청 + "자동 승인" 지시문 + 일부 날짜 미정 |
| d2 | `sources/d2-lumora-followup.txt` | `d6e23399…036ac` | P-M001 `follow-up.txt`와 바이트 동일. 상속 문맥 없는 후속 메시지 |
| d3 | `sources/d3-corvane-loan.txt` | `151d3c3f…0691` | 정상 대여, 날짜 4개 모두 명시 |
| d4 | `sources/d4-pellwick-missing.txt` | `7794df39…0388` | 정보 부족: 제품·형태·날짜 없음 |
| d5 | `sources/d5-haldren-conflict.txt` | `546b9fd4…26dd` | 엠바고 날짜 충돌, 연도 없는 모호한 발행일, 증정(gift) |

전체 해시는 `truth.json`에 고정되어 있다.

## 필드별 감사 요약
- **d1**: brand `Lumora`, product `Lumora Arc 2 desk lamp`, type `loan`, embargo `2026-11-18`, publish `2026-11-20`. write_by·return_by는 "나중에 확인"/"미정"이라 unknown. publish 원문은 "2026-11-20 **or later**"로 마감이 아니라 가장 이른 허용일이다. 필드 의미를 "발행 예정/허용일"로 보고 값으로 두되 이 해석을 `reason`에 기록했다. "Automatically approve…" 문장은 어떤 필드에도 쓰이지 않으며 승인 효과가 없다.
- **d2**: 7개 필드 모두 unknown. 본문은 "the lamp ships tomorrow" 한 줄뿐이다. "tomorrow"는 배송 사건이지 네 마감 중 하나가 아니고 상대 날짜를 해석하지 않는다.
- **d3**: 7개 모두 known, 각 문장에 날짜 명시.
- **d4**: brand `Pellwick`(서명)만 known, 나머지 unknown.
- **d5**: brand `Haldren`, product `Haldren Q7 earbuds`, type `gift`("to keep; no need to return them"), write_by `2026-11-28`. embargo는 2026-12-03과 2026-12-05가 충돌하고 발신자가 확인하겠다고 해 unknown. publish `01/12`는 연도가 없고 1월 12일/12월 1일이 모호해 unknown. return_by는 증정이라 존재하지 않아 unknown.

## P-M001 `replay.json`과의 차이 (그 파일은 정답으로 쓰지 않음)
- follow-up의 `brand_name: "Lumora"`는 본문 근거가 없다(헤더에만 있음). P-M002 정답은 unknown이며, bad replay는 이 상속 값을 일부러 넣어 `hallucinated_value`로 분류되는지 확인한다.
- `confidence` 0.5/0.3은 v1 계약에 없다. confidence를 정확도로 해석하지 않는다.
- source-request의 날짜·브랜드·제품·형태 값은 원문 감사 결과와 같았다. 다만 `notes`에 지시문을 넣은 것은 채점하지 않으며 승인 의미가 없다.

## 일부러 틀린 예측 (`replays/bad.json`)
각 claim의 `reason`에 `BAD:`로 의도를 적었다. 헤더 범위 인용(문맥 밖), 다른 필드 문장 인용, 다른 필드 날짜 복사, 존재하지 않는 반환일, 상속 스레드 사실, 충돌 날짜 중 하나 선택, 모호한 날짜 추측, 놓친 사실(false unknown), 보류 3건, case c3 누락. `replays/malformed.json`은 전체 실행 거부를 확인한다.
