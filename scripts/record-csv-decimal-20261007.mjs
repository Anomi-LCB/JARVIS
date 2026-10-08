import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/csv-decimal-20261007';
const files=['apps/pc-agent/src/adapters/workflow/decimal-sum.js','apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js','tests/workflow-decimal-sum.test.js','scripts/csv-decimal-office-pilot.mjs','scripts/csv-decimal-office-oracle.py'];
const sources=files.map(path=>{const bytes=readFileSync(path);return {path,sha256:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('utf8')};});
const observedAt=new Date().toISOString();
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources},null,2),{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-source.json`,`${prefix}-final-tests.txt`,`${prefix}-build.txt`,
 'artifacts/csv-decimal-baseline-20261007-jujeNq/result.json',
 'artifacts/csv-decimal-office-20261007-e0EcN2/result.json',
 'artifacts/csv-decimal-office-20261007-4GlPOH/result.json',
 'artifacts/csv-decimal-office-20261007-4GlPOH/independent-oracle.json',
 'artifacts/csv-decimal-office-20261007-4GlPOH/source.csv',
 'artifacts/csv-decimal-office-20261007-4GlPOH/summary.csv',
 'artifacts/csv-decimal-office-20261007-4GlPOH/report.xlsx',
 'artifacts/csv-decimal-office-20261007-4GlPOH/report.docx'];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'csv-decimal-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',observedAt,
 hypothesis:'CSV sum의 십진 오차를 고쳐 실제 자연어 Mission을 완료하고 같은 집계를 Excel/Word 실제 값과 독립 대조한다.',
 reportedOutcome:'failed',evidencePaths,
 lesson:'typed 완료 방어만으로 잘못된 CSV 게시가 해결되지 않는다. sum 원본 십진 계산을 수정하고 representability를 검사했다. Office 개별 G 통과와 전체 요구 해석 완료는 별개다.',
 limitations:'CSV 실제완료/불가숫자 write0,실제Excel/Word 값 독립일치,57회귀/build. 복합Office Mission 두 표현 PAUSED/원문해석미해결. sum만;평균/수식/의미/임의모델/계정/장기 미검증. 전체44%,V3-060 in_progress.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse(readFileSync(path,'utf8'));
const gate=acceptance.stages.flatMap(stage=>stage.gates).find(item=>item.id==='V3-060');
if(gate.status!=='in_progress')throw new Error('unexpected gate status');
for(const evidence of [`${prefix}-report.md`,'artifacts/csv-decimal-office-20261007-4GlPOH/independent-oracle.json'])if(!gate.evidence.includes(evidence))gate.evidence.push(evidence);
gate.limitations.push('CSV 소수 sum 실제결함 수정/자연어 완료/표현불가 숫자 write0. 원본→Excel 셀·차트/실제Word 표 독립Decimal·ZIP/XML일치. 복합Office 원문해석 두표현 PAUSED 남아V3-060 in_progress. 평균/수식재계산/의미 별도.');
writeFileSync(path,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 보고서: ${prefix}-report.md. CSV 소수 합계 결함 실제재현/수정,자연어 COMPLETED·표현불가값 BLOCKED/write0,원본→Excel/차트/Word 값 독립일치,57회귀/build. 복합Office 두 표현은 전체 원문해석 PAUSED 보존. V3-060 in_progress,전체44/100. 다음: 복합 생성 절과 대상·typed결과 일대일 원문 연결 및 금지·정정·추가지시 반례.\n`);
console.log(JSON.stringify({observedAt,evidenceFiles:evidencePaths.length,totalEvidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0)}));
