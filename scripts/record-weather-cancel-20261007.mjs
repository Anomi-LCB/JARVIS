import {readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const prefix='artifacts/weather-cancel-20261007',observedAt=new Date().toISOString();
await writeFile(prefix+'-source.json',JSON.stringify({observedAt,sources:await Promise.all(['apps/pc-agent/src/adapters/weather/open-meteo-weather.js','apps/pc-agent/src/pc-agent-runtime.js','tests/weather-cancellation.test.js'].map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})))},null,2),{flag:'wx'});
await writeFile(prefix+'-report.md',`# 날씨 네트워크 취소와 대기열 복구

관측 ${observedAt}. 공식60/100 유지. 설치본 적용·서비스 재시작0.

이전 wrapper context 수정 이후 실제 OpenMeteoWeatherClient는 호출자 signal을 받지 않았다. 기준선2건 모두 실패: 사전 취소에도 조회, 한국 지역 검색 취소 후 다른 공급자 재시도. 기존 자체 요청 시간 제한은 있었지만 사용자 취소와 연결되지 않았다.

weeklyForecast/geocode/forecast/fetchJson에 signal을 전달했다. 로컬 좌표·캐시를 포함해 시작과 반환 경계에서 취소를 검사한다. 한국 지역 검색 취소는 fallback으로 삼키지 않는다. 요청별 AbortController에 호출자 취소를 연결하고 listener/timer를 finally에서 제거한다. 사용자 취소는 B_OPERATION_CANCELLED, 기존 요청 시간 제한은 B_WEATHER_UPSTREAM_TIMEOUT으로 구분한다. 날씨 wrapper는 취소를 blocked로 표시하고 문서를 만들지 않는다.

Nominatim 예약 대기 및 최소간격 대기도 취소 가능하게 했다. 앞선 예약 대기 중 취소된 요청은 즉시 반환하되 다음 예약이 앞선 예약을 추월하지 않도록 release를 앞선 완료에 연결한다. 기존 공급자 간격을 느슨하게 만들지 않았다.

최종22/22, 실패0/skip0: 새6건과 기존 날씨16건. 새 검사에는 실제 fetch와 로컬 HTTP 서버에서 헤더 이후 본문을 무기한 중단한 상태의 사용자 취소·1초 timeout2건을 포함한다. 외부 제공자 호출이 아니며 전체 지연p50/p95를 측정한 것은 아니다. 큐 취소 이후 release와 기존 양성 예보/구조화 문서/계획도 검사했다. build 및 core:contract-gate exit0. 비용 미측정, 유료 호출/실계정/외부 발송0, 실제 F/cognition 기억에 합성 성공을 저장하지 않았다.

한계: 요청별 timeout이며 전체 geocode+forecast 하나의 총기한 계약은 아니다. signal을 무시하는 비표준 fetchImpl까지 강제 종료하지 않는다. 응답 text 읽기는 기존1MiB 사후 크기 검사로, 스트리밍 메모리 제한은 별도 작업이다. 권한 철회 자체가 항상 AbortSignal로 변환되는 전체 runtime 경로도 별도 인수다. 실제 날씨 공급자/native Hancom/SQL effect/설치EXE 적용을 완료했다고 해석하지 않는다.

다음은 weather 원문·예보 스냅샷·HWP 전체 common effect와 실제 복구, macro 저장 및 남은100개 인수를 이어 진행한다. 복원은 이번 signal 인수/대기 helper/취소 코드 전달을 이전 구현으로 되돌리는 소스 복원이며 테스트·증거는 보존한다.
`,{flag:'wx'});
await writeFile(prefix+'-attempt.json',JSON.stringify({id:'weather-cancel-20261007',candidateId:'agent-platform-observed-scenario-status',kind:'workflow-test',reportedOutcome:'passed',observedAt,hypothesis:'호출자 취소를 예보 HTTP와 지역 검색 예약까지 전달하면 취소된 작업의 불필요한 대기·fallback을 중단하면서 공급자 간격과 정상 결과를 유지할 수 있다.',lesson:'게시 직전 취소 검사만으로 네트워크 작업의 즉시 중단을 증명할 수 없다. 실제 stalled HTTP body와 큐 취소를 별도로 확인해야 한다.',limitations:'22/22·로컬실HTTP2건, 외부공급자/native렌더/총기한/SQL/설치활성화 미완료. 공식60유지·비용미측정.',evidencePaths:['-report.md','-source.json','-baseline.txt','-focused.txt','-final.txt','-build.txt','-contract.txt'].map(s=>prefix+s)},null,2),{flag:'wx'});
await appendFile('docs/execution-to-100.md',`\n최신 ${prefix}-report.md: 날씨HTTP/지역검색/예약 signal 전달·fallback 취소보존·실stalled본문 취소/timeout·22/22/build/contract. 공식60·운영활성화0. 다음 weather commonSQL·총기한/스트리밍과 원래100인수.\n`);
