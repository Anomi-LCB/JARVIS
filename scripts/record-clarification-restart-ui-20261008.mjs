import {readFile,writeFile,appendFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const prefix='artifacts/clarification-restart-ui-20261008',observedAt=new Date().toISOString();
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/u,''));
const modes=['normal','deferred','revision','crash'],rows=[];
for(const mode of modes){const path=prefix+'-final-'+mode+'/result.json',result=await json(path);
 if(result.views.length!==2)throw Error('VIEWS_REQUIRED');
 for(const view of result.views){const h=view.processHistory;if(!view.actualCorePidRestart||view.status!=='COMPLETED'||view.reads!==1||view.writes!==1||view.answerRequests!==1||view.pageErrors.length||view.horizontalOverflowPx||!view.reloadNoExecution)throw Error('RESTART_RESULT_REQUIRED');
  if(h.length!==(mode==='deferred'?4:3)||new Set(h.map(x=>x.pid)).size!==h.length||new Set(h.map(x=>x.keySha256)).size!==1||h.some((x,i)=>x.token!==i+1))throw Error('PID_FENCE_KEY_REQUIRED');
  if(mode==='crash'){const failed=view.failedTakeovers?.[0];if(!view.actualCrash||view.failedTakeovers.length!==1||failed.code!=='A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE'||!failed.beforeExpiry
   ||Date.parse(failed.refusedAt)>=Date.parse(failed.leaseExpiresAt)||Date.parse(h[1].readyAt)<Date.parse(failed.leaseExpiresAt))throw Error('CRASH_FENCE_REQUIRED');}
  if(mode==='deferred'&&!view.answerStoredBeforeRestart||mode==='revision'&&!view.revisionDraftCleared)throw Error('SCENARIO_REQUIRED');
  rows.push({mode,...view});
 }
}
const tests=await readFile(prefix+'-tests.txt','utf8');for(const marker of ['ℹ pass 99','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!tests.includes(marker))throw Error('TEST_REQUIRED:'+marker);
if(!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
await writeFile(prefix+'-verified-summary.json',JSON.stringify({observedAt,rows,successfulCoreStarts:rows.reduce((n,r)=>n+r.processHistory.length,0),rejectedCoreStarts:2,
 scope:'Actual separate configured Core PIDs, real SQLite/DPAPI/fencing/file reads/writes, real Chrome UI, scripted planner; no SCM/reboot/real account or installed application.',
 rawScopeCorrection:'Raw result.json inherited the prior non-restart fixture scope sentence. Actual PID history, scenario flags and timestamps establish separate PID restart; originals remain unchanged. The script scope sentence is corrected for future runs.',cost:null,costStatus:'미측정'},null,2)+'\n',{flag:'wx'});
const sources=['tests/fixtures/clarification-restart-core.mjs','tests/fixtures/clarification-restart-browser.mjs','scripts/clarification-live-browser-qa.py','scripts/record-clarification-restart-ui-20261008.mjs','scripts/core-service-runtime.mjs','packages/core/src/mission/mission-runtime.js','packages/core/src/mission/sqlite-mission-store.js','packages/core/src/mission/mission-execution-authority.js','src/ui/workspace/app.js','src/ui/mission-goal-editor.js','src/ui/workspace/clarification-drafts.js'];
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2)+'\n',{flag:'wx'});
const acceptance='docs/universal-control-v3-acceptance.json',doc=await json(acceptance),gates=doc.stages.flatMap(s=>s.gates),counts=Object.fromEntries(['verified','in_progress','pending'].map(status=>[status,gates.filter(g=>g.status===status).length]));
await writeFile(prefix+'-report.md',[
 '# 묶음 질문과 실제 Core 프로세스 재시작 복구',
 `관측 ${observedAt}. 공식 인수 ${counts.verified}/100 유지. 기존 V3-020/047에 부분 증거를 추가했다.`,
 '## 실제 검증',
 '격리 production-mode Core를 별도 Node PID로 구동하고 감독 프로세스와 밝은 기본 UI는 유지했다. Core만 종료·복원하므로 browser reload와 다른 시험이다. 실제 SQLite 원장·30초 권위 lease·DPAPI 보호키·Core/E/PC/G·파일·Chrome 화면을 사용했으며 계획기와 자료만 합성이다. API 응답이나 renderer를 가로채지 않았다. 정상 대기 복원, 답변 저장 후 실행 전 복원, 목표 정정, 강제 종료를 PC1440·모바일390 각각 관측한 최종8흐름이다.',
 '정상은 질문 대기 상태에서 새 PID로 복원한 뒤 답변하고 완료했다. deferred는 먼저 실제 인증 HTTP로 답변을 저장하되 resume:false를 사용해 PAUSED·작성0을 확인하고, 또 다른 PID에서 저장된 gate/답변을 그대로 조회한 뒤 UI 재개로 완료했다. 정정은 이전 답변 초안을 제거하고 원래 verificationSpec을 보존하는 기준 확인과 revision3를 거쳤다. 각 흐름은 답변POST1회·독립 읽기 dispatch1회·작성 dispatch1회이며 실제 결과 파일 내용도 대조했다. 완료 후 한 번 더 Core를 복원하고 browser reload해도 추가 실행0이다.',
 '강제 종료는 close 훅 없이 해당 격리 Core PID를 kill했다. 새 Core의 즉시 인계 시도2회는 실제 A_CORE_AUTHORITY_ANOTHER_CORE_ACTIVE로 거부됐다. 정상30초 lease를 단축하거나 검사·시계를 우회하지 않았다. 관측한 expiresMs까지 기다린 뒤 새 PID가 token2로 획득했고 완료 뒤 token3로 다시 복원했다. 거절 시각<lease만료시각≤새PID준비시각을 독립 대조했다. 모든 흐름의 PID는 서로 다르고 token은1씩 증가하며 보호key 파일 SHA-256은 동일하다.',
 '최종 성공한 Core 시작26회와 만료 전 거절2회다. 앞선 중간/초기 반복은 합산하지 않았다. 기본 의미 해석 능력이나 모든 강제 종료 구간을 검증한 횟수가 아니다. 일반 읽기/쓰기 중 crash 또는 불명 외부 효과는 이 결과의 범위에 포함되지 않는다.',
 '## 코드·회귀·증거 보존',
 'Core worker와 감독/UI harness를 추가하고 기존 브라우저 검사에 restart·deferred·crash 모드를 연결했다. 감독 프로세스는 종료를 확인한 다음 같은 Core 포트·원장을 사용하며 IPC observe 리스너를 응답 뒤 정리한다. 이번에는 새로운 제품 결함이 재현되지 않아 생산 실행 코드를 임의로 바꾸지 않았다. 관련10파일 고유99검사 통과·실패0·skip0·cancel0, build/Core 계약 통과. Node 검사99와 UI8흐름 및28 Core 시작 시도는 서로 다른 증거로 집계한다.',
 '원시 result.json의 공통 scope 설명에 이전 단일PID 시험 문구가 남아 있었음을 발견했다. PID 이력·실제 시각·scenario flag를 대조한 verified-summary.json에서 범위를 바로잡았으며 원본은 덮어쓰지 않았다. 이후 script가 restart 여부에 맞는 설명을 생성하도록 수정했다. 이는 시험 설명 수정이며 제품 복구 결함 수정으로 계산하지 않는다. 앞선 source snapshot도 그대로 보존한다.',
 '## 한계·다음 인수',
 '감독 서버는 격리 시험 도구이며 실제 Windows SCM·재부팅·서비스계정·다른PC·클라우드 failover·실계정·유료 모델을 시험하지 않았다. 정상 결과의 과거 완료 기록을 복원했고 시험 harness가 현재 파일 내용도 읽어 대조했지만, 일반 파일 변조에 대한 현재 Core 완료 재감사를 주장하지 않는다. 원래 일반 질문 필요성·독립 의미 평가·설치본 반영·장기 개입률은 남아 있다. 비용과 제품 p50/p95는 미측정이다. 개인 F/cognition 및 운영 서비스·계정·권한을 변경하지 않았고 helper는 모두 종료했다.',
 '다음은 V3-020의 결과를 바꾸는 질문인지 판단하는 근거와 V3-024 독립 의미 평가의 남은 실패를 연결하는 작업이다. 설치/SCM가 없는 모의 또는 PID 증거로 V3-047 전체를 완료하지 않는다. 복원은 새 테스트 harness를 실행하지 않고 기존 제품을 유지하면 되며 이번 작업은 운영 원장·private key를 이전하지 않았다.'
].join('\n\n')+'\n',{flag:'wx'});
const evidencePaths=['-report.md','-source.json','-verified-summary.json','-tests.txt','-build.txt','-contract.txt',...modes.map(m=>'-final-'+m+'/result.json'),...modes.map(m=>'-final-'+m+'.txt')].map(s=>prefix+s);
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'clarification-restart-ui-20261008',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,evidencePaths,
 hypothesis:'실제 Core 프로세스를 교체해도 같은 Mission·질문·정정·보호키·권한을 보존하고 중복 파일 dispatch 없이 UI에서 이어갈 수 있다.',
 lesson:'브라우저 reload와 Core PID 복원은 다른 증거다. 강제 종료 뒤 lease 만료 전 인계를 거절하고 새 token으로 복원하는 경로를 실제 관측해야 한다.',
 limitations:'실제UI8흐름/26성공Core시작+2만료전거절/99관련검사. scripted계획·합성파일,SCM/재부팅/설치본/불명외부효과/일반의미/장기관측 미완료. 공식60/100 유지·비용/제품지연 미측정.'},null,2)+'\n',{flag:'wx'});
for(const id of ['V3-020','V3-047']){const gate=gates.find(g=>g.id===id);gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];gate.limitations.push('2026-10-08: 실제Core PID 질문대기/답변저장/정정/crash 복원UI8흐름,26성공시작/만료전거절2/99검사. 동일Mission/권한/DPAPIkey/token+1/읽기작성각dispatch1. SCM/재부팅/설치본/일반의미/장기관측 미완료.');}
doc.updatedAt=observedAt;await writeFile(acceptance,JSON.stringify(doc,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 실제Core 별도PID 질문대기/답변저장/정정/crash 복원UI8흐름,26성공시작+2거절/99검사. 공식 ${counts.verified}/100 유지. 다음 V3-020 질문필요성 근거와 V3-024 독립 의미 실패 연결.\n`);
console.log(JSON.stringify({counts,nodeTests:99,browserFlows:8,successfulCoreStarts:26,rejectedCoreStarts:2}));
