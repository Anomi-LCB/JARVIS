const escape=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function taskEmptyResultMessage(result={},task=null) {
  if(task?.executionVerification?.status==='failed')return '실행 결과가 검증을 통과하지 못했습니다. 완료로 확인되지 않았습니다.';
  if(task?.status && String(task.status).toUpperCase()!=='COMPLETED' && ['success','completed'].includes(String(result.status??'').toLowerCase()))
    return '도구 실행 응답은 있지만 전체 작업 완료는 확인되지 않았습니다.';
  const status=String(result.status??'').toLowerCase();
  if(['success','completed'].includes(status))return '별도 파일 변경 없이 완료된 작업입니다.';
  if(['cancelled','canceled'].includes(status))return '작업이 취소되었습니다. 확인된 산출물이 없습니다.';
  if(['failed','blocked','quarantined','quarantine'].includes(status))return '작업이 완료되지 않았습니다. 확인된 산출물이 없습니다.';
  return '확인된 산출물이 없습니다. 현재 작업 상태를 확인해 주세요.';
}

export function renderNativeRecovery(result={},language='ko') {
  if(!['failed','blocked','quarantined','quarantine','cancelled','canceled'].includes(String(result.status??'').toLowerCase()))return '';
  const recovery=result.nativeRecovery??result.evidence?.workbook?.renderValidation?.nativeRecovery;
  if(recovery?.version!==1||!['activation-unconfirmed','owned-guarded','rendered'].includes(recovery.phase)
    ||typeof recovery.cleanupConfirmed!=='boolean'||typeof recovery.activationGapUnverified!=='boolean'
    ||recovery.autoRetryAllowed!==false||recovery.executionAuthority!==false)return '';
  const initial=recovery.phase==='activation-unconfirmed'||recovery.activationGapUnverified;
  const stage=initial?'Excel 실행 초기 상태 확인 필요':recovery.phase==='rendered'?'PDF 렌더링 이후 작업 중단':'작업용 Excel 보호 연결 후 중단';
  const cleanup=recovery.cleanupConfirmed&&!initial?'작업용 Excel 정리 확인됨':'작업용 Excel 정리 여부 미확인';
  const next=initial?'실행 중인 Excel과 원본 파일을 확인하세요. 확인되지 않은 Excel을 일괄 종료하지 마세요.'
    :recovery.cleanupConfirmed?'원본 파일과 실행 권한을 확인한 뒤 새 요청으로 진행하세요.'
      :'실행 중인 Excel을 확인하고, 확인된 작업용 인스턴스만 정리한 뒤 다시 요청하세요.';
  if(language==='en') {
    const stageEn=initial?'Excel activation state needs checking':recovery.phase==='rendered'?'Task stopped after PDF rendering':'Task stopped after Excel protection was attached';
    const cleanupEn=recovery.cleanupConfirmed&&!initial?'Task-owned Excel cleanup confirmed':'Task-owned Excel cleanup unconfirmed';
    const nextEn=initial?'Check running Excel and the original file. Do not terminate all unconfirmed Excel instances.':recovery.cleanupConfirmed?'Check the original file and execution permissions before making a new request.':'Check running Excel and clean up only the confirmed task-owned instance before requesting again.';
    return `<aside class="task-recovery" aria-label="Excel task recovery"><strong>${stageEn}</strong><p>${cleanupEn} · Automatic retry stopped</p><p>${nextEn}</p><small>This guidance does not confirm task completion or file content verification.</small></aside>`;
  }
  return `<aside class="task-recovery" aria-label="Excel 작업 복구 안내"><strong>${stage}</strong><p>${cleanup} · 자동 재시도 중지</p><p>${escape(next)}</p><small>이 안내는 실행 완료나 파일 내용 검증을 뜻하지 않습니다.</small></aside>`;
}
