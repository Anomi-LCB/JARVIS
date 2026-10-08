import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

const commonTree = Object.freeze({
  'inputs/tree/a/report.txt': '첫 줄\nERROR-101 service unavailable\nneedle alpha\n',
  'inputs/tree/b/nested/log.txt': 'INFO start\nERROR-203 timeout\nneedle beta\n',
  'inputs/tree/b/nested/copy.txt': '동일한 바이트 payload\n',
  'inputs/tree/c/copy-again.txt': '동일한 바이트 payload\n',
  'inputs/tree/c/notes.md': '# notes\nneedle gamma\nERROR-404 missing\n'
});

const processFiles = Object.freeze({
  'inputs/process/transform.mjs': `const [a = '', b = ''] = process.argv.slice(2);\nprocess.stdout.write(JSON.stringify({ joined: [a, b].join(':'), length: a.length + b.length }));\n`,
  'inputs/process/uppercase.mjs': `let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()));\n`,
  'inputs/process/sort-lines.mjs': `let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>process.stdout.write(s.trim().split(/\\r?\\n/u).filter(Boolean).sort().join('\\n')+'\\n'));\n`,
  'inputs/process/count-lines.mjs': `let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{const lines=s.trim().split(/\\r?\\n/u).filter(Boolean);process.stdout.write(JSON.stringify({lineCount:lines.length,unique:[...new Set(lines)].length,lines}));});\n`,
  'inputs/process/flaky.mjs': `import { mkdirSync, existsSync, writeFileSync } from 'node:fs'; import { dirname, resolve } from 'node:path'; const marker=resolve(process.argv[2]??'outputs/retry-marker.txt'); if(!existsSync(marker)){mkdirSync(dirname(marker),{recursive:true});writeFileSync(marker,'first-attempt\\n');process.stderr.write('transient failure');process.exit(17);} process.stdout.write(JSON.stringify({recovered:true,attempt:2}));\n`,
  'inputs/process/generate-lines.mjs': `const n=Math.max(0,Number(process.argv[2]??0)); for(let i=1;i<=n;i+=1) process.stdout.write('row-'+String(i).padStart(5,'0')+'\\n');\n`,
  'inputs/process/stream-summary.mjs': `let s=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>s+=c); process.stdin.on('end',()=>{const lines=s.trim().split(/\\r?\\n/u).filter(Boolean);process.stdout.write(JSON.stringify({lineCount:lines.length,first:lines[0]??null,last:lines.at(-1)??null}));});\n`
});

const fixtures = Object.freeze({
  IW01: { 'inputs/sales.csv': 'id,region,amount\n1,서울,120.50\n2,부산,80.25\n3,서울,30.00\n4,대전,200.00\n5,부산,19.75\n' },
  IW02: { 'inputs/customers.csv': 'id,name,active,score\nc1,가람,true,88\nc2,나래,false,99\nc3,다온,true,95\nc4,라온,true,77\n' },
  IW03: { 'inputs/contacts.csv': 'id,email,name\n1,a@example.test,A\n2,b@example.test,B\n3,a@example.test,A2\n4,c@example.test,C\n' },
  IW04: { 'inputs/expenses.csv': 'department,month,amount\n개발,01,100\n개발,02,150\n영업,01,80\n영업,02,120\n개발,01,25\n' },
  IW05: { 'inputs/employees.json': json([{ id: 'e1', name: '가람', level: 3 }, { id: 'e2', name: '나래', level: 2 }, { id: 'e3', name: '다온', level: 4 }]) },
  IW06: { 'inputs/orders.csv': 'id,status,category,quantity\no1,paid,book,2\no2,pending,book,9\no3,paid,food,3\no4,paid,book,4\no5,cancelled,food,7\n' },
  IW07: {
    'inputs/customers.json': json([{ id: 'c1', name: '가람' }, { id: 'c2', name: '나래' }, { id: 'c3', name: '다온' }]),
    'inputs/orders.json': json([{ id: 'o1', customerId: 'c2', total: 20 }, { id: 'o2', customerId: 'c1', total: 35 }, { id: 'o3', customerId: 'missing', total: 99 }])
  },
  IW08: { 'inputs/events.json': json([{ eventId: 'v1', value: 1 }, { eventId: 'v2', value: 2 }, { eventId: 'v1', value: 9 }, { eventId: 'v3', value: 3 }]) },
  IW09: { 'inputs/ledger.json': json([{ id: 'l1', debit: '0.10', credit: '0.00' }, { id: 'l2', debit: '0.20', credit: '0.00' }, { id: 'l3', debit: '0.00', credit: '0.30' }, { id: 'l4', debit: '1000000000000.01', credit: '999999999999.99' }]) },
  IW10: {},
  IW11: { 'inputs/records.json': json([{ id: 'r1', value: 10 }, { id: 'r2', value: 20 }]) },
  IW12: {
    'inputs/products.csv': 'sku,name\np1,연필\np2,공책\np3,지우개\n',
    'inputs/prices.csv': 'sku,price\np2,2500\np1,800\np4,9000\n'
  },
  IW13: { 'inputs/graph.json': json({ nodes: ['A', 'B', 'C', 'D', 'E'], edges: [['A', 'C'], ['B', 'C'], ['C', 'D'], ['C', 'E']] }) },
  IW14: { 'inputs/weighted-graph.json': json({ edges: [
    { from: 'A', to: 'B', weight: 4 }, { from: 'A', to: 'C', weight: 2 }, { from: 'C', to: 'B', weight: 1 },
    { from: 'B', to: 'D', weight: 5 }, { from: 'C', to: 'D', weight: 8 }, { from: 'C', to: 'E', weight: 10 },
    { from: 'D', to: 'F', weight: 6 }, { from: 'E', to: 'F', weight: 3 }
  ] }) },
  IW15: { 'inputs/tasks.json': json([{ id: 'A', duration: 3, dependsOn: [] }, { id: 'B', duration: 4, dependsOn: ['A'] }, { id: 'C', duration: 2, dependsOn: ['A'] }, { id: 'D', duration: 5, dependsOn: ['B', 'C'] }, { id: 'E', duration: 1, dependsOn: ['C'] }]) },
  IW16: { 'inputs/options.json': json([{ id: 'A', weight: 6, value: 30 }, { id: 'B', weight: 3, value: 14 }, { id: 'C', weight: 4, value: 16 }, { id: 'D', weight: 2, value: 9 }]) },
  IW17: { 'inputs/tasks.json': json([{ id: 'A', duration: 3, dependsOn: [] }, { id: 'B', duration: 2, dependsOn: [] }, { id: 'C', duration: 4, dependsOn: ['A'] }, { id: 'D', duration: 1, dependsOn: ['B'] }, { id: 'E', duration: 2, dependsOn: ['C', 'D'] }]) },
  IW18: { 'inputs/tasks.json': json([{ id: 'A', duration: 1, dependsOn: [] }, { id: 'B', duration: 2, dependsOn: ['A'] }, { id: 'C', duration: 1, dependsOn: ['A'] }, { id: 'D', duration: 2, dependsOn: ['B'] }, { id: 'E', duration: 1, dependsOn: ['C', 'D'] }]) },
  IW19: commonTree,
  IW20: commonTree,
  IW21: commonTree,
  IW22: { 'inputs/large.txt': Array.from({ length: 6000 }, (_, index) => `line ${String(index + 1).padStart(4, '0')} alpha beta ${index % 7}\n`).join('') },
  IW23: { 'inputs/template.txt': '안녕하세요 {{name}}님, 주문 {{orderId}}의 금액은 {{amount}}원입니다.', 'inputs/records.json': json([{ name: '가람', orderId: 'O-1', amount: 1200 }, { name: '나래', orderId: 'O-2', amount: 3400 }, { name: '다온', orderId: 'O-3', amount: 5600 }]) },
  IW24: commonTree,
  IW25: processFiles,
  IW26: processFiles,
  IW27: processFiles,
  IW28: processFiles,
  IW29: { 'inputs/transactions.csv': 'id,category,amount\nt1,A,10.5\nt2,B,20\nt3,A,4.5\nt4,B,3\n' },
  IW30: {
    'inputs/base.json': json([{ id: 'i1', name: '연필', quantity: 10 }, { id: 'i2', name: '공책', quantity: 5 }]),
    'inputs/updates.json': json([{ id: 'i2', name: '공책', quantity: 8 }, { id: 'i3', name: '지우개', quantity: 4 }])
  }
});

export const IMPOSSIBLE_WORKFLOW_30_FIXTURE_VERSION = 'jarvis-impossible-workflow-30-fixtures-v1';
export const IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256 = sha256(Buffer.from(stableStringify({
  version: IMPOSSIBLE_WORKFLOW_30_FIXTURE_VERSION,
  cases: Object.entries(fixtures).sort(([a], [b]) => a.localeCompare(b)).map(([caseId, files]) => ({
    caseId,
    files: Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
      return { path, size: bytes.length, sha256: sha256(bytes) };
    })
  }))
}), 'utf8'));

export async function materializeImpossibleWorkflow30Fixture(testCase, caseDir) {
  const root = resolve(caseDir);
  const files = fixtures[testCase.id];
  if (!files) throw new Error(`No fixture registered for ${testCase.id}.`);
  const manifest = [];
  for (const [relativePath, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const absolutePath = safeResolve(root, relativePath);
    await mkdir(dirname(absolutePath), { recursive: true });
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    await writeFile(absolutePath, bytes);
    manifest.push({ path: slash(relative(root, absolutePath)), size: bytes.length, sha256: sha256(bytes) });
  }
  const specPath = safeResolve(root, testCase.specFilename);
  await mkdir(dirname(specPath), { recursive: true });
  await writeFile(specPath, `${JSON.stringify(testCase.workflow, null, 2)}\n`, 'utf8');
  const specBytes = await readFile(specPath);
  manifest.push({ path: slash(relative(root, specPath)), size: specBytes.length, sha256: sha256(specBytes) });
  return {
    caseDir: root,
    specPath,
    files: manifest,
    inputManifestSha256: sha256(Buffer.from(JSON.stringify(manifest), 'utf8'))
  };
}

export function createImpossibleWorkflow30ExpectedFixtureManifest(testCase) {
  const files = fixtures[testCase.id];
  if (!files) throw new Error(`No fixture registered for ${testCase.id}.`);
  const manifest = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    return { path, size: bytes.length, sha256: sha256(bytes) };
  });
  const specBytes = Buffer.from(`${JSON.stringify(testCase.workflow, null, 2)}\n`, 'utf8');
  manifest.push({ path: testCase.specFilename, size: specBytes.length, sha256: sha256(specBytes) });
  return {
    files: manifest,
    inputManifestSha256: sha256(Buffer.from(JSON.stringify(manifest), 'utf8'))
  };
}

export function fixtureIds() {
  return Object.keys(fixtures).sort();
}

function safeResolve(root, relativePath) {
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith('..') || resolve(target) === resolve(root) && relativePath !== '.') throw new Error(`Fixture path escapes case directory: ${relativePath}`);
  return target;
}

function slash(value) {
  return value.replaceAll('\\', '/');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
