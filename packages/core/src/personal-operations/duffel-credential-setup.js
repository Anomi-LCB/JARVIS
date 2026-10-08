import {IntegrationCredentialVault} from './integration-security.js';
import {DUFFEL_CONNECTOR_ID,DUFFEL_READ_SCOPE,DUFFEL_READ_CAPABILITY} from './duffel-quote-broker.js';
import {writeFileSync,renameSync,lstatSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Trusted local helper only: not a Core HTTP ingress. No implicit path or consent. */
export function saveDuffelTestCredential({apiKey,vaultPath,metadataPath,readConsent=false,clock=()=>new Date()}={}) {
  if(process.platform!=='win32')throw new Error('A_DUFFEL_SETUP_WINDOWS_REQUIRED');
  if(readConsent!==true)throw new Error('A_DUFFEL_SETUP_READ_CONSENT_REQUIRED');
  if(typeof apiKey!=='string'||!/^duffel_test_[A-Za-z0-9_-]{8,512}$/u.test(apiKey))throw new Error('A_DUFFEL_SETUP_TEST_KEY_REQUIRED');
  if(typeof vaultPath!=='string'||!vaultPath||typeof metadataPath!=='string'||!metadataPath)
    throw new Error('A_DUFFEL_SETUP_PATHS_REQUIRED');
  const vaultFile=resolve(vaultPath),publicFile=resolve(metadataPath);
  if(vaultFile.toLowerCase()===publicFile.toLowerCase())throw new Error('A_DUFFEL_SETUP_PATHS_INVALID');
  for(const path of [vaultFile,publicFile]){
    for(let current=path;;current=dirname(current)){
      if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw new Error('A_DUFFEL_SETUP_PATHS_INVALID');
      if(current===dirname(current))break;
    }
    if(!lstatSync(dirname(path)).isDirectory()||(existsSync(path)&&!lstatSync(path).isFile()))throw new Error('A_DUFFEL_SETUP_PATHS_INVALID');
  }
  const vault=new IntegrationCredentialVault({path:vaultFile,storageLocation:'explicit-duffel-broker-vault',clock});
  // Preserve unrelated records; a key replacement must have a new broker revision.
  const now=clock().toISOString();
  if(vault.list().some(row=>row.connectorId===DUFFEL_CONNECTOR_ID&&row.updatedAt===now))
    throw new Error('A_DUFFEL_SETUP_REVISION_CONFLICT');
  const credentials={apiKey};let row;
  try{row=vault.save({connectorId:DUFFEL_CONNECTOR_ID,providerAccountId:'duffel-test-primary',label:'Duffel 시험 견적 읽기',authMethod:'api-key',
    scopes:[DUFFEL_READ_SCOPE],grants:[DUFFEL_READ_CAPABILITY],credentials});}
  finally{credentials.apiKey='';apiKey='';}
  const metadata={schemaVersion:1,connectionId:row.connectionId,revision:row.updatedAt};
  const temporary=`${publicFile}.${randomUUID()}.tmp`;
  try{writeFileSync(temporary,JSON.stringify(metadata)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,publicFile);}
  catch{throw new Error('A_DUFFEL_SETUP_METADATA_PENDING');}
  return {metadata,credentialsStored:true,providerVerified:false,executionAuthorized:false,bookingAvailable:false};
}
