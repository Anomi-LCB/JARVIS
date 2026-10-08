import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/lifecycle-case-verdict-binding-20261008',observedAt=new Date().toISOString();
const read=p=>readFile(p,'utf8');
const log=await read(prefix+'-regression.txt');
if(!log.includes('ℹ pass 102')||!log.includes('ℹ fail 0')||!log.includes('ℹ skipped 0'))throw Error('regression required');
if(!(await read(prefix+'-build.txt')).includes('Built static JARVIS')||!(await read(prefix+'-contract.txt')).includes('gatePassed: true'))throw Error('build contract required');
const status=runResearchLedger(['status']);
const candidates=status.candidates??[];
const issues=candidates.flatMap(c=>(c.attempts??[]).flatMap(a=>(a.evidence??[]).filter(e=>e.integrity!=='intact'||['changed','missing'].includes(e.sourceIntegrity)).map(e=>({candidateId:c.id,attemptId:a.id,path:e.path,integrity:e.integrity,sourceIntegrity:e.sourceIntegrity}))));
await writeFile(prefix+'-ledger-summary.json',JSON.stringify({observedAt,candidateCount:candidates.length,reasons:Object.fromEntries([...new Set(candidates.map(c=>c.nextReason))].map(r=>[r,candidates.filter(c=>c.nextReason===r).length])),evidenceIssueCount:issues.length,relevantIssues:issues.filter(i=>i.candidateId==='agent-platform-observed-scenario-status'),boundaries:status.boundaries},null,2),{flag:'wx'});
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['packages/core/src/mission/lifecycle-case-result.js','tests/lifecycle-case-mission.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 생활 업무 Mission의 독립 검증 판정 결속 수정

관측 ${observedAt}. 감시 출처 6곳은 변화·오류 없이 유지됐다. 장부 sync/status와 최신 구현 보고서를 검토하고 기존 선택 생활 기록 Mission의 반례를 추가했다.

실제 발견: Core task의 전체 검증 상태가 failed이거나 taskId/verificationId가 다른 값으로 변해도, 기존 critical 검사 한 개가 passed이면 현재 결과를 verified로 공개했다. 첫 실행에서 이 세 반례가 모두 실패했다. 이는 내부 기록 간 불일치에 대한 결함이며 외부 공격이나 실제 공급자 사고가 관측됐다는 뜻은 아니다. first.txt의 실패를 보존했다.

수정: 최종 결과 오라클은 전체 G status passed, G taskId와 현재 task의 일치, G verificationId와 Mission observation의 일치, failed 검사 없음, 기존 critical 검사 통과를 모두 요구한다. 현재 Core 기록과 권한을 다시 확인하는 기존 절차를 유지했다. 추가로 status는 passed지만 실패한 개별 검사가 남은 반례도 결과를 공개하지 않는다. 오류 결과에 기록 내용은 포함하지 않는다.

최종 공유 회귀 102/102, 실패0·생략0. 실제 임시 Core/E/B/G Mission과 인증 HTTP의 양성 경로도 유지했다. build/Core contract gate 통과. 임시 DB·합성 자료만 사용했고 운영 F/cognition·실계정·기기·서비스 재시작은 변경하지 않았다. UI 변경은 없어 새 브라우저 검사를 성과로 기록하지 않는다. 유료 모델/공급자 호출0, 실사용 비용 및 p50/p95는 미측정이다.

이 기록은 기존 보고서의 정정 보완이다. 파일 해시는 증거 보존만 확인하며 평가 결론의 독립 검증이나 제품 활성화를 뜻하지 않는다. sourceIntegrity가 달라진 과거 증거는 원본 불변 스냅샷과 현재 원본을 구분해야 한다. 세 반례의 해결은 전체 자연어·배송·환불·행정의 실연동 완료가 아니다.

공식 인수 60/23/17 유지. 남은 작업은 선택 업무의 밝은 Mission 요청/현재 결과 UI, 재시작·새 세션 증거 회수, 검토된 운영 접근 활성화와 실제 공급자 관측이다. 복원은 이번 오라클 조건과 추가 네 반례를 함께 되돌리는 좁은 변경이며 원장과 이전 증거는 보존한다.
`,{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-ledger-summary.json','-first.txt','-focused.txt','-regression.txt','-build.txt','-contract.txt'].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'lifecycle-case-verdict-binding-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,hypothesis:'전체 G 판정과 task/verification 식별자를 Mission observation에 결속하면 일부 passed 검사로 불일치한 현재 결과를 공개하지 않는다.',lesson:'critical 검사 하나의 성공으로 전체 독립 검증 판정을 대신할 수 없다. 첫 실패 세 건을 보존하고 전체 상태/식별자/실패 검사 유무를 함께 검사했다.',limitations:'로컬 선택 기록 Mission·합성 임시 DB 반례와102공유회귀. 실제 공급자/운영 설치본/일반 자연어 완료 아님. 비용/지연미측정, 공식60%유지.'},null,2),{flag:'wx'});
const path='docs/universal-control-v3-acceptance.json',doc=JSON.parse((await read(path)).replace(/^\uFEFF/u,'')),gates=doc.stages.flatMap(s=>s.gates);
if(gates.length!==100||gates.filter(g=>g.status==='verified').length!==60)throw Error('acceptance changed');
for(const id of ['V3-041','V3-077']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: G 전체판정/taskId/verificationId/실패검사 결속 누락3반례 재현·수정,102회귀/build/contract. 실공급자/운영 활성화 완료 아님.');}
doc.updatedAt=observedAt;await writeFile(path,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 최종결과 G 전체판정·task/verification ID 결속누락3실패 수정+실패검사반례,102회귀/build/contract. 공식60/23/17 유지. 다음 선택Mission UI와 재시작/새세션 경계.\n`);
