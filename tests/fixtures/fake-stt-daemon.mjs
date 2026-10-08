import { createInterface } from 'node:readline';

let sequence = 0;
console.log(JSON.stringify({ type: 'ready' }));
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  sequence += 1;
  console.log(JSON.stringify({
    requestId: request.requestId,
    transcript: `daemon-${sequence}`,
    confidence: 0.9
  }));
});
