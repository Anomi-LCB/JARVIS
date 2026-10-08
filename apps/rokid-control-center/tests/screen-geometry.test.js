import test from 'node:test';
import assert from 'node:assert/strict';
import { mapViewPointToDevice, screenViewDimensions } from '../src/public/screen-geometry.js';

test('480×640 원본의 중앙 광학 HUD를 회전 없이 640×480 가로 보기로 표시한다', () => {
  assert.deepEqual(screenViewDimensions(480, 640, 'hud-landscape'), { width: 640, height: 480 });
  assert.deepEqual(screenViewDimensions(480, 640, 'portrait'), { width: 480, height: 640 });
});

test('HUD 가로 보기의 모서리와 중앙을 원본 중앙 480×360 영역으로 되돌린다', () => {
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 0, normalizedY: 0, rawWidth: 480, rawHeight: 640, orientation: 'hud-landscape' }), { x: 0, y: 140 });
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 1, normalizedY: 0, rawWidth: 480, rawHeight: 640, orientation: 'hud-landscape' }), { x: 479, y: 140 });
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 0, normalizedY: 1, rawWidth: 480, rawHeight: 640, orientation: 'hud-landscape' }), { x: 0, y: 499 });
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 0.5, normalizedY: 0.5, rawWidth: 480, rawHeight: 640, orientation: 'hud-landscape' }), { x: 240, y: 320 });
});

test('전체 원본 보기의 클릭 좌표는 회전하지 않는다', () => {
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 0, normalizedY: 0, rawWidth: 480, rawHeight: 640, orientation: 'portrait' }), { x: 0, y: 0 });
  assert.deepEqual(mapViewPointToDevice({ normalizedX: 1, normalizedY: 1, rawWidth: 480, rawHeight: 640, orientation: 'portrait' }), { x: 479, y: 639 });
});
