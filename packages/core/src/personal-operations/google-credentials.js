import { existsSync,readFileSync,writeFileSync,mkdirSync,renameSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { protectWithWindowsDpapi,unprotectWithWindowsDpapi,hardenWindowsSecretFile } from '../../../shared/src/product-runtime-secrets.js';
import { googleCredentialsFromEnv } from './google-client.js';
export const googleCredentialPath=()=>join(homedir(),'.jarvis','google-oauth.dpapi.json');
export function saveGoogleCredentials(credentials,{path=googleCredentialPath(),protect=protectWithWindowsDpapi,harden=hardenWindowsSecretFile}={}) {
  if(!['clientId','clientSecret','refreshToken'].every(k=>typeof credentials[k]==='string'&&credentials[k]))throw new Error('A_GOOGLE_CREDENTIALS_INVALID');
  const encrypted=protect(Buffer.from(JSON.stringify(credentials)).toString('base64'));
  mkdirSync(dirname(path),{recursive:true});const temporary=`${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary,JSON.stringify({version:1,provider:'windows-dpapi-current-user',encrypted}),{mode:0o600});
  harden(temporary);renameSync(temporary,path);
}
export function loadGoogleCredentials(env=process.env,{path=googleCredentialPath(),unprotect=unprotectWithWindowsDpapi}={}) {
  const configured=googleCredentialsFromEnv(env);
  if(Object.values(configured).some(Boolean))return configured;
  if(env.JARVIS_TEST_MODE==='1'||!existsSync(path))return {};
  try{
    const envelope=JSON.parse(readFileSync(path,'utf8'));if(envelope.version!==1||envelope.provider!=='windows-dpapi-current-user')throw new Error('version');
    return JSON.parse(Buffer.from(unprotect(envelope.encrypted),'base64').toString('utf8'));
  }catch{return {configurationError:'A_GOOGLE_CREDENTIAL_STORE_UNREADABLE'};}
}
