import test from 'node:test';
import { observeMissionResultCrash } from './fixtures/mission-result-crash-observation.mjs';
for(const point of ['snapshot','settlement','effect','outbox','followup','lease','committed'])test(`result transaction actual process termination ${point}`,{timeout:30000},async()=>observeMissionResultCrash(point));
