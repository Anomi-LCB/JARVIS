import {readFile,writeFile,appendFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateAuthorAnnotation} from './semantic-author-validation.mjs';
const prefix='artifacts/semantic-author-20261008-adjudication',directory='artifacts/semantic-holdout-20261008-author-chat-v2',observedAt=new Date().toISOString();
const cases=JSON.parse(await readFile(directory+'/validated-0.json','utf8'));
const rows=cases.map(item=>{try{validateAuthorAnnotation(item.command,item.requirements);return {id:item.id,clearContradiction:null,semanticGoldApproved:false};}catch(error){return {id:item.id,clearContradiction:error.message,semanticGoldApproved:false};}});
if(!rows.some(r=>r.clearContradiction==='AUTHOR_SAVE_PROHIBITION_LABELLED_DELETE'))throw Error('Observed annotation failure required');
try{await access(directory+'/freeze.json');throw Error('Corpus must not have been frozen');}catch(error){if(error.code!=='ENOENT')throw error;}
if(!(await readFile(prefix+'-tests.txt','utf8')).includes('ℹ pass 16'))throw Error('Focused evidence missing');
await writeFile(prefix+'-audit.json',JSON.stringify({observedAt,structuralCandidates:cases.length,semanticGoldApproved:0,productEvaluations:0,rows},null,2),{flag:'wx'});
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['scripts/semantic-author-validation.mjs','tests/semantic-author-validation.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 작성 모델 의미 주석의 실패와 조기 종료

관측 ${observedAt}. 이전 보고서의 미확정 chat-v2 실험은 구조상2개 후보를 생성했지만, 독립적인 원문 검토에서 잘못된 정답을 발견하여 소유 프로세스 트리를 종료했다. 이제 실행 중이 아니다. 도구 handle96098은 exit1로 종료됐고, 정확한 Node 명령행으로 단일 소유 프로세스를 확인한 종료 증거를 보존했다. 다른 사용자 프로세스는 종료 대상으로 삼지 않았다.

H01-1 원문 '변경 사항을 저장하지 말고'를 action:delete로, '바로 닫아 주세요.'를 action:delete로 주석했다. 명령에서 금지한 것은 저장이며 창을 닫는 것은 파일 삭제와 다르다. text/sourceSpan이 일치해도 의미 정답은 아니다. 후보의 정답을 수동 변경해 독립 코퍼스로 승격하거나 이 정답으로 Core를 채점하지 않았다. corpus/freeze 없음, 의미 정답 승인0, 제품 평가0. 구조상 accepted2는 의미 검증 통과2건이 아니다.

명백한 두 모순을 AUTHOR_SAVE_PROHIBITION_LABELLED_DELETE/AUTHOR_CLOSE_LABELLED_DELETE로 거부하도록 작성 검증 도구를 보강했다. 다음 작성 시 원문에 대해 새 주석을 요청하되 자동으로 정답 라벨을 덮어쓰지 않는다. 이것은 두 관측된 오류를 차단하는 개발 회귀이며 전 행동 의미·대상·조건·금액·시간 정답의 적격성을 보장하지 않는다. 최종 관련16/16 fail0/skip0. 앞선15개 검사와 합산하지 않는다. 제품 실행 코드를 변경하지 않았으므로 이 결과로 자연어 이해 점수를 올리지 않는다.

공식60/23/17 유지. V3-024 전체26/260 및 독립 의미 주석 검토 미완료, local 작성 시도는 failed다. 비용/제품 지연은 미측정. 단일 약한 작성 모델의 반복으로 전체 의미 검증을 대체하지 않고, 다른 작성/검토 모델 또는 전문가 검토를 포함한 경로로 전환한다. 실제 외부 모델 비교의 월 예산 한도는 사용자에게 요청했으며 비밀정보를 대화에 요구하지 않았다. 예산·자격증명이 준비되지 않은 유료 호출은 수행하지 않는다. 남은 로컬 인수 작업은 계속 진행한다.
`,{flag:'wx'});
const evidencePaths=[prefix+'-report.md',prefix+'-audit.json',prefix+'-source.json',prefix+'-tests.txt',prefix+'-stop.json',directory+'/validated-0.json',directory+'/author-contract.json',directory+'/model.json'];
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),gate=a.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-024');
gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08 후속: chat-v2 구조2후보의 저장금지/창닫기=delete 오주석 발견·소유프로세스 종료(exit1), 실행중 아님. 의미골드승인/제품평가0·16회귀. 독립작성/검토경로 전환 및26/260 미완료.'];
await writeFile(path,JSON.stringify(a,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'semantic-author-adjudication-20261008',candidateId:'local-ollama-mission-provider',kind:'comparison',reportedOutcome:'failed',observedAt,hypothesis:'별도 로컬 모델이 원문 위치를 보존한 주석을 생성하면 독립 의미평가 정답 재료로 사용할 수 있다.',lesson:'원문 위치 일치는 의미 정답이 아니다. 저장 금지와 창닫기를 삭제로 오분류한 후보는 제품 평가 전에 거부하고 단일 약한 모델 반복을 중단한다.',limitations:'구조2후보/의미골드승인0/제품평가0, 조기종료실패. 두명백한오류16회귀만확인,26/260·전의미검증·외부비교미완료,비용미측정.',evidencePaths},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: chat-v2 작성 소유프로세스 종료(exit1), 실행중 아님. 구조2후보 오주석/골드승인0/제품평가0·16회귀. 다음 독립 작성+검토 경로 변경(외부비교 예산 요청 중) 및 남은 로컬 인수 작업. 공식60/23/17 유지.\n`);
