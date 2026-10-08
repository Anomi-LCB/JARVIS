import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdbClient, resolveAdbPath } from '../src/adb-client.js';
import { AuditLog } from '../src/audit-log.js';
import { BackupService } from '../src/backup-service.js';
import { DeviceService } from '../src/device-service.js';

const appRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const repoRoot = resolve(appRoot, '..', '..');
const options = parseArgs(process.argv.slice(2));
const mode = options.mode ?? 'logical';
const dataRoot = resolve(options.dataRoot ?? resolve(repoRoot, 'workspace', 'rokid-control-center'));
const adbPath = await resolveAdbPath();
const adb = new AdbClient({ adbPath });
const audit = new AuditLog(resolve(dataRoot, 'audit', 'device-actions.jsonl'));
const deviceService = new DeviceService({ adb, audit });
const backupService = new BackupService({ adb, deviceService, audit, backupRoot: resolve(dataRoot, 'backups') });

const result = await backupService.create({
  mode,
  serial: options.serial ?? '',
  onProgress(progress) {
    console.log(`${String(progress.percent).padStart(3, ' ')}% ${progress.stage}`);
  }
});

console.log(JSON.stringify({
  status: result.status,
  backupDir: result.backupDir,
  fileCount: result.manifest.files.length,
  warnings: result.manifest.warnings
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mode') parsed.mode = argv[++index];
    else if (argv[index] === '--serial') parsed.serial = argv[++index];
    else if (argv[index] === '--data-root') parsed.dataRoot = argv[++index];
  }
  return parsed;
}
