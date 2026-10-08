import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {PowerPointCreateToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
const root=mkdtempSync(resolve('artifacts/powerpoint-content-live-20261007-'));
const input={path:join(root,'연구발표.pptx'),slides:[
 {title:'전체 요구사항 보존',bullets:['자료 출처와 확인 시각','본문과 해석을 구분','계정 권한과 예산 한도'],notes:'발표자 메모도 실제 저장 파일에서 확인한다.'},
 {title:'검증 결과와 다음 행동',bullets:['완료한 일과 남은 일을 구분','재시작 후 결과를 다시 확인'],notes:'추론과 사실을 혼동하지 않는다.'}]};
const result=await new PowerPointCreateToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})}).execute(input,{taskId:'presentation-pilot'});
writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),input,result},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,status:result.status,error:result.error,verification:result.contentVerification?.status}));
