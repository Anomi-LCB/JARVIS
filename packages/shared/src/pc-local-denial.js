/** Trusted reason codes only. Remote prose never becomes a user's next action. */
const actions=Object.freeze({
  B_PC_COMMAND_LOCAL_SCOPE_DENIED:'PC 쪽 실행 허용 범위와 자비스의 선택 범위를 일치시키세요.',
  B_PC_COMMAND_LOCAL_CATALOG_MISSING:'이 PC 업무 등록 화면에서 해당 업무를 찾아 명령 후보로 등록하세요. 등록만으로 실행이 허용되지는 않습니다.',
  B_PC_COMMAND_LOCAL_PERMISSION_MISSING:'이 PC 실행 허용 화면에서 해당 업무를 선택하고 허용 종료 시각을 저장하세요.',
  B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED:'이 PC의 실행 허용 기간이 끝났습니다. 실행 허용 화면에서 해당 업무와 새 종료 시각을 확인하세요.'
});
const english=Object.freeze({
  B_PC_COMMAND_LOCAL_SCOPE_DENIED:'Match this PC permission scope with the selected scope in JARVIS.',
  B_PC_COMMAND_LOCAL_CATALOG_MISSING:'Register this task as a command candidate in This PC task registration. Registration alone does not permit execution.',
  B_PC_COMMAND_LOCAL_PERMISSION_MISSING:'Select this task and save its expiry in This PC execution permissions.',
  B_PC_COMMAND_LOCAL_PERMISSION_EXPIRED:'This PC execution permission has expired. Check the task and save a new expiry in execution permissions.'
});
export function pcLocalDenialNextAction(reason,language='ko'){
  if(language==='en')return Object.hasOwn(english,reason)?`${english[reason]} Review the existing execution record before creating a new request.`:null;
  return Object.hasOwn(actions,reason)?`${actions[reason]} 새 요청 전 기존 실행 기록을 먼저 확인하세요.`:null;
}

/** Only known Core/PC command causes become instructions; remote prose is ignored. */
export function pcCommandDenialNextAction(error,language='ko'){
  if(error?.causeCode==='A_PC_COMMAND_LOCAL_SCOPE_DENIED'||error?.code==='A_PC_COMMAND_LOCAL_SCOPE_DENIED'){
    return pcLocalDenialNextAction(error.localScopeReason,language)??pcLocalDenialNextAction('B_PC_COMMAND_LOCAL_SCOPE_DENIED',language);
  }
  const code=error?.causeCode??error?.code;
  if(!['A_PC_COMMAND_EXECUTION_SCOPE_DENIED','A_PC_COMMAND_SCOPE_CHANGED'].includes(code))return null;
  return language==='en'
    ? 'Check this PC in PC & device connections: its Core execution scope, task and expiry may have changed. Review the existing execution record before creating a new request.'
    : 'PC·장치 연결에서 해당 PC의 실행 범위와 업무·허용 기간을 확인하세요. Core 실행 허용이 변경되었거나 끝났을 수 있습니다. 새 요청 전 기존 실행 기록을 먼저 확인하세요.';
}
