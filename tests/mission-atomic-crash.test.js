import test from 'node:test';
import { observeMissionAtomicCrash } from './fixtures/mission-atomic-crash-observation.mjs';

for(const point of ['snapshot','reservation','effect','outbox','committed']) {
    test(`actual process exit at atomic Mission staging ${point}`, {timeout:30000}, async()=>observeMissionAtomicCrash(point));
}
