import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/semantic-author-20261008',directory='artifacts/semantic-holdout-20261008-author-chat';
const observedAt=new Date().toISOString(),failure=JSON.parse(await readFile(directory+'/failure.json','utf8'));
if(failure.accepted!==0||failure.error!=='AUTHOR_REQUEST_REQUIRED'||failure.productEvaluations!==0)throw Error('Terminal failed author evidence required');
const focused=await readFile(prefix+'-focused-v2.txt','utf8');
if(!focused.includes('ℹ pass 15')||!focused.includes('ℹ fail 0'))throw Error('Focused evidence required');
const paths=['scripts/author-semantic-holdout-20261007.mjs','scripts/semantic-author-validation.mjs','tests/semantic-author-validation.test.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 독립 의미평가 자료 작성 경로 보강

관측 ${observedAt}. 목표90%를 위한 원래 V3-024의26/260 의미평가 부족을 확인하고 작성 경로를 개선했다. 이전2026-10-07 v2는 accepted2 이후 원문 주석 오류로 종료됐다. 이번 첫 chat 시도는 accepted0/제품평가0으로 종료됐다. JSON 형식 성공을 의미평가 성공으로 기록하지 않는다.

Ollama 공식 구조화 출력 문서(https://docs.ollama.com/capabilities/structured-outputs)와 실제 로컬 template를 대조했다. 기존 모델 digest a2af6cc3eb7fa8be8504abaf9b04e88f17a119ec3f04a3addf55f92841195f5a의 Gemma3 4.3B Q4_K_M를 사용하며 모델을 새로 설치하거나 외부 계정을 호출하지 않는다. 설치 모델을 다른 모델이거나 base 모델이라고 추정했던 가설은 현재 template/공식 digest 확인으로 채택하지 않았다.

chat 사용자 메시지와 스키마 명시를 추가하고, source/target/순서/금지 적격성 오류에 한정해 최대3회 새 작성 요청을 허용했다. 엔진 코드·기존 시험·평가 점수는 제공하지 않는다. 실패 응답은 삭제하지 않으며 원문을 주석으로 재작성하지 않는다. 적격성 검사는 설명문·명시금지 누락·금지주석 누락·빈 요구·원문 불일치·순서 겹침·해당 부분문장에 없는 추정 대상을 거부한다.

첫 chat 시도는 정상 '누르세요' 표현도 기존 요청문 정규식이 인식하지 못해 AUTHOR_REQUEST_REQUIRED로 거부한 검사기 결함을 드러냈다. 동시에 생성 문장에 요구한 금지가 없었으므로 그 자료를 정상 코퍼스로 승격하지 않았다. 존댓말 요청 표현을 허용하고 별도의 명시금지 조건을 추가했다. 두 번째 새 chat-v2 실행을 시작했지만 이 보고서는 아직 그 결과를 완료로 기록하지 않는다. 후속 진행은 실제 프로세스/도구 handle 상태를 확인하고 종료 로그와 failure/corpus freeze를 대조해야 한다. 파일이 존재한다는 이유로 실행 중으로 판단하지 않는다.

최종 관련 회귀15/15, fail0/skip0. 새 작성 검증2개와 기존 평가 엔진/추가7차원 오라클 검사를 함께 실행했다. 단위 검사는 정답 적격성 도구의 동작이며 독립 의미평가26/260이나 실제 도구 완료의 증거가 아니다. 원자 의미 이외의 독립 정답 주석 검토·전 차원 평가·새260건은 남았다. 비용은 로컬 전력/하드웨어까지 미측정이고 작성 시간은 원본 응답의 elapsedMs이며 제품 업무 p50/p95가 아니다. runtime제품 코드/운영 개인 F/cognition/실계정/외부 쓰기 변경0, 유료 외부 호출0.

공식60완료/23진행/17대기 유지. V3-024의 부분 개발 증거를 보존하며 이번 작성 시도 결과는 failed다. 다음은 두 번째 실제 작성 실행 종료 결과를 확인하고, 적격한26건만 제품 평가 전에 동결한 뒤 독립 의미 주석과260건 확대를 진행하는 것이다. 이 과정에서 자료·모델 품질이 부족하면 채택 경로를 바꾼다. 복원은 작성기/검증 도구만 해당 변경을 검토하며 기존 점수 분모와 엄격 오라클을 완화하지 않는다.
`,{flag:'wx'});
const evidencePaths=[prefix+'-report.md',prefix+'-source.json',prefix+'-focused-v2.txt',prefix+'-live.txt',
 ...['failure.json','model.json','author-contract.json','response-0-commands-0.json','response-0-commands-1.json','response-0-commands-2.json'].map(n=>directory+'/'+n)];
const path='docs/universal-control-v3-acceptance.json',acceptance=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const gate=acceptance.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-024');
gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08: chat/scope주석/작성적격성·15회귀. 첫 작성 accepted0 종료 실패 및 정상 존댓말 거부 결함 수정. 새chat-v2 결과미확정;26/260·독립 의미골드·전체차원 미완료.'];
await writeFile(path,JSON.stringify(acceptance,null,2)+'\n');
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'semantic-author-20261008',candidateId:'local-ollama-mission-provider',kind:'comparison',reportedOutcome:'failed',observedAt:failure.observedAt,hypothesis:'별도 로컬 Gemma chat에 출력 스키마와 원문 주석 계약을 전달하면 제품 평가에 사용 가능한 독립 요청문을 만들 수 있다.',lesson:'스키마 통과는 요청문/금지/원문 주석의 의미 적격성이 아니다. 존댓말 검사의 과도한 거부와 작성 모델의 금지 누락을 분리하고 수정해야 한다.',limitations:'첫chat시도accepted0/제품평가0, 검사기 수정15/15. 후속chat-v2는 미확정이며26/260·전 의미오라클·독립전문가 미완료, 비용미측정,공식60/23/17유지.',evidencePaths},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 독립 의미 작성기 chat/적격성/원문검사 보강15/15. 첫chat accepted0 종료실패·존댓말 검사 수정. 후속 artifacts/semantic-holdout-20261008-author-chat-v2 실제 프로세스 상태·종료 결과 확인 후26동결/260확대. 공식60/23/17 유지.\n`);
