import {readFileSync,lstatSync,existsSync,renameSync} from 'node:fs';
import {dirname,basename,resolve} from 'node:path';
/** Publish only a new, verified native stage. An old destination is never evidence. */
export function publishVerifiedHwpStage({stagePath,targetPath,errorDetail,lastStep,structureVerification,backupExisting}){
 let backupPath=null;
 if(errorDetail)throw Error(`hwp-native-execution-failed:${errorDetail}`);
 if(lastStep!=='save-returned'||structureVerification?.status!=='verified')throw Error('hwp-native-save-or-structure-unverified');
 if(dirname(resolve(stagePath))!==dirname(resolve(targetPath))||!/^jarvis-hwp-stage-.*\.hwp$/u.test(basename(stagePath)))throw Error('hwp-native-stage-path-invalid');
 const info=lstatSync(stagePath);
 if(!info.isFile()||info.isSymbolicLink()||info.size<512||info.size>16*1024*1024)throw Error('hwp-native-stage-file-invalid');
 const bytes=readFileSync(stagePath);
 if(!bytes.subarray(0,8).equals(Buffer.from('d0cf11e0a1b11ae1','hex')))throw Error('hwp-native-stage-format-invalid');
 try{
  if(existsSync(targetPath)){
   backupPath=backupExisting(targetPath);
   if(!backupPath||existsSync(targetPath)||!existsSync(backupPath))throw Error('hwp-native-backup-unverified');
  }
  renameSync(stagePath,targetPath);
  return {published:true,backupPath};
 }catch(error){
  if(backupPath&&!existsSync(targetPath)&&existsSync(backupPath)){
   try{renameSync(backupPath,targetPath);}catch{ /* The verified backup remains recoverable. */ }
  }
  throw error;
 }
}
