// Static product guidance only: never render arbitrary adapter/source messages.
const entries={
 WORKFLOW_HEALTH_IDENTITY_CONFLICT:['같은 출처와 기록 ID에 서로 다른 측정 내용이 있습니다.','원본의 수정 버전과 출처를 확인해 사용할 기록을 정해 주세요. 값을 임의로 합치거나 선택하지 않았습니다.'],
 WORKFLOW_HEALTH_RECORD_INVALID:['건강 기록의 날짜·시각·단위 또는 보정 조건을 확인해야 합니다.','명시적 시간대, 올바른 날짜와 지원하는 단위를 준비해 주세요. 미래 측정값이나 모순된 보정 정보는 사용하지 않습니다.'],
 WORKFLOW_ASSERT_COUNT_FAILED:['대상 개수가 요청 조건과 달라 작업을 멈췄습니다.','파일 탐색이라면 같은 이름의 파일이 여러 개이거나 없을 수 있습니다. 대상 이름과 검색 폴더를 확인해 범위를 지정해 주세요.'],
 WORKFLOW_CHANGE_DURATION_UNIT_REQUIRED:['처리속도 계산에 필요한 시간 단위가 아닙니다.','전후 소요시간을 같은 시간 단위로 지정해 주세요. 같은 작업량인지도 별도로 확인해야 합니다.'],
 NATURAL_WORKFLOW_CHANGE_METRIC_REQUIRED:['비교 기준이 모호해 계산하지 않았습니다.','값의 증가율·감소율 또는 소요시간으로 계산한 처리속도 증가율 중 원하는 기준을 알려 주세요.'],
 WORKFLOW_CHANGE_UNIT_MISMATCH:['비교할 값의 단위가 서로 맞지 않습니다.','전후 값을 같은 단위로 준비하고 주장 비율은 %로 지정해 주세요. 단위를 임의로 바꾸지 않습니다.'],
 WORKFLOW_CHANGE_POSITIVE_VALUES_REQUIRED:['비율 계산의 기준값은 양수이고 변경값은 음수가 아니어야 합니다.','기준값이 0이거나 변경값이 음수인지 확인해 주세요. 값을 임의로 보정하지 않습니다.'],
 WORKFLOW_CHANGE_ZERO_BASE:['0으로 나눠야 하는 비율은 계산할 수 없습니다.','소요시간 기준 처리속도 비교에는 변경 소요시간도 0보다 커야 합니다. 시간 감소율과 처리속도 증가율을 구분해 주세요.'],
 WORKFLOW_CHANGE_PROVENANCE_REQUIRED:['비교할 값의 출처와 단위를 확인하지 못했습니다.','원문에서 전후 값과 주장자를 단위와 함께 추출해 주세요. 출처가 빠진 값을 확인된 사실로 쓰지 않습니다.'],
 WORKFLOW_CHANGE_NUMBER_INVALID:['비교 값의 숫자 형식을 읽을 수 없습니다.','단위·쉼표·지수 표기를 제외한 숫자 문자열을 사용해 주세요. 큰 숫자를 부정확한 값으로 바꾸지 않습니다.'],
 WORKFLOW_CHANGE_TOLERANCE_INVALID:['허용오차가 지원 범위를 벗어났습니다.','허용할 차이를 0~100 퍼센트포인트 사이로 지정해 주세요.'],
 WORKFLOW_CHANGE_METRIC_REQUIRED:['비율 계산의 기준을 확인하지 못했습니다.','값 증가율·값 감소율 또는 소요시간 기준 처리속도 증가율을 지정해 주세요.'],
 A_SOURCE_FIELDS_CORRECTION_CONFLICT:['정정 이력의 이전 값이 앞선 기록과 맞지 않아 멈췄습니다.','원문에서 최초 값과 각 정정의 이전 값을 확인해 주세요. 확인되지 않은 값으로 이어서 실행하지 않습니다.'],
 A_SOURCE_FIELDS_AMBIGUOUS:['같은 항목에 여러 값이 있어 하나로 확정할 수 없습니다.','사용할 기록을 지정하거나 이전 값과 새 값이 연결된 정정 이력을 제공해 주세요.'],
 A_SOURCE_FIELDS_NOT_EXPLICIT:['요청한 항목의 확정값을 원문에서 확인하지 못했습니다.','항목 이름·단위·확정 여부를 확인해 주세요. 인용·조건·타인의 주장만으로 값을 확정하지 않습니다.'],
 A_SOURCE_FIELDS_FORMAT_MISMATCH:['요청한 값 형식과 원문 추출 조건이 맞지 않습니다.','숫자·상태·날짜 중 필요한 형식과 항목을 확인해 주세요.'],
 A_SOURCE_FIELDS_INVALID:['이 항목의 추출 조건을 지원하지 않습니다.','항목 이름과 단위를 명시해 주세요. 지원하지 않는 조건을 생략해서 실행하지 않습니다.'],
 A_SOURCE_FIELDS_INCOMPLETE:['일부 항목에 추출 조건이 빠져 있어 멈췄습니다.','각 항목의 이름과 필요한 값 형식을 확인해 주세요.'],
 A_SOURCE_FIELDS_EVIDENCE_LIMIT:['정정 이력이 길어 현재 방식으로 근거 전체를 보존할 수 없습니다.','필요한 기록 범위를 지정해 주세요. 이전 정정의 연결을 확인하지 않고 마지막 값만 선택하지 않습니다.'],
 A_SOURCE_SUMMARY_LITERAL_INVALID:['추출 결과와 원문 근거를 함께 확인하지 못했습니다.','원문 항목과 정정 기록을 확인해 주세요. 미검증 결과는 저장하지 않습니다.'],
 WORKFLOW_TEXT_ENCODING_INVALID:['파일의 문자 인코딩을 읽을 수 없어 멈췄습니다.','파일을 올바른 UTF-8 텍스트로 저장하거나 지원하는 형식으로 변환해 주세요. 손상된 글자를 임의로 바꾸지 않습니다.']
};
const english={
 WORKFLOW_HEALTH_IDENTITY_CONFLICT:['The same source and record ID contain conflicting measurements.','Check the original version and origin and select the intended record. Conflicting values were not merged or guessed.'],
 WORKFLOW_HEALTH_RECORD_INVALID:['The health record date, timestamp, unit or calibration conditions need attention.','Provide an explicit timezone, valid date and supported unit. Future measurements or contradictory calibration metadata are not used.'],
 WORKFLOW_ASSERT_COUNT_FAILED:['The number of targets does not match the requested condition.','For file discovery, the name may match multiple files or none. Check the name and search folder and narrow the scope.'],
 WORKFLOW_CHANGE_DURATION_UNIT_REQUIRED:['Throughput calculation requires a duration unit.','Use the same duration unit for both values. Equal workload must be checked separately.'],
 NATURAL_WORKFLOW_CHANGE_METRIC_REQUIRED:['The comparison metric is ambiguous.','Choose value increase, value decrease, or throughput increase calculated from duration.'],
 WORKFLOW_CHANGE_UNIT_MISMATCH:['The comparison units do not match.','Use the same unit for both values and % for the claim. Units will not be silently converted.'],
 WORKFLOW_CHANGE_POSITIVE_VALUES_REQUIRED:['The baseline must be positive and the changed value nonnegative.','Check a zero baseline or negative changed value. Values will not be silently adjusted.'],
 WORKFLOW_CHANGE_ZERO_BASE:['This percentage would divide by zero.','Throughput comparison requires a positive changed duration. Distinguish duration reduction from throughput increase.'],
 WORKFLOW_CHANGE_PROVENANCE_REQUIRED:['Source provenance and units are missing.','Extract the before and after values and the attributed claim from the source with explicit units.'],
 WORKFLOW_CHANGE_NUMBER_INVALID:['A comparison value has an unsupported numeric format.','Use numeric strings without units, grouping commas or exponent notation. Large numbers will not be rounded.'],
 WORKFLOW_CHANGE_TOLERANCE_INVALID:['The tolerance is outside the supported range.','Specify a tolerance between 0 and 100 percentage points.'],
 WORKFLOW_CHANGE_METRIC_REQUIRED:['The percentage metric is missing.','Specify value increase, value decrease, or throughput increase calculated from duration.'],
 A_SOURCE_FIELDS_CORRECTION_CONFLICT:['A correction does not match the preceding value.','Check the initial value and the previous value in each correction. Unconfirmed values will not be applied.'],
 A_SOURCE_FIELDS_AMBIGUOUS:['More than one value is recorded for this field.','Select the intended record or provide a connected chain of previous and corrected values.'],
 A_SOURCE_FIELDS_NOT_EXPLICIT:['The source does not establish a definite value for this field.','Check the field name, unit and confirmation status. Quotes, conditions and attributed claims do not establish the value.'],
 A_SOURCE_FIELDS_FORMAT_MISMATCH:['The requested format does not match the extraction conditions.','Check whether this field needs a number, status or date.'],
 A_SOURCE_FIELDS_INVALID:['This extraction condition is not supported.','Specify the field name and unit. Unsupported conditions will not be silently omitted.'],
 A_SOURCE_FIELDS_INCOMPLETE:['Some fields are missing extraction conditions.','Check the name and required format for each field.'],
 A_SOURCE_FIELDS_EVIDENCE_LIMIT:['The revision history exceeds the current evidence limit.','Select the necessary record range. The last value will not be selected without checking earlier corrections.'],
 A_SOURCE_SUMMARY_LITERAL_INVALID:['The extracted result and source evidence could not be checked together.','Check the source fields and correction records. Unverified results will not be saved.'],
 WORKFLOW_TEXT_ENCODING_INVALID:['The file could not be decoded as text.','Save valid UTF-8 text or convert to a supported format. Damaged characters will not be silently replaced.']
};
export function workflowFailureGuidance(code,language='ko'){
 if(language==='en')return typeof code==='string'&&Object.hasOwn(english,code)?{summary:english[code][0],nextAction:english[code][1]}:null;
 const entry=typeof code==='string'&&Object.hasOwn(entries,code)?entries[code]:null;
 return entry?{summary:entry[0],nextAction:entry[1]}:null;
}
