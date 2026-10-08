import test from 'node:test';
import { observeHealthProcessRecovery } from './fixtures/health-process-observation.mjs';

test('persisted health report survives actual process termination and hides changed or deleted evidence', { timeout: 240000 }, observeHealthProcessRecovery);
