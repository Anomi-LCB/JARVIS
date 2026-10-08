/** Converts only an explicit weekly command into a durable, low-authority routine request. */
export function parseWeeklyRoutineCommand(command, routineId) {
  const text = String(command ?? '').trim();
  if (!text || text.length > 32_768 || !/매주/u.test(text)) return { matched: false };
  const scheduleSignal = /(?:요일|오전|오후|\d{1,2}\s*시|예약(?:해|해줘|해 주세요)?|반복(?:해|실행)?)/u.test(text);
  if (!scheduleSignal) return { matched: false };
  const match = /매주\s*(?:월요일|화요일|수요일|목요일|금요일|토요일|일요일|월|화|수|목|금|토|일)\s*(?:오전|오후)\s*\d{1,2}\s*시(?:\s*\d{1,2}\s*분)?/u.exec(text);
  if (!match) return { matched: true, valid: false, reason: '요일과 오전/오후 시각을 명확히 말해 주세요. 예: 매주 월요일 오전 9시에 작업 폴더를 정리해줘.' };
  const before = text.slice(0, match.index).trim();
  const after = text.slice(match.index + match[0].length).trim();
  const objective = `${before} ${after}`.replace(/(?:^|\s)(?:에|마다)(?=\s|$)/gu, ' ')
    .replace(/^[,\s]+|[,\s]+$/gu, '').replace(/\s+/gu, ' ');
  if (!objective || objective.length > 32_768) return { matched: true, valid: false, reason: '예약 시각과 실행할 작업을 함께 말해 주세요.' };
  if (/(?:메일|메시지|메신저|문자|결제|구매|주문|송금|투자|예약 확정|항공권|기차표|도어락|차량|난방|약 복용|응급 전화).{0,35}(?:보내|전송|발송|결제|구매|주문|송금|투자|예약|켜|꺼|열어|잠가|복용|전화)|(?:보내|전송|발송|결제|구매|주문|송금|투자|예약 확정|켜|꺼|잠가).{0,35}(?:메일|메시지|메신저|문자|계좌|도어락|차량|난방|항공권|기차표)/u.test(objective)) {
    return { matched: true, valid: false, reason: '반복 예약은 읽기·저위험 로컬 작업만 지원합니다. 발송·거래·물리 기기 동작은 예약하지 않았습니다.' };
  }
  if (!/(?:해줘|해주세요|해 주|실행|확인|정리|요약|점검|만들|작성|읽어|분석|수집|조사|준비|관리|기억|알려|찾아|검색|분류|백업|동기화|검토|보내|전송|예약)/u.test(objective)) {
    return { matched: true, valid: false, reason: '반복 실행할 작업이 분명하지 않습니다. 동작을 함께 적어 주세요.' };
  }
  if (!/^[A-Za-z0-9:_-]{1,160}$/u.test(routineId ?? '')) return { matched: true, valid: false, reason: '예약 식별값을 만들지 못했습니다.' };
  return {
    matched: true,
    valid: true,
    request: {
      routineId,
      scheduleText: match[0],
      timeZone: 'Asia/Seoul',
      missionRequest: {
        objective,
        successCriteria: [`${objective}의 실행 결과와 검증 상태가 기록된다.`],
        constraints: [
          '등록된 JARVIS 작업공간과 현재 연결된 저위험 로컬 기능 안에서만 실행한다.',
          '메일·메신저 발송, 예약 확정, 구매·결제·송금, 금융·의료 판단, 스마트홈·차량·도어락 제어를 하지 않는다.',
          '현재 준비 조건이나 권한이 부족하면 우회하거나 늦게 실행하지 말고 차단 이유와 필요한 조치를 남긴다.'
        ],
        authorization: { mode: 'supervised', grants: ['read_only', 'local_reversible'] }
      }
    }
  };
}
