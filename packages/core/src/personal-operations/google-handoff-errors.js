export const GOOGLE_HANDOFF_FAILURE_CODES=new Set([
  'A_GOOGLE_HANDOFF_EXPIRED',
  'A_GOOGLE_HANDOFF_RESTARTED',
  'A_GOOGLE_HANDOFF_REJECTED'
]);

/** Translate only the Core's allowlisted handoff errors; response details never reach the UI. */
export async function googleHandoffFailureCode(response){
  if(response?.status===202)return null;
  let code='';
  try{code=(await response.json())?.error?.code;}catch{}
  if(code==='A_INTEGRATION_HANDOFF_EXPIRED')return 'A_GOOGLE_HANDOFF_EXPIRED';
  if(code==='A_INTEGRATION_HANDOFF_NOT_FOUND')return 'A_GOOGLE_HANDOFF_RESTARTED';
  return 'A_GOOGLE_HANDOFF_REJECTED';
}
