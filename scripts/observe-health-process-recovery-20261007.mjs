import { writeFileSync } from 'node:fs';
import { observeHealthProcessRecovery } from '../tests/fixtures/health-process-observation.mjs';
const result = await observeHealthProcessRecovery();
writeFileSync('artifacts/health-process-recovery-20261007-live.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ actualProcesses: result.processIds.length, restored: result.restoration.status, changedSource: result.changedSource, changedReport: result.changedReport, deletedReport: result.deletedReport }));
