import {WordCreateToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyOfficeDocumentRenderingCurrent} from '../apps/verification/src/office-document-render-verifier.js';
import {ExecutionResultVerifier} from '../apps/verification/src/verification-runtime.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve('artifacts/office-current-render-20261007');await mkdir(root,{recursive:true});
for(const format of ['docx','pdf']){
 const args={path:resolve(root,'document.'+format),outputFormat:format,title:'현재 형식 출력 검증',blocks:[{type:'paragraph',text:'문서 구조와 실제 PDF의 요청 내용을 함께 검증합니다.'},{type:'bullets',items:['원본 구조 유지','출력 내용 대조']},{type:'table',columns:['항목','값'],rows:[['수입','10000'],['지출','2500'],['잔액','7500']]}]};
 const started=Date.now(),result=await new WordCreateToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:resolve(root,'undo.jsonl')})}).execute(args,{taskId:'office-current-render-'+format});
 const proof=await verifyOfficeDocumentRenderingCurrent({executionResult:result,allowedRoots:[root]});
 const checks=await new ExecutionResultVerifier().verify({executionResult:result,evidence:{toolName:'word.create'},capabilityToken:{scope:{allowedPaths:[root]}}});
 await writeFile(resolve(root,format+'-pilot.json'),JSON.stringify({observedAt:new Date().toISOString(),durationMs:Date.now()-started,args,result,proof,checks},null,2),{flag:'wx'});
 console.log(JSON.stringify({format,status:result.status,proof}));if(result.status!=='success'||!proof.passed){process.exitCode=1;break;}
}
