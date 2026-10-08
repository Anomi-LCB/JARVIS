import { appendFileSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ManagedAgentSessionBroker } from '../../packages/core/src/mission/managed-agent-session-broker.js';

const [mode, dbPath, journalPath, clockIso] = process.argv.slice(2);
const db = new DatabaseSync(dbPath); db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2500;');
const journal = () => { try { return readFileSync(journalPath, 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };
const provider = {
  async retrieveSession(sessionId) { return { id: sessionId, required_actions: mode==='tool-hold'?[{type:'function_call',turn_id:'tool-turn',call_id:'tool-call',name:'fixture.read',arguments:{path:'notes.txt'}}]:[] }; },
  async submitToolResult(sessionId,payload,{idempotencyKey}) {
    const entries=journal();
    appendFileSync(journalPath,`${JSON.stringify({mode,sessionId,payload,idempotencyKey,duplicateKey:entries.some(e=>e.idempotencyKey===idempotencyKey)})}\n`);
    process.stdout.write(`ATTEMPT:${idempotencyKey}\n`);
    if(mode==='tool-hold')await new Promise(()=>{});
  },
  async submitMessage(sessionId, text, { idempotencyKey }) {
    const entries = journal();
    appendFileSync(journalPath, `${JSON.stringify({ mode, sessionId, text, idempotencyKey, duplicateKey: entries.some(item => item.idempotencyKey === idempotencyKey) })}\n`);
    process.stdout.write(`ATTEMPT:${idempotencyKey}\n`);
    if (mode === 'hold') await new Promise(() => {});
    return { accepted: true, status: 202 };
  },
  async cancelTurn() { return { accepted: true, status: 202 }; }
};
const broker = new ManagedAgentSessionBroker({ db, provider, allowedToolNames: ['fixture.read'],
  dispatchVerifiedTool: async () => {
    if(mode!=='tool-hold')throw new Error('recovery must not redispatch');
    process.stdout.write('DISPATCH:1\n');
    return {status:'verified',output:'durable verified result',verification:{status:'passed',verificationId:'g-tool',evidenceRef:'g:tool'}};
  },
  clock: () => new Date(clockIso) });
broker.bindSession({ missionId: 'mission-process', sessionId: 'session-process' });
try {
  const result = mode.startsWith('tool-')?await broker.reconcileMission('mission-process'):await broker.sendMissionMessage({ missionId: 'mission-process', messageId: 'message-process', text: 'durable content' });
  process.stdout.write(`RESULT:${result.status}\n`);
} catch (error) {
  process.stderr.write(`ERROR:${error.code ?? 'unknown'}\n`); process.exitCode = 1;
} finally {
  if (mode !== 'hold' && mode !== 'tool-hold') db.close();
}
