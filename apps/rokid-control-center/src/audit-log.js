import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class AuditLog {
  constructor(path, { now = () => new Date() } = {}) {
    this.path = path;
    this.now = now;
  }

  async append(event) {
    const record = {
      auditVersion: 'rokid-control-audit-v1',
      timestamp: this.now().toISOString(),
      ...sanitizeEvent(event)
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  async tail(limit = 80) {
    try {
      const lines = (await readFile(this.path, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.min(Math.max(Number(limit) || 80, 1), 500)).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}

function sanitizeEvent(event) {
  const value = JSON.parse(JSON.stringify(event ?? {}));
  for (const key of Object.keys(value)) {
    if (/token|secret|authorization|password/i.test(key)) value[key] = '[REDACTED]';
  }
  return value;
}
