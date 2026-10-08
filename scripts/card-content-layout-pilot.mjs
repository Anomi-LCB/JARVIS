import {mkdtempSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {VisualCreateCardsToolAdapter,UndoJournal} from '../apps/pc-agent/src/pc-agent-runtime.js';
import {verifyNewsCardOcr} from './lib/news-card-ocr.mjs';
const root=mkdtempSync(resolve('artifacts/card-content-layout-live-20261007-'));
const card={fileName:'complete.png',title:'필수 요구사항 전체 검증',body:['자료 출처 확인','예산 한도 검토','일정 충돌 검사','개인 정보 보호','보고서 내용 검토','계정 권한 확인','작업 결과 기록','최종 승인 상태'],footer:'검증 출처'};
const result=await new VisualCreateCardsToolAdapter({allowedRoots:[root],undoJournal:new UndoJournal({journalPath:join(root,'undo.jsonl')})})
 .execute({outputDirectory:root,width:1200,height:675,cards:[card]},{taskId:'complete-card'});
const ocr=result.status==='success'?await verifyNewsCardOcr({allowedRoot:root,verificationScale:2,cards:card.body.map((title,index)=>({id:`requirement-${index}`,path:result.outputPaths[0],title,source:card.footer}))}):null;
writeFileSync(join(root,'result.json'),JSON.stringify({observedAt:new Date().toISOString(),input:card,result,ocr},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,status:result.status,ocrStatus:ocr?.status}));
