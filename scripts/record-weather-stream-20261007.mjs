import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/weather-stream-20261007',observedAt=new Date().toISOString();
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['apps/pc-agent/src/adapters/weather/open-meteo-weather.js','tests/weather-response-limit.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 날씨 응답 수신 중 크기 제한

관측 ${observedAt}. 공식60/100 유지. 운영서비스 재시작·설치본 적용0.

기존1MiB 제한은 response.text() 이후에만 검사했다. 기준선3중2실패/1통과: 스트림을 전체 text로 읽으려 했고 실제 로컬 HTTP의1MiB 초과·미종료 본문을 size오류로 중단하지 못해 timeout으로 끝났다. 한글 분할 청크 양성은 통과했다.

실제 Response.body reader로 바이트를 누적 검사하고1MiB 초과 청크는 저장하지 않는다. 초과 즉시 요청 controller를 abort하고 reader를 cancel한 뒤 lock을 해제한다. 정상 청크는 전체 바이트를 결합한 후 UTF-8 해석해 청크 경계에서 한글이 깨지지 않게 했다. 기존 취소·요청별timeout 분류를 유지한다. stream 없는 기존 합성 transport는 text 이후 같은 크기 검사 경로를 유지한다.

최종27/27 실패0/skip0. 새5건: 정확히1MiB 정상 JSON,1바이트 초과 거부, 종료 없는 reader 초과/cancel, 한글 중간 바이트 분할, 실제 로컬 HTTP chunked 과대·미종료 응답을 timeout 전에 size오류로 중단. 기존 네트워크 취소6·날씨 계약16도 통과했다. build/core:contract-gate exit0. 중간25건 검사와 최종을 중복 합산하지 않는다. 테스트 시간은 제품의 일반p50/p95 결과가 아니다.

비용 미측정. 외부 날씨 API·유료 호출·실계정·발송0. 실제 F/cognition 기억에 합성 성공을 저장하지 않았다. 이 개선은 bounded collector이며 프로세스 전체 메모리 상한의 증거가 아니다. fetch/OS 버퍼와 현재 전달 청크는 별도 메모리를 사용하고 Buffer.concat시 복사도 발생한다. stream 없는 transport는 사후 검사이며 비표준 reader.cancel()이 영원히 반환하지 않는 경우까지 강제 종료하지 않는다. 전체 geocode+forecast 총기한/common SQL effect/native HWP 실사용·설치본 적용은 미완료다.

다음은 예보 스냅샷·원래문서 binding/common effect·재시작 검증과 원래100개 인수를 이어 진행한다. 복원은 readBoundedWeatherText 호출을 이전 text 경로로 복원하고 helper를 제거하는 소스 복원이며 증거는 보존한다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'weather-stream-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'응답 스트림의 수신 바이트 제한과 취소를 연결하면 EOF 없는 과대응답을 timeout 이전에 차단하고 정상 한글 응답을 보존할 수 있다.',lesson:'전체 text 이후 크기 검사는 네트워크 수신 제한이 아니다. 실제 미종료 HTTP와 바이트 경계 양성을 확인해야 한다.',limitations:'27/27·로컬실HTTP, 전체 메모리상한/외부제공자/총기한/SQL/설치활성화 미완료·공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: weather 수신중1MiB 제한·actual HTTP 미종료 과대응답 차단·한글/정확한경계/취소 보존·27/27/build/contract. 공식60·운영활성화0. 다음 weather 예보스냅샷/commonSQL 및 원래100인수.\n`);
