import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { LocalWorkflowToolAdapter } from '../../apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';

const COLUMNS = Object.freeze(['title', 'source', 'publishedAt', 'url', 'articleStatus']);

export async function createAndVerifyNewsFactsCsv({ root, headlines } = {}) {
  if (!root || !Array.isArray(headlines) || headlines.length > 100) throw new TypeError('news-csv-input-invalid');
  const workflow = {
    schemaVersion: 'jarvis-local-workflow-v1',
    workflowId: 'news-headlines-csv-source-roundtrip-v1',
    nodes: [
      { id: 'read-source', op: 'data.readJson', args: { path: 'source-facts.json' } },
      { id: 'write-csv', op: 'write.csv', dependsOn: ['read-source'], args: {
        path: 'headlines.csv', items: { $ref: { nodeId: 'read-source', pointer: '/value/facts/headlines', expectedType: 'array' } },
        columns: [...COLUMNS]
      } },
      { id: 'read-csv', op: 'data.readCsv', dependsOn: ['write-csv'], args: { path: 'headlines.csv' } },
      { id: 'verify-csv', op: 'assert.equals', dependsOn: ['read-source', 'read-csv'], args: {
        actual: { $ref: { nodeId: 'read-csv', pointer: '/items', expectedType: 'array' } },
        expected: { $ref: { nodeId: 'read-source', pointer: '/value/facts/headlines', expectedType: 'array' } }
      } }
    ],
    outputs: [{ nodeId: 'write-csv', path: 'headlines.csv', mediaType: 'text/csv' }]
  };
  const workflowPath = `${root.replace(/[\\/]$/u, '')}/news-headlines-csv.workflow.json`;
  await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`, { flag: 'wx' });
  const result = await new LocalWorkflowToolAdapter({ allowedRoots: [root] }).execute({ specPath: workflowPath });
  if (result.status !== 'success') throw new Error(`news-csv-workflow:${result.error?.code ?? result.status}`);
  const workflowEvidence = result.evidence?.workflow;
  const verification = workflowEvidence?.receipts?.find(receipt => receipt.nodeId === 'verify-csv') ?? null;
  const published = workflowEvidence?.publication?.files?.find(file => file.path.endsWith('headlines.csv')) ?? null;
  const manifest = result.evidence?.manifest?.find(file => file.path.endsWith('headlines.csv')) ?? null;
  if (verification?.status !== 'success' || !published?.afterSha256 || manifest?.sha256 !== published.afterSha256) {
    throw new Error('news-csv-workflow:verification-evidence-missing');
  }
  const bytes = await readFile(`${root.replace(/[\\/]$/u, '')}/headlines.csv`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== published.afterSha256 || bytes.byteLength !== published.size || bytes.byteLength !== manifest.size) {
    throw new Error('news-csv-workflow:published-bytes-mismatch');
  }
  return { status: 'passed', result, workflowPath, columns: [...COLUMNS], verification,
    publication: { sha256, size: bytes.byteLength, changed: published.changed, existedBefore: published.existedBefore } };
}
