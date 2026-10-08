import { readFileSync } from 'node:fs';
import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';

try {
  const [operation,id,inputPath,...extra]=process.argv.slice(2);
  if(operation==='--help'||!operation) {
    console.log('node scripts/personal-mission.mjs <dispatch|run|refresh|cancel> <followUpId> [request.json]\nJARVIS_CORE_URL: loopback Core URL, default http://127.0.0.1:4071. Uses existing Core authentication.');
  } else {
    if(!['dispatch','run','refresh','cancel'].includes(operation)||!id||extra.length||(operation==='dispatch'?!inputPath:!!inputPath))throw new Error('Invalid arguments; see --help');
    const base=new URL(process.env.JARVIS_CORE_URL??'http://127.0.0.1:4071');
    if(base.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(base.hostname)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('Core URL must be a literal loopback HTTP origin');
    const body=inputPath?JSON.parse(readFileSync(inputPath,'utf8').replace(/^\uFEFF/u,'')):{};
    const token=process.env.JARVIS_CORE_ADMIN_TOKEN??resolveProductRuntimeSecrets().coreToken;
    const response=await fetch(new URL(`/personal-operations/followups/${encodeURIComponent(id)}/${operation}`,base),{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(300000)});
    const result=await response.json();console.log(JSON.stringify(result,null,2));if(!response.ok)process.exitCode=1;
  }
} catch(error) {console.error(error.message);process.exitCode=1;}
