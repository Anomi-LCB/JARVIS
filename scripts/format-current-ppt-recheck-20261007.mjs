import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
const input=JSON.parse(await readFile('artifacts/format-current-ppt-20261007-Yp0xQU/result.json','utf8'));
const checks=await new ExecutionResultVerifier().verify({executionResult:input.result.executionResult,evidence:input.result.evidence,capabilityToken:{scope:{allowedPaths:[input.root]}}});
const current=checks.find(c=>c.checkName==='artifact_current_content_layout_verified');
await writeFile(join(input.root,'current-g.json'),JSON.stringify({observedAt:new Date().toISOString(),checks,current,originalPacketStatus:input.result.status,originalSource:'result.json',reason:'Original harness expected a nonexistent PC packet verification property; run actual G instead.'},null,2),{flag:'wx'});
console.log(JSON.stringify({root:input.root,currentG:current?.status}));if(current?.status!=='passed')process.exitCode=1;
