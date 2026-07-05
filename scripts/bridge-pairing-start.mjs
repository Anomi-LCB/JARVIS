// Starts a bridge pairing session and prints the code the phone needs.
// Usage: npm run bridge:pair
const port = Number(process.env.JARVIS_BRIDGE_PORT ?? 17777);
const url = `http://127.0.0.1:${port}/pairing/start`;

const response = await fetch(url, { method: 'POST' });
if (!response.ok) {
  console.error(`Bridge pairing failed: HTTP ${response.status}. Is the JarvisBridge task running?`);
  process.exit(1);
}
const pairing = await response.json();
const expiresInMin = Math.round((pairing.expiresInMs ?? 0) / 60000);

console.log('# JARVIS 페어링 세션');
console.log(`브리지 주소  : ${pairing.bridgeUrl}`);
console.log(`페어링 코드  : ${pairing.pairingCode}`);
console.log(`유효 시간    : ${expiresInMin}분 (${pairing.expiresAt})`);
console.log(`QR 텍스트    : ${pairing.qrPayload?.qrText ?? '-'}`);
console.log('');
console.log('폰의 JARVIS 앱 → 페어링 화면에서 위 브리지 주소와 코드를 입력하세요.');
