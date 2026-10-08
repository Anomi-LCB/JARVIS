import {HwpCreateToolAdapter} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve('artifacts/hwpx-content-20261007');
await mkdir(root,{recursive:true});
const args={path:resolve(root,'내용보존.hwpx'),title:'구조 검증 보고서',blocks:[
 {type:'heading',text:'확인 사항',level:1},
 {type:'paragraph',text:'머리글과 각 셀의 위치를 독립적으로 확인합니다.'},
 {type:'bullets',items:['원본을 보존한다','렌더링 미검증을 숨기지 않는다']},
 {type:'table',columns:['항목','수량','상태'],rows:[['문서','3','확인'],['자료','7','대기']]},
 {type:'table',columns:['머리글만 있는 표'],rows:[]}
]};
const started=Date.now();
const result=await new HwpCreateToolAdapter({allowedRoots:[root]}).execute(args,{taskId:'hwpx-content-20261007'});
await writeFile(resolve(root,'pilot.json'),JSON.stringify({observedAt:new Date().toISOString(),durationMs:Date.now()-started,args,result},null,2),{flag:'wx'});
console.log(JSON.stringify(result));
if(result.status!=='success')process.exitCode=1;
