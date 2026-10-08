import {readFile,writeFile,appendFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/semantic-gold-review-20261008',observedAt=new Date().toISOString();
const write=(path,value)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const tests=await readFile(prefix+'-tests.txt','utf8');
if(!tests.includes('ℹ pass 19')||!tests.includes('ℹ fail 0')||!tests.includes('ℹ skipped 0'))throw Error('TEST_EVIDENCE_REQUIRED');
const prior='artifacts/semantic-holdout-20261008-author-chat-v2/validated-0.json';
const corpus={version:'separate-model-semantic-holdout-26-v1',cases:JSON.parse(await readFile(prior,'utf8')),
 limitations:['Previously rejected candidate, not approved gold. This tests refusal only.']};
const bytes=JSON.stringify(corpus,null,2)+'\n';
await write(prefix+'-rejected-corpus.json',bytes);
await write(prefix+'-freeze.json',{sha256:createHash('sha256').update(bytes).digest('hex'),beforeProductEvaluation:true});
const execution=spawnSync(process.execPath,['scripts/semantic-requirement-evaluation.mjs',prefix+'-rejected-corpus.json',prefix+'-freeze.json',prefix+'-must-not-score.json'],{encoding:'utf8',windowsHide:true});
let scoreFileExists=true;try{await access(prefix+'-must-not-score.json');}catch{scoreFileExists=false;}
if(execution.status!==1||!execution.stderr.includes('EVALUATION_GOLD_REVIEW_REQUIRED')||scoreFileExists)throw Error('UNREVIEWED_CORPUS_NOT_REFUSED');
await write(prefix+'-cli.json',{observedAt,exitCode:execution.status,stdout:execution.stdout,stderr:execution.stderr,scoreFileExists,
 actualRejectedCandidates:corpus.cases.length,productEvaluations:0,meaning:'Frozen bytes do not authorize an unreviewed model gold corpus.'});
const sourcePaths=['scripts/semantic-requirement-evaluation.mjs','tests/semantic-requirement-evaluation.test.js',prior];
await write(prefix+'-source.json',await Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
const watch=JSON.parse(await readFile('.runtime/research-watch/latest.json','utf8')),state=runResearchLedger(['status']);
await write(prefix+'-research.json',{observedAt,watch,candidateCount:state.candidateCount,
 candidates:state.candidates.map(c=>({id:c.id,nextReason:c.nextReason,nextExperiment:c.nextExperiment,
 attempts:(c.attempts??[]).filter(a=>a.reportedOutcome!=='passed').slice(0,2).map(a=>({id:a.id,reportedOutcome:a.reportedOutcome,lesson:a.lesson,limitations:a.limitations}))})),
 sourceReview:[
  {url:'https://developers.openai.com/api/docs/guides/agents-api/overview',finding:'Managed sessions/context/recovery; application still owns tool/environment choice. No execution or adoption this turn.'},
  {url:'https://developers.openai.com/api/docs/guides/agents/sdk',finding:'Application-owned tools/storage/approval remains suitable for Core/E/B/G; evaluation quality is not supplied by an SDK installation.'},
  {url:'https://developers.openai.com/api/docs/changelog',finding:'Reopened official document. Raw HTML changes alone are not a newly adopted feature or a JARVIS performance result.'}
 ]});
await write(prefix+'-report.md',`# 모델 작성 의미 정답의 검토 경계\n\n관측 ${observedAt}. 의미 주석 실패 이후 평가기 경로를 재검토했다. 기존 평가기는 모델 작성 코퍼스에 대해 파일 해시와 원문 위치만 맞으면 별도 의미 검토 기록 없이 채점을 시작할 수 있었다. 과거 실제 제품 점수가 그 경로로 부풀려졌다는 증거를 발견한 것은 아니다.\n\n모델 작성으로 명시된 코퍼스는 이제 전체 코퍼스 digest와 모든 사례 ID에 연결된 검토 기록이 없으면 엔진 호출 전에 EVALUATION_GOLD_REVIEW_REQUIRED로 거절한다. 오래된 검토·누락·중복·거절·대상 변경도 거절한다. CLI 역시 같은 가드를 사용한다. 일반 개발 회귀 코퍼스의 측정은 유지한다.\n\n최종 관련 검사 **19/19, 실패0·건너뜀0**. 기존 실패 실험의 실제2후보를 복사해 올바른 freeze 해시를 만들고 실제 CLI로 실행한 결과 exit1, 점수 파일 생성0, 제품 평가0이었다. 원본 실패 주석과 과거 증거는 수정하지 않았다. 새 정답을 지어내거나 오주석을 자동 정답으로 변경하지 않았다.\n\n검토 기록 형식은 semantic-gold-review-v1, corpusDigest=SHA256(JSON.stringify(파싱된 전체 corpus)), status=approved, reviewer/method/observedAt, 사례별 id/status/rationale이다. CLI 네 번째 인자로 검토 JSON을 전달한다. 이는 검토 기록의 결속 검사이며 검토자의 전문성·실제 독립성·정답의 진실성을 인증하는 시스템은 아니다. 별도 모델 검토도 사람 전문가 검증으로 표시하지 않으며 fullSemanticCriteriaMet=false를 유지한다.\n\n연구 감시6곳 중3변화·3동일·오류0, 장부54후보를 확인했다. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview)의 관리형 세션·복구와 [SDK](https://developers.openai.com/api/docs/guides/agents/sdk)의 앱 소유 실행 경계는 기존 구조와 대조했다. [공식 변경 기록](https://developers.openai.com/api/docs/changelog)도 재조회했다. HTML 해시 변화만으로 새 출시·기술 채택·성능 향상을 선언하지 않았다.\n\n공식 인수 **60/100 유지**. 제품 실행 코드·설치본·개인 기억은 이번에 변경하지 않았다. 의미평가26/260·독립 정답 검토·실제 모델 비교는 미완료, 비용/제품 지연 미측정이다. 다음은 독립 작성과 검토가 준비된 코퍼스 비교 및 V3-020 질문 필요성의 실제 계획기 반례다.\n`);
const evidencePaths=[prefix+'-report.md',prefix+'-tests.txt',prefix+'-cli.json',prefix+'-source.json',prefix+'-research.json',prefix+'-rejected-corpus.json',prefix+'-freeze.json'];
await write(prefix+'-attempt.json',{id:'semantic-gold-review-20261008',candidateId:'local-ollama-mission-provider',kind:'contract-test',reportedOutcome:'passed',observedAt,
 hypothesis:'Freeze integrity alone must not allow model-authored, unreviewed semantic gold to reach the scorer.',
 lesson:'Reject missing/stale/partial reviews before engine evaluation; record consistency is separate from actual semantic truth and reviewer qualification.',
 limitations:'19 local tests and actual rejected-candidate CLI only; no approved independent gold, no product/model comparison, no 26/260 acceptance. Cost and product latency unmeasured.',evidencePaths});
const acceptance='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(acceptance,'utf8')).replace(/^\uFEFF/,''));
const gate=a.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-024');
gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08 의미 검토 기록 없는 모델 골드의 평가 진입 차단,19검사·실제 실패2후보 CLI exit1/점수파일0. 검토자 독립성/전문성·26/260·실제 모델 성능은 미완료.'];
await writeFile(acceptance,JSON.stringify(a,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 미검토 모델 골드 채점 진입 차단19검사/실제 실패2후보 CLI 거절, 제품평가0. 공식60/100 유지. 다음 독립 작성+검토 코퍼스 비교 및 질문 필요성 실제 계획기 반례.\n`);
console.log(JSON.stringify(runResearchLedger(['record',prefix+'-attempt.json'])));
