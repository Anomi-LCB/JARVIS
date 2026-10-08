import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/plain-summary-20261007',read=p=>readFileSync(p,'utf8').replace(/^\uFEFF/u,'');
const write=(suffix,data)=>writeFileSync(`${prefix}-${suffix}`,typeof data==='string'?data:JSON.stringify(data,null,2)+'\n',{flag:'wx'});
const observedAt=new Date().toISOString(),product=JSON.parse(read(`${prefix}-product-r4/comparison.json`)),cleanup=JSON.parse(read(`${prefix}-product-r4/cleanup.json`));
assert.deepEqual(product.rows.map(r=>r.status),['COMPLETED','COMPLETED','BLOCKED']);assert.equal(cleanup.allTerminal,true);
assert.equal(product.replay.before.outputSha,product.replay.afterRestart.outputSha);assert.equal(product.replay.before.mtime,product.replay.afterRestart.mtime);
assert.match(read(`${prefix}-product-r4/comparison.json`),/"outputRediscovered": true/);
for(const [key,value] of [['tests',185],['pass',185],['fail',0],['skipped',0]])assert.match(read(`${prefix}-final.txt`),new RegExp(`ℹ ${key} ${value}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-final-build.txt`),/Built static JARVIS executive console into dist/);
assert.match(read(`${prefix}-final-contract.txt`),/gatePassed: true/);
const files=['packages/core/src/mission/natural-workflow-compiler.js','packages/core/src/mission/mission-field-summary-result.js',
 'tests/natural-plain-summary.test.js','scripts/plain-summary-product-20261007.mjs'];
write('source.json',{observedAt,files:files.map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)})),
 cleanup,packetProjection:JSON.parse(read(`${prefix}-product-r4/replay-packet-projection.json`))});
const audit={observedAt,acceptanceId:'V3-059',originalRequirement:'파일 발견·내용 읽기·요약·산출물 저장·다시 찾기를 자연어 Mission으로 검증한다.',
 requirementUnchanged:true,checks:[
  {phase:'file-discovery',proof:'Default natural compiler fs.inventory/filter/unique-count and current Core directory find; nested positive and duplicate/missing negative.'},
  {phase:'content-read',proof:'Actual remote text.read receipt binds current UTF-8 source path/SHA; original source reread by Core G.'},
  {phase:'summary',proof:'Original requested topics preserved in the full one-sentence plan, bounded declaration extractor; independent output facts0/보류 match actual bytes.'},
  {phase:'artifact-save',proof:'Separate authenticated remote PC B workflow staged/publication; actual JSON file contains facts, exact quotes, provenance, sourceSHA.'},
  {phase:'rediscovery',proof:'After publication Core worker recursively finds exactly one named output and rereads current bytes with outputRediscovered=true; duplicate-after-write prevents completion.'},
  {phase:'identity-and-recovery',proof:'Current request/spec hash/node receipts checked; stable v9 workflow identity despite v10 grammar; same Mission replay and four-service restart preserve content/mtime.'}],
 scope:'Supported explicit source declarations in local UTF-8 TXT/JSON Mission. Not arbitrary document meaning, independent expert semantic accuracy, every natural-language expression, live-account or native-installer.'};
write('scope-audit.json',audit);
write('report.md',`# 일반 한국어 한 문장 파일 요약의 기본 실행 연결\n\n관측 ${observedAt}. 공식 인수57→58/100.\n\n## 사용 가능한 요청\n\n“'.' 폴더에서 '자료.txt' 파일을 찾아 실제 지출액과 승인 상태를 요약해 '정리.json'에 JSON으로 저장하고 다시 찾아 읽어 확인해줘”\n\n항목마다 개발용 label/kind/unit 문법을 지정하지 않아도 지원한 요약 항목을 호스트 질문 계약으로 보존한다. 실제 지출·납부·입금·결제액, 승인·계약 상태, 최종 검증 결과, 최종 참가/참석/설문 인원을 현재 지원한다. 없는 선언, 충돌·조건·인용 안의 선언·미지원 항목은 추측하지 않는다. 금액을 두 배로 하거나 메일을 보내라는 추가 요구를 버리고 앞부분만 실행하지 않는다. 원문 덮어쓰기와 밖의 경로도 거부한다. 임의 자유 요약은 아직 이 경로가 아니다.\n\n## 실제 전체 실행\n\n기본 자연어 계획기→E 정책→별도 PC B 프로세스→G→Core SQLite의 실제 루프백 HTTP를 실행했다. 정상/하위 폴더2건 완료, 별칭 금액 충돌1건 BLOCKED·결과파일0. 시험 planner나 모델 fixture가 답을 만들지 않았다. 기본 UI와 동일한 전체 목표 완료 criterion을 사용했다. 파일 사실0·보류는 파일 바이트로 별도 대조했으며, Core G는 현재 원문·출력 해시/정확한 근거를 다시 계산한다.\n\n저장 후 Core 검증 워커가 결과 폴더를 다시 검색해 같은 이름의 파일을 하나만 찾고 현재 파일을 읽는다. outputRediscovered=true와 원문/출력SHA를 보존한다. 출판 직후 원문이 바뀌거나 같은 결과 이름이 추가된 반례는 완료시키지 않는다. 실제 격리 상태이며 계정·개인자료·네이티브 설치본은 변경하지 않았다.\n\n같은 Mission 재실행 및4서비스 종료/재시작 뒤 파일 SHA와 수정시각을 보존했고 SQL 완료를 복원했다. 초기 시험은 전체 패킷 로그까지 바이트 동일해야 한다는 조건으로 실패했다. 내용/mtime은 그대로였고 재시작시 workflow_cleanup_result/not-present2건이 추가되는 것을 다음 실행과 실제 B 정리 코드에서 확인했다. 재정리 기록을 중복 파일 생성으로 취급하지 않는다. 동일 실행 직후 추가 패킷0이며 재시작후 파일내용/mtime불변을 각각 증거로 보존했다. 전체 로그 변화도 숨기지 않았다.\n\n문법 버전을v10으로 올리되 이미 저장된v9 워크플로 ID는 바꾸지 않도록 cache revision과 영속 신원을 분리했다. 기존 작업의 원문·node 배열·증거 해시는 그대로 유지한다. 최초20검사 통과, 넓은184검사 통과, 최종기존신원 회귀 포함185/185 fail0/skip0. 최종 빌드/Core 계약 통과. 실제 HTTP 전 단계4회도 로그와 종료 기록을 보존했다.\n\n## 인수 판정과 한계\n\nV3-059 원래 다섯 단계 요구를 기본 자연어 요청·원격 B·현재 내용 G·실제 결과 재검색으로 검증하여 완료한다. 원문 요약 정확도를 모델의 자기 평가로 대신하지 않았다. 독립 의미/전문가평가26/260, 임의 문서·모든 파일 형식·외부 서비스·전면 자율성·장기 실사용은 다른 인수에서 계속 미완료다. 이 완료는 그 수치를 대신하지 않는다. 원래100개 범위/정답을 줄이지 않았다. 전체58/100은 검토한 인수율이며 일반 명령 성공률이 아니다.\n\n시간은 개별 Mission 기록, 모델/유료 API 호출0·청구0. 전기/장비/개발 총비용 미측정. 설치본 배포·운영 서비스 재시작·UI 디자인 변경을 하지 않았다. 테스트 전용 프로필/저장소만 사용했고 F/cognition 실제 업무 기억과 개인 프로필을 보존했다.\n\n복원은 plainSummaryMatch 경로를 보류하면 된다. 명시적 항목의 기존 문법을 유지하고 v9 영속 ID와 현재원문 검증을 훼손하지 않는다. 새 결과 재검색 검사를 제거하면 중복 출력 반례를 다시 놓칠 수 있다. 다음은 남은 일반 의미 검증, 업무 위임·연결과 생활 기능의 실제 준비 조건을 이어 해결한다.\n`);
const evidence=['report.md','scope-audit.json','source.json','first.txt','regression.txt','final.txt','final-build.txt','final-contract.txt',
 'product.txt','product-r4.txt','product-r4/comparison.json','product-r4/replay-packet-projection.json','product-r4/cleanup.json'].map(s=>`${prefix}-${s}`);
write('attempt.json',{id:'plain-summary-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths:evidence,
 hypothesis:'지원하는 원문 선언 요약은 일반 한국어 한 문장으로 기본 자연어 계획/E/별도B/G/SQL에 연결하며 저장 뒤 실제 재검색·현재내용검사를 수행할 수 있다.',
 lesson:'실제 CoreHTTP 정상/하위2완료·충돌1쓰기0, 현재원문/결과중복음성, 완료재실행/스택재시작파일불변,185회귀/build/contract. 기존v9신원 유지. 공식V3-059 다섯 단계 완료.',
 limitations:'지원하는 명시적 UTF-8 텍스트/JSON 요약만. 일반 의미·모든 문서/계정/실기기/장기/설치본/독립전문가평가·총비용은 미검증. 공식58은 인수율.'});
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse(read(path)),gates=doc.stages.flatMap(s=>s.gates);
assert.equal(gates.filter(g=>g.status==='verified').length,57);
const gate=gates.find(g=>g.id==='V3-059');assert.equal(gate.requirement,audit.originalRequirement);assert.equal(gate.status,'in_progress');
gate.status='verified';gate.reviewedAt=observedAt;gate.evidence.push(...evidence);
const limits=['2026-10-07: 일반 한 문장 기본 자연어계획/CoreHTTP/별도PC B/G 현재내용·실제재검색/SQL재시작·185회귀로 원래다섯단계 인수완료. 명시적TXT/JSON 한정; 일반문서 의미·모든언어/파일·독립전문가·실계정/장기/설치본은 다른인수에서 미완료.'];
gate.limitations.push(...limits);(gate.reviewHistory??=[]).push({status:'verified',reviewedAt:observedAt,evidence,limitations:limits});
doc.updatedAt=observedAt;writeFileSync(path,JSON.stringify(doc,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 일반 한국어 한 문장 기본계획/실제CoreHTTP→별도B→G 현재원문/저장결과재발견/SQL재시작·185회귀/build/contract. 원래V3-059 다섯단계 verified→공식58. 다음 일반의미/위임·연결·생활기능 및 실제준비조건.\n`);
console.log(JSON.stringify({observedAt,verified:58,tests:185,scope:'five-stage-supported-default-natural-Mission'}));
