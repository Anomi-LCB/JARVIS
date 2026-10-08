import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runResearchLedger} from './research-ledger.mjs';
const prefix='artifacts/ollama-loopback-20261008',candidateId='local-ollama-mission-provider',observedAt=new Date().toISOString();
if(!runResearchLedger(['status']).candidates.some(c=>c.id===candidateId))throw Error('KNOWN_CANDIDATE_REQUIRED');
const write=(path,value)=>writeFile(path,typeof value==='string'?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const log=await readFile(prefix+'-regression.txt','utf8');
for(const marker of ['ℹ pass 74','ℹ fail 0','ℹ skipped 0','ℹ cancelled 0'])if(!log.includes(marker))throw Error('TEST_REQUIRED:'+marker);
if(!(await readFile(prefix+'-build.txt','utf8')).includes('Built static JARVIS executive console'))throw Error('BUILD_REQUIRED');
if(!(await readFile(prefix+'-contract.txt','utf8')).includes('gatePassed: true'))throw Error('CONTRACT_REQUIRED');
const comparison=JSON.parse(await readFile('artifacts/ollama-transport-comparison-20261008.json','utf8'));
if(comparison.results[0].code!=='UND_ERR_HEADERS_TIMEOUT'||comparison.results[1].code!==null)throw Error('COMPARISON_REQUIRED');
const sources=['packages/core/src/mission/ollama-loopback-transport.js','packages/core/src/mission/ollama-local-model-provider.js','packages/core/src/mission/local-model-observation.js','packages/core/src/mission/model-provider.js','tests/ollama-loopback-transport.test.js','tests/local-model-failure-observation.test.js'];
await write(prefix+'-source.json',await Promise.all(sources.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')}))));
await write(prefix+'-report.md',`# 로컬 모델의 숨은 전송 제한 제거와 오류 원인 기록\n\n관측 ${observedAt}. 공식 인수60/100 유지.\n\n앞선 실제 모델 요청2회는 각각303초 후 전송 실패했다. 원래 cause를 보존하지 않았으므로 원인을 소급 확정하지 않는다. 현재 Node24.8의 내장 Undici 소스에는 headers/body 기본 제한300000ms가 존재한다. 별도 소유 HTTP 서버에서 헤더를1500ms 지연하고 fetch의 헤더 한도를50ms로 줄인 실제 비교는 약${Math.round(comparison.results[0].elapsedMs)}ms 뒤 UND_ERR_HEADERS_TIMEOUT으로 실패했다. 같은 서버/호출자5000ms 기한에서 새 native HTTP는 약${Math.round(comparison.results[1].elapsedMs)}ms 뒤 정상 본문을 받았다. 이는 축소된 전송 메커니즘 재현이며 원래303초 오류의 확정 진단이나 모델 속도 비교는 아니다.\n\n제품의 로컬 Ollama 기본 경로만 node:http 전송으로 바꿨다. 정확한127.0.0.1:11434의 tags/generate 경로, GET/POST, JSON 헤더만 허용한다. 리디렉션/자격증명 헤더/공유 프록시 에이전트/임의 호스트는 허용하지 않는다. 호출자 취소와 기존 최대600초 제한이 헤더와 본문 수신 모두에 적용된다. 본문은 수신 중2MiB에서 차단하며 분할UTF8은 전체 수신 후 해독한다. 원격 제공자와 사용자 주입 fetch는 유지한다. 실패 원인은 승인된 원인 코드만 남기고 임의 오류 메시지·비밀정보·출력 원문은 진단에 넣지 않는다.\n\n**74개 고유 회귀 통과**, 실패/건너뜀/취소0. 실제 native HTTP 서버의 지연·취소·과대 본문·리디렉션·구조화 응답 검사와 기존 모델/실제 Mission 정책 경로 회귀를 포함한다. 여기서 HTTP 응답과 외부 제공자 응답은 합성 입력이며 실제 모델 의미 평가로 세지 않는다. build와API 계약 통과. 중간55검사 재실행은 합산하지 않는다.\n\n[Node24.8 HTTP 문서](https://nodejs.org/download/release/v24.8.0/docs/api/http.html)와 [Ollama 생성 API](https://docs.ollama.com/api/generate)를 대조했다. 생성은 여전히stream:false, num_predict384/num_ctx8192이고 실행 권한과 검증 기준은 바꾸지 않았다. 수정한 전송을 이용하는 동일한 원문·파일보존 오라클의 실제 gemma3 재실험은 artifacts/local-model-native-20261008에서 별도 관측한다. 이 보고서의74검사로 그 실험 성공을 주장하지 않는다. 개인 자료·실계정·유료 호출·설치본 활성화 없음. 기존 사용자 Ollama 종료/언로드/설정 변경 없음.\n\n연구watch→sync→status 순서 실행,6출처 중3변화/3동일/오류0. HTML 변화는 새 출시·기술가치로 판정하지 않았으며, 현재 실제 실패에 직접 관련된 HTTP/모델 공식 문서를 우선 검토했다. 다음은 별도 실제 모델 실험의 종료·토큰·정확한 실패 단계와 파일 상태 대조다. 전송 개선이 이해력·전체 속도·독립 의미평가 개선이라는 뜻은 아니다.\n`);
const evidencePaths=[prefix+'-report.md',prefix+'-regression.txt',prefix+'-build.txt',prefix+'-contract.txt',prefix+'-source.json','artifacts/ollama-transport-comparison-20261008.json','artifacts/ollama-node-default-deadlines-20261008.json'];
await write(prefix+'-attempt.json',{id:'ollama-loopback-20261008',candidateId,kind:'comparison',reportedOutcome:'passed',observedAt,
 hypothesis:'Caller-bounded native loopback HTTP can avoid a shorter shared fetch headers deadline without expanding execution scope.',
 lesson:'Scaled actual HTTP reproduces UND_ERR_HEADERS_TIMEOUT; dedicated transport succeeds under the same caller deadline. Diagnostics now retain allowlisted causes.',
 limitations:'74 regressions and scaled HTTP comparison; original 303-second cause not confirmed. Real model outcome is a separate experiment; no model quality or formal acceptance promotion.',evidencePaths});
console.log(JSON.stringify(runResearchLedger(['record',prefix+'-attempt.json'])));
const path='docs/universal-control-v3-acceptance.json',a=JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const gate=a.stages.flatMap(s=>s.gates).find(g=>g.id==='V3-022');
gate.evidence=[...new Set([...(gate.evidence??[]),...evidencePaths])];
gate.limitations=[...(gate.limitations??[]),'2026-10-08 loopback native 전송/원인코드 계측,74회귀·축소HTTP 비교/build/contract. 원래303초cause확정·모델실증·타제공자비교 미완료.'];
a.updatedAt=observedAt;await writeFile(path,JSON.stringify(a,null,2)+'\n');
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 숨은헤더기한 축소재현/native전송·원인기록/74회귀/build/contract. 공식60/100 유지. 동일실모델 재실험은 별도종료증거로 판단.\n`);
