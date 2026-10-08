import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/creation-batch-20261007',root='artifacts/csv-decimal-office-20261007-EJglzL';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=path=>JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/u,''));
const run=read(`${root}/result.json`),oracle=read(`${root}/independent-oracle.json`);
assert.equal(run.results[0].status,'COMPLETED');assert.equal(run.results[1].status,'BLOCKED');assert.equal(run.results[1].outputPresent,false);
const office=run.results.find(item=>item.id==='office');assert.equal(office.status,'COMPLETED');
assert.ok(office.checks.every(check=>check.proof.passed));
for(const proof of [office.wrongChart,office.wrongCells,office.wrongTables])assert.equal(proof.passed,false);
assert.equal(run.sourcePreserved,true);
for(const property of ['csvValuesMatchSource','xlsxCellsMatchSource','chartValuesAndReferencesMatchSource','wordCoordinatesMatchSource','sourcePreserved'])assert.equal(oracle[property],true);
for(const [file,digest] of Object.entries(oracle.fileSha256))assert.equal(hash(readFileSync(`${root}/${file}`)),digest);
const nativePath='artifacts/mission-xlsx-charts-20261003-count-excel/native-independent-check.json',native=read(nativePath);
const nativeSource='artifacts/mission-xlsx-charts-20261003-count-sample/selected.xlsx';
assert.equal(hash(readFileSync(nativeSource)),native.sourceSha256);assert.equal(native.sourceUnchanged,true);assert.equal(native.readOnly,true);
const tests=readFileSync(`${prefix}-final-current-tests.txt`,'utf8');assert.match(tests,/tests 161/);assert.match(tests,/fail 0/);assert.match(tests,/skipped 0/);
assert.match(readFileSync(`${prefix}-build.txt`,'utf8'),/Built static/);
const observedAt=new Date().toISOString(),acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=read(acceptancePath);
const gates=acceptance.stages.flatMap(stage=>stage.gates),gate=gates.find(item=>item.id==='V3-060');
assert.equal(gates.length,100);assert.equal(gate.status,'in_progress');
assert.equal(gate.requirement,'CSV·Excel 계산·문서 표·차트의 실제 값과 원본 보존을 검사한다.');
const originalRequirements=hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement})))));
const audit={observedAt,gateId:gate.id,originalRequirement:gate.requirement,originalRequirementsSha256:originalRequirements,
 components:['csv-source-calculation/current-values','xlsx-current-cells-and-chart-data','actual-word-saved-table-coordinates','original-source-preservation'],
 currentOfficeStatus:office.status,negativeExpectedValuesRejected:true,independentOracleSha256:hash(readFileSync(`${root}/independent-oracle.json`)),
 currentFilesSha256:oracle.fileSha256,nativeExcelOriginalPreserved:true,nativeExcelSource:nativeSource,nativeExcelSourceSha256:native.sourceSha256,
 unsupportedFormulaCompletionClaim:false,remainingScope:'arbitrary formulas, all Office formats, semantic/visual quality and live-use acceptance remain separate',
 decision:'verified',previousVerified:gates.filter(item=>item.status==='verified').length};
writeFileSync(`${prefix}-acceptance-audit.json`,JSON.stringify(audit,null,2),{flag:'wx'});
const paths=['packages/core/src/mission/goal-contract.js','packages/core/src/mission/mission-requirement-coverage.js','packages/core/src/mission/mission-planner.js',
 'tests/mission-creation-batch.test.js','scripts/csv-decimal-office-pilot.mjs','scripts/csv-decimal-office-oracle.py'];
writeFileSync(`${prefix}-source.json`,JSON.stringify({observedAt,sources:paths.map(path=>{const bytes=readFileSync(path);return {path,sha256:hash(bytes),content:bytes.toString('utf8')};})},null,2),{flag:'wx'});
const evidencePaths=[`${prefix}-report.md`,`${prefix}-acceptance-audit.json`,`${prefix}-source.json`,`${prefix}-final-current-tests.txt`,`${prefix}-build.txt`,
 `${root}/result.json`,`${root}/independent-oracle.json`,`${root}/source.csv`,`${root}/summary.csv`,`${root}/report.xlsx`,`${root}/report.docx`,nativePath,'docs/creation-request-binding.md',`${prefix}-diagnostic.txt`];
writeFileSync(`${prefix}-attempt.json`,JSON.stringify({id:'creation-batch-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',observedAt,
 hypothesis:'명시적인 복합 생성 원문 전체와 실제 파일/typed 값 검증을 연결하고 누락·추가 계획은 첫 쓰기 전 차단한다.',reportedOutcome:'passed',evidencePaths,
 lesson:'생성 지시를 미해석으로 놓치고 출력명을 입력 부트스트랩으로 검색하던 두 경로를 수정했다. G 관측과 전체 source coverage는 둘 다 필요하다.',
 limitations:'실제 CSV/Excel/Word + 고정 Office 계획/독립 Decimal·ZIP/XML/161회귀/build. 원문 V3-060 결과검사 인수45/100. 임의수식/모든형식/의미/계정/장기 미완료. 외부모델0,비용미측정.'},null,2),{flag:'wx'});
gate.reviewHistory??=[];gate.reviewHistory.push({status:gate.status,evidence:[...gate.evidence],limitations:[...gate.limitations],reviewedAt:gate.reviewedAt??null,supersededAt:observedAt});
gate.status='verified';gate.reviewedAt=observedAt;
for(const evidence of [`${prefix}-report.md`,`${prefix}-acceptance-audit.json`,`${root}/result.json`,`${root}/independent-oracle.json`,`${prefix}-final-current-tests.txt`])if(!gate.evidence.includes(evidence))gate.evidence.push(evidence);
gate.limitations=['숫자/좌표/참조/原本保존 결과검사 계약을 실제 CSV·Excel·Word 및 독립 Decimal·ZIP/XML로 인수했다. 임의 계산 엔진 전체를 구현했다는 판정이 아니다.',
 'Excel 캐시 수식은 재계산 미검증으로 차단하며 임의 수식 정확성·전체 Office 형식·일반 의미/디자인·실계정/다른PC/장기관측은 별도 인수다.',
 'Office 계획은 고정 주입/합성자료, 외부모델0·비용미측정. 혼합 미지원/부정/정정은 부분 실행 없이 보류한다. 이전 실패와 부족한 인수 이력은 reviewHistory와 evidence에 유지한다.'];
acceptance.updatedAt=observedAt;
assert.equal(hash(Buffer.from(JSON.stringify(gates.map(({id,requirement})=>({id,requirement}))))),originalRequirements);
writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 보고서: ${prefix}-report.md. 명시적 복합 생성 source binding/추가·누락 write0/출력 bootstrap 수정. 실제 CSV→Excel 셀·차트/Word 표 COMPLETED·독립계산/원본보존/잘못된값3거절·161회귀/build. V3-060 원래 결과검사 요구 감사 verified,전체45/100. 任意수식재계산·전체Office형식·일반의미·실사용 미검증 유지. 상위 목표70% 유지,다음은 V3-061 또는 V3-018 혼합 계약 검증.\n`);
console.log(JSON.stringify({verified:gates.filter(item=>item.status==='verified').length,evidenceFiles:evidencePaths.length,evidenceBytes:evidencePaths.reduce((sum,path)=>sum+readFileSync(path).length,0)}));
