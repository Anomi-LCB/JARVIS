import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const prefix='artifacts/archive-publication-20261007';
const read=p=>readFileSync(p,'utf8'),json=p=>JSON.parse(read(p));
const write=(name,value)=>writeFileSync(`${prefix}-${name}`,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx',flush:true});
const runner=json(`${prefix}-final-runner.json`), log=read(`${prefix}-final.txt`);
assert.equal(runner.status,'passed');
for(const [key,count]of [['tests',18],['pass',18],['fail',0],['skipped',0]]) assert.match(log,new RegExp(`ℹ ${key} ${count}(?:\\r?\\n|$)`));
assert.match(read(`${prefix}-build.txt`),/Built static JARVIS/);
assert.match(read(`${prefix}-contract.txt`),/gatePassed: true/);
const independent=json(`${prefix}-independent.json`);
assert.match(independent.latest,/5\/5 pass/);
const acceptancePath='docs/universal-control-v3-acceptance.json',acceptance=json(acceptancePath),gates=acceptance.stages.flatMap(s=>s.gates);
const verified=gates.filter(g=>g.status==='verified').length;
assert.equal(verified,60);
const observedAt=new Date().toISOString();
const runtime=read('apps/pc-agent/src/pc-agent-runtime.js');
write('source.json',{observedAt,adapter:runtime.slice(runtime.indexOf('export class ArchiveCreateZipToolAdapter'),runtime.indexOf('export class EmailSendToolAdapter')),
  files:['apps/pc-agent/src/adapters/archive/create_zip.py','tests/archive-publication.test.js'].map(path=>({path,sha256:createHash('sha256').update(readFileSync(path)).digest('hex'),content:read(path)}))});
write('report.md',`# ZIP 작성 중 원본·다른 작업 파일 보존 수정

관측 ${observedAt}. 초기9건 중8실패를 보존했고, 수정 후 신규13건과 기존5건 합계18/18·실패0·skip0, build/Core 계약 통과. 독립 검토는 동일3반례와 실제 ZIP 재조회/발행 후 기록 실패5/5이며18건에 합산하지 않는다. 공식 인수60/100 유지.

## 실제 결함과 수정

사전 검사 뒤 같은 출력경로에 다른 파일이 생기면 Python w 모드가 그 파일을 덮어쓰던 결함, Python 실패 시 catch가 다른 작업 파일까지 삭제하던 결함, 입력 해시를 계산한 뒤 바뀐 내용을 성공 ZIP으로 기록하던 결함을 임시 실제 파일로 재현했다. 동일 부모의 고유 staging에 입력 snapshot과 ZIP만 만들고, 최종파일은 배타적인 hard link로 발행한다. 실패 정리는 이 호출이 만든 staging에 한정하며 최종파일을 무조건 삭제하지 않는다.

입력은 허용경로·열린 파일 identity/버전·내용 SHA256를 검사한다. Python은 staging input만 읽고 입력 해시를 확인한 뒤 ZIP을 다시 열어 entry별 실제 해시를 계산한다. JS는 원래 이름/해시/개수를 대조하고 발행 전 원본을 재조회한다. 한글 entry의 Windows stdout 인코딩 불일치도 UTF-8로 수정했다. 위험한 entry 경로와 중복 이름을 차단한다. 발행 후 undo 기록 실패는 파일을 보존하고 failed/uncertain 출력 경로를 알린다.

Python의 w는 truncate, x는 배타 생성이라는 [공식 zipfile 문서](https://docs.python.org/3/library/zipfile.html)와 [Node 파일 link API](https://nodejs.org/api/fs.html#fspromiseslinkexistingpath-newpath)를 대조했다. 최신 라이브러리 전체 성능을 비교한 실험은 아니다.

## 검증 범위와 한계

실제 로컬 Python ZIP 생성/재조회, 한글 이름, 경합 출력 보존, 실패 cleanup, 입력 변경, hash 불일치, 위험 경로/중복, 발행 후 undo 실패를 검사했다. 기존 PNG/OCR/메일 회귀의 메일은 합성 SMTP이며 외부 발송0이다. 사용자 파일·개인계정·운영DB·F/cognition은 사용하지 않았다. 입력당128MiB, 합계512MiB를 초과하면 명시적으로 실패/차단한다. 대용량 streaming 지원은 별도다. 전체 테스트 ${runner.durationMs}ms는 제품 p50/p95가 아니다. 외부 모델 호출0, 전체 로컬 비용 미측정이다.

SQL Mission effect·원래 operationId·영속 B claim·강제 종료 복구·Core authority 통합은 아직 archive에 연결하지 않았다. 부모 디렉터리의 악의적인 교체나 staging을 다른 프로세스가 변조하는 OS 경합 전체도 미검증이다. 입력이 최종 재조회 직후 변경될 때까지 영구적인 불변성을 주장하지 않는다. 운영 서비스/설치 EXE에는 이번 소스를 활성화하지 않았다.

다음 작업은 이 안전한 발행 경로를 기존 artifactPlan 및 SQL effect/영수증 복구에 연결하고 두 워커 경합·응답 손실을 검증하는 것이다. 복원은 보존 source snapshot과 adapter/worker를 비교해 좁게 되돌리며 사용자 원장이나 기존 증거를 삭제하지 않는다.
`);
const evidencePaths=['report.md','source.json','baseline.txt','baseline-runner.json','final.txt','final-runner.json','build.txt','contract.txt',
 'independent.md','independent.json','independent-final.txt','independent-initial-compact.txt','independent.test.mjs'].map(n=>`${prefix}-${n}`);
write('attempt.json',{id:'archive-publication-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'고유 staging/snapshot과 배타 발행으로 ZIP 경합 덮어쓰기·foreign file 삭제·입력 내용 바뀜의 잘못된 성공을 막을 수 있다.',
 lesson:'사전 targetExists와 ZIP CRC만으로 원본 계약/소유권을 보장할 수 없다. 실제 발행과 내용 해시를 결속해야 한다.',
 limitations:'18/18+독립5/5/build/contract. common SQL/effect/claim/restart와운영활성화/hostile filesystem 미완료. 공식60 유지, 비용 미측정.'});
const gate=gates.find(g=>g.id==='V3-040');assert.equal(gate.status,'in_progress');gate.evidence.push(...evidencePaths);
gate.limitations.push('archive ZIP 실제 경합 덮어쓰기/foreign삭제/입력변경3결함 수정,18/18+독립5/5. SQL common effect/claim/restart 통합은 여전히 미완료.');
acceptance.updatedAt=observedAt;writeFileSync(acceptancePath,JSON.stringify(acceptance,null,2)+'\n');
appendFileSync('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: ZIP 경합 덮어쓰기/foreign삭제/입력변경3결함·snapshot/staging/배타link·실제ZIP/한글/18회귀·독립5·build/contract. 공식60·운영활성화0. 다음 archive artifactPlan/SQL effect/claim/restart 연결.\n`);
console.log(JSON.stringify({observedAt,verified,tests:18,attempt:`${prefix}-attempt.json`}));
