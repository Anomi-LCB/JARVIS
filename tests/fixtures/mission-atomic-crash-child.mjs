import { readFileSync, writeFileSync } from 'node:fs';
import { PersonalOperationsStore } from '../../packages/core/src/personal-operations/operations-store.js';
import { SqliteMissionStore } from '../../packages/core/src/mission/sqlite-mission-store.js';

const [dbPath, inputPath, point, markerPath] = process.argv.slice(2);
const points = {
    snapshot: ['UPDATE', 'mission_sqlite_snapshot'],
    reservation: ['INSERT', 'personal_budget_reservations'],
    effect: ['INSERT', 'mission_effects'],
    outbox: ['INSERT', 'mission_dispatch_outbox']
};
const operationsStore = new PersonalOperationsStore({ dbPath });
const store = new SqliteMissionStore({ operationsStore });
if (point !== 'committed') {
    if (!points[point]) throw new Error('Unknown crash point');
    operationsStore.db.function('terminate_atomic_worker', () => {
        writeFileSync(markerPath, JSON.stringify({ pid: process.pid, point, transactionOpen: operationsStore.db.isTransaction }) + '\n');
        process.kill(process.pid, 'SIGKILL');
        process.exit(97); // Never return to the transaction if a platform defers termination.
    });
    const [operation, table] = points[point];
    operationsStore.db.exec(`CREATE TEMP TRIGGER atomic_crash AFTER ${operation} ON ${table} BEGIN SELECT terminate_atomic_worker(); END;`);
}
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
store.save(input.missions, { effects: [input.effect] });
writeFileSync(markerPath, JSON.stringify({ pid: process.pid, point, revision: store.metadata().revision, transactionOpen: operationsStore.db.isTransaction }) + '\n');
operationsStore.close();
