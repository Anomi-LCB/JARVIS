import {HwpCreateToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {mkdir,writeFile,readFile,copyFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve('artifacts/hwp-owned-publication-20261007');await mkdir(root,{recursive:true});
await copyFile('dist/verification/hwp-host-diagnostic.json',resolve(root,'native-diagnostic.json'));
const args={path:resolve(root,'native.hwp'),title:'독립 한컴 생성 검증',blocks:[
 {type:'paragraph',text:'기존 문서를 유지하고 새로 저장한 결과만 완료로 인정합니다.'},
 {type:'bullets',items:['저장 반환 확인','실제 표 구조 확인']},
 {type:'table',columns:['항목','값'],rows:[['완료 조건','42'],['검증 상태','확인']]}
]};
const started=Date.now(),result=await new HwpCreateToolAdapter({allowedRoots:[root],timeoutMs:30000,undoJournal:new UndoJournal({journalPath:resolve(root,'undo.jsonl')})}).execute(args,{taskId:'hwp-owned-publication-20261007'});
const actual=result.status==='success'?await readFile(args.path):null;
const report={observedAt:new Date().toISOString(),durationMs:Date.now()-started,args,result,actualSha256:actual?createHash('sha256').update(actual).digest('hex'):null};
await writeFile(resolve(root,'pilot.json'),JSON.stringify(report,null,2),{flag:'wx'});console.log(JSON.stringify(report));
if(result.status!=='success'||report.actualSha256!==result.sha256)process.exitCode=1;
