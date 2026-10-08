import { resolveProductRuntimeSecrets } from '../packages/shared/src/product-runtime-secrets.js';

try {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/cognitive-status.mjs [--json]\n인증된 로컬 Core의 자기 상태·주의·검증 경험을 조회합니다.');
  } else {
    if (args.some(arg => arg !== '--json')) throw new Error('지원하지 않는 인자입니다.');
    const url = new URL('/cognition', process.env.JARVIS_CORE_API_URL ?? 'http://127.0.0.1:4071');
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('로컬 Core 주소만 사용할 수 있습니다.');
    const { coreToken } = resolveProductRuntimeSecrets();
    const response = await fetch(url, { headers: { Authorization: `Bearer ${coreToken}` }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Core 인지 상태를 조회하지 못했습니다 (HTTP ${response.status}).`);
    const state = await response.json();
    if (args.includes('--json')) console.log(JSON.stringify(state, null, 2));
    else if (state.available === false) console.log('현재 Core에는 인지 상태 모듈이 연결되지 않았습니다.');
    else console.log([
      `JARVIS 자기 상태 · ${state.identity.id}`,
      `기억 저장: ${state.storage.persistent ? '영속 저장' : '세션 전용'} / ${state.storage.status}`,
      `검증된 최근 경험: ${state.memory.episodeCount ?? '조회 실패'}건`,
      `성장 저장소: ${state.memory.growth?.configured ? '연결됨' : '미연결'}`,
      `주의 대상: ${state.attention.focus.length}개 / 최대 ${state.attention.limit}개`,
      ...state.attention.focus.map(goal => `- ${goal.tool ?? '도구 미확정'} · ${goal.status} · ${goal.reason}`),
      '이는 기능적 자기모델의 상태이며, 주관적 의식의 발생 여부는 확인되지 않았습니다.'
    ].join('\n'));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
