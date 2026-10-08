const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const label=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
/** Explicitly selected device diagnostics, never an attestation or execution grant. */
export function validPcDeviceObservation(value){
 if(!exact(value,'deviceType,os,hardware,permissions,probeStatus,startedAt,observedAt,executionAuthority,hardwareAttested,accountIdentityVerified')
  ||value.deviceType!=='pc'||value.executionAuthority!==false||value.hardwareAttested!==false||value.accountIdentityVerified!==false
  ||!timestamp(value.startedAt)||!timestamp(value.observedAt)||Date.parse(value.startedAt)>Date.parse(value.observedAt)
  ||!exact(value.os,'platform,release,architecture,source')||![value.os.platform,value.os.release,value.os.architecture].every(label)||value.os.source!=='node-os'
  ||!exact(value.permissions,'elevatedToken,source'))return false;
 if(value.probeStatus==='observed')return value.os.platform==='win32'&&exact(value.hardware,'manufacturer,model,source')
  &&label(value.hardware.manufacturer)&&label(value.hardware.model)&&value.hardware.source==='windows-cim'
  &&typeof value.permissions.elevatedToken==='boolean'&&value.permissions.source==='windows-token';
 return ['unavailable','unsupported-platform'].includes(value.probeStatus)&&value.hardware===null&&value.permissions.elevatedToken===null&&value.permissions.source==='not-observed';
}
export function projectPcDeviceObservation(value){
 const result={deviceType:value?.deviceType,os:value?.os,hardware:value?.hardware,permissions:value?.permissions,probeStatus:value?.probeStatus,
  startedAt:value?.startedAt,observedAt:value?.observedAt,executionAuthority:false,hardwareAttested:false,accountIdentityVerified:false};
 if(!validPcDeviceObservation(result))throw new Error('A_PC_OUTBOUND_DEVICE_OBSERVATION_INVALID');
 return result;
}
