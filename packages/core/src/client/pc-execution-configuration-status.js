/** Credential/path-free configuration evidence; never permission or completion. */
export function pcExecutionConfigurationStatus({binding=null,controller,executionMode='unknown'}={}) {
 const mode=['standard','recovery-only'].includes(executionMode)?executionMode:'unknown';
 const result={configured:Boolean(binding),executionMode:mode,executionAuthorized:false,completionVerified:false};
 if(!binding)return result;
 let registrationMatch=null;
 try{
  const scope=controller.scope(binding.deviceId);
  const fingerprint=value=>String(value).replaceAll(':','').toUpperCase();
  registrationMatch=scope.generation===binding.deviceGeneration&&fingerprint(scope.certificateFingerprint)===fingerprint(binding.certificateFingerprint);
 }catch{}
 return {...result,deviceId:binding.deviceId,deviceGeneration:binding.deviceGeneration,registrationMatch};
}
