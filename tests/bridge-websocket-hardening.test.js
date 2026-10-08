import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeClientWebSocketFrames,
  maximumBridgeWebSocketFrameBytes
} from '../apps/bridge/src/main.mjs';

function encodeClientFrame(value, {
  masked = true,
  final = true,
  opcode = 0x1
} = {}) {
  const payload = Buffer.from(String(value), 'utf8');
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  const header = Buffer.from([
    (final ? 0x80 : 0) | opcode,
    (masked ? 0x80 : 0) | payload.length
  ]);
  if (!masked) return Buffer.concat([header, payload]);
  const encoded = Buffer.from(payload);
  for (let index = 0; index < encoded.length; index += 1) {
    encoded[index] ^= mask[index % mask.length];
  }
  return Buffer.concat([header, mask, encoded]);
}

test('bridge WebSocket decoder accepts bounded masked client JSON frames', () => {
  const parsed = decodeClientWebSocketFrames(encodeClientFrame('{"type":"ping"}'));
  assert.equal(parsed.error, null);
  assert.equal(parsed.frames.length, 1);
  assert.equal(parsed.frames[0].opcode, 0x1);
  assert.equal(parsed.frames[0].text, '{"type":"ping"}');
  assert.equal(parsed.remaining.length, 0);
});

test('bridge WebSocket decoder rejects unmasked, fragmented, and unsupported client frames', () => {
  const unmasked = decodeClientWebSocketFrames(encodeClientFrame('{}', { masked: false }));
  assert.equal(unmasked.error.code, 'D_WEBSOCKET_CLIENT_FRAME_UNMASKED');
  assert.equal(unmasked.closeCode, 1002);

  const fragmented = decodeClientWebSocketFrames(encodeClientFrame('{}', { final: false }));
  assert.equal(fragmented.error.code, 'D_WEBSOCKET_FRAGMENT_UNSUPPORTED');
  assert.equal(fragmented.closeCode, 1002);

  const binary = decodeClientWebSocketFrames(encodeClientFrame('{}', { opcode: 0x2 }));
  assert.equal(binary.error.code, 'D_WEBSOCKET_OPCODE_UNSUPPORTED');
  assert.equal(binary.closeCode, 1003);
});

test('bridge WebSocket decoder rejects an oversized frame from its header before buffering payload', () => {
  const declaredLength = maximumBridgeWebSocketFrameBytes + 1;
  const header = Buffer.alloc(14);
  header[0] = 0x81;
  header[1] = 0xff;
  header.writeBigUInt64BE(BigInt(declaredLength), 2);
  header.writeUInt32BE(0x11223344, 10);

  const parsed = decodeClientWebSocketFrames(header);
  assert.equal(parsed.error.code, 'D_WEBSOCKET_FRAME_LIMIT_EXCEEDED');
  assert.equal(parsed.closeCode, 1009);
  assert.equal(parsed.frames.length, 0);
});
