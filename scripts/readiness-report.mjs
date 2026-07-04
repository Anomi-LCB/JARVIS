import { mkdir, writeFile } from 'node:fs/promises';
import { createJarvisSystem } from '../src/domain/core-engine.js';
import { PermissionLevel } from '../src/domain/models.js';
import { formatReadinessReport } from '../src/domain/readiness.js';

const args = process.argv.slice(2);
const commandIndex = args.indexOf('--command');
const command = commandIndex >= 0 ? args[commandIndex + 1] : '회의 자료 분석';
const elevated = args.includes('--elevated');

const state = createJarvisSystem().composeDashboardState(
  command,
  elevated
    ? {
        autoApprove: true,
        userLevel: PermissionLevel.ADMIN
      }
    : undefined
);
const report = formatReadinessReport(state);
const reportName = command
  .normalize('NFC')
  .replace(/[^\w가-힣-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .toLowerCase();
const reportPath = `dist/readiness-report-${reportName || 'default'}${elevated ? '-elevated' : ''}.md`;

await mkdir('dist', { recursive: true });
await writeFile(reportPath, report);
console.log(report);
console.log(`\nWrote ${reportPath}`);
