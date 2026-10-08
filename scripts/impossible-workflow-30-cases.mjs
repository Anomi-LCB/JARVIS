import { createHash } from 'node:crypto';

export const IMPOSSIBLE_WORKFLOW_30_CORPUS_VERSION = 'jarvis-impossible-workflow-30-corpus-v1';
export const IMPOSSIBLE_WORKFLOW_SCHEMA_VERSION = 'jarvis-local-workflow-v1';
export const CASE_DIR_TOKEN = '<CASE_DIR>';

const ref = (nodeId, pointer = '') => ({ $ref: { nodeId, ...(pointer ? { pointer } : {}) } });
const outputNodes = (sourceId, stem, { csv = false } = {}) => [
  {
    id: 'write-primary',
    op: csv ? 'write.csv' : 'write.json',
    dependsOn: [sourceId],
    args: { path: `outputs/${stem}.${csv ? 'csv' : 'json'}`, [csv ? 'items' : 'value']: ref(sourceId, csv ? '/items' : '') }
  },
  {
    id: 'assert-result',
    op: 'assert.count',
    dependsOn: [sourceId],
    args: { value: ref(sourceId), min: 1 }
  },
  {
    id: 'write-proof',
    op: 'write.json',
    dependsOn: ['assert-result'],
    args: { path: `outputs/${stem}-proof.json`, value: ref('assert-result') }
  }
];

function workflow(workflowId, coreNodes, stem, options = {}) {
  const sourceId = options.sourceId ?? coreNodes.at(-1).id;
  const outputs = outputNodes(sourceId, stem, options);
  return {
    schemaVersion: IMPOSSIBLE_WORKFLOW_SCHEMA_VERSION,
    workflowId,
    description: options.description,
    nodes: [...coreNodes, ...outputs],
    outputs: [
      { nodeId: 'write-primary', path: `outputs/${stem}.${options.csv ? 'csv' : 'json'}`, mediaType: options.csv ? 'text/csv' : 'application/json' },
      { nodeId: 'write-proof', path: `outputs/${stem}-proof.json`, mediaType: 'application/json' }
    ]
  };
}

function define(id, title, category, workflowSpec) {
  const specFilename = `${id.toLowerCase()}-${slug(title)}.workflow.json`;
  const commandTemplate = [
    `${CASE_DIR_TOKEN}/${specFilename}에 정의된 로컬 워크플로를 읽어 모든 노드를 의존성 순서대로 실제 실행해줘.`,
    `${title} 임무의 계산 결과와 검증 증거를 outputs 폴더에 모두 생성하고, 생성된 바이트를 다시 확인해 성공 여부를 보고해줘.`,
    `반드시 workflow.execute 기능을 사용하고 shell.execute로 강등하거나 결과를 추측해서 만들지 마.`
  ].join(' ');
  return deepFreeze({ id, title, category, specFilename, commandTemplate, workflow: workflowSpec });
}

const blueprints = [
  define('IW01', '지역별 매출 정확 집계와 내림차순 정렬', 'tabular-data', workflow('iw01-sales-aggregate', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/sales.csv' } },
    { id: 'aggregate', op: 'data.groupAggregate', dependsOn: ['read'], args: { items: ref('read', '/items'), groupBy: 'region', field: 'amount', operation: 'sum' } },
    { id: 'result', op: 'data.sort', dependsOn: ['aggregate'], args: { items: ref('aggregate', '/items'), by: 'value', order: 'desc' } }
  ], 'region-sales', { csv: true })),
  define('IW02', '활성 고객 필터와 점수 정렬', 'tabular-data', workflow('iw02-active-customers', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/customers.csv' } },
    { id: 'active', op: 'data.filter', dependsOn: ['read'], args: { items: ref('read', '/items'), field: 'active', operator: 'eq', value: 'true' } },
    { id: 'result', op: 'data.sort', dependsOn: ['active'], args: { items: ref('active', '/items'), by: 'score', order: 'desc' } }
  ], 'active-customers', { csv: true })),
  define('IW03', '이메일 기준 중복 고객 제거', 'tabular-data', workflow('iw03-dedupe-contacts', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/contacts.csv' } },
    { id: 'result', op: 'data.unique', dependsOn: ['read'], args: { items: ref('read', '/items'), by: 'email' } }
  ], 'unique-contacts', { csv: true })),
  define('IW04', '부서 월별 비용 피벗 생성', 'tabular-data', workflow('iw04-expense-pivot', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/expenses.csv' } },
    { id: 'result', op: 'data.pivot', dependsOn: ['read'], args: { items: ref('read', '/items'), row: 'department', column: 'month', value: 'amount', operation: 'sum' } }
  ], 'expense-pivot')),
  define('IW05', '직원 레코드 스키마 일괄 검증', 'tabular-data', workflow('iw05-record-validation', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/employees.json' } },
    { id: 'result', op: 'data.validate', dependsOn: ['read'], args: { items: ref('read', '/items'), required: ['id', 'name', 'level'], rules: { id: 'string', name: 'string', level: 'number' } } }
  ], 'employee-validation')),
  define('IW06', '다단 필터 후 카테고리별 재집계', 'tabular-data', workflow('iw06-filter-group', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/orders.csv' } },
    { id: 'paid', op: 'data.filter', dependsOn: ['read'], args: { items: ref('read', '/items'), field: 'status', operator: 'eq', value: 'paid' } },
    { id: 'result', op: 'data.groupAggregate', dependsOn: ['paid'], args: { items: ref('paid', '/items'), groupBy: 'category', field: 'quantity', operation: 'sum' } }
  ], 'paid-quantity', { csv: true })),
  define('IW07', '고객과 주문 JSON 관계 조인', 'structured-data', workflow('iw07-json-join', [
    { id: 'customers', op: 'data.readJson', args: { path: 'inputs/customers.json' } },
    { id: 'orders', op: 'data.readJson', args: { path: 'inputs/orders.json' } },
    { id: 'result', op: 'data.join', dependsOn: ['customers', 'orders'], args: { left: ref('orders', '/items'), right: ref('customers', '/items'), leftKey: 'customerId', rightKey: 'id', type: 'inner' } }
  ], 'customer-orders')),
  define('IW08', 'JSON 이벤트 고유 키 정규화', 'structured-data', workflow('iw08-json-unique', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/events.json' } },
    { id: 'result', op: 'data.unique', dependsOn: ['read'], args: { items: ref('read', '/items'), by: 'eventId' } }
  ], 'unique-events')),
  define('IW09', '부동소수점 없는 복식 원장 잔액 계산', 'exact-compute', workflow('iw09-exact-ledger', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/ledger.json' } },
    { id: 'result', op: 'compute.ledger', dependsOn: ['read'], args: { entries: ref('read', '/items'), debitField: 'debit', creditField: 'credit', scale: 2 } }
  ], 'ledger-balance')),
  define('IW10', '길이 단위 연쇄 변환과 정확성 검증', 'exact-compute', workflow('iw10-unit-conversion', [
    { id: 'meters', op: 'compute.units', args: { value: 12.5, from: 'km', to: 'm' } },
    { id: 'result', op: 'compute.units', dependsOn: ['meters'], args: { value: ref('meters', '/value'), from: 'm', to: 'cm' } },
    { id: 'unit-check', op: 'assert.equals', dependsOn: ['result'], args: { actual: ref('result', '/value'), expected: 1250000 } }
  ], 'unit-conversion', { sourceId: 'result' })),
  define('IW11', '타입 참조와 조건 분기를 포함한 검증', 'workflow-control', workflow('iw11-typed-condition', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/records.json' } },
    { id: 'validate', op: 'data.validate', dependsOn: ['read'], args: { items: ref('read', '/items'), required: ['id', 'value'] } },
    { id: 'result', op: 'assert.equals', dependsOn: ['validate'], when: { $ref: { nodeId: 'validate', pointer: '/valid', expectedType: 'boolean' } }, args: { actual: ref('validate', '/valid'), expected: true } }
  ], 'typed-condition')),
  define('IW12', '조인 결과의 다중 형식 출력', 'workflow-control', workflow('iw12-multi-output', [
    { id: 'left', op: 'data.readCsv', args: { path: 'inputs/products.csv' } },
    { id: 'right', op: 'data.readCsv', args: { path: 'inputs/prices.csv' } },
    { id: 'result', op: 'data.join', dependsOn: ['left', 'right'], args: { left: ref('left', '/items'), right: ref('right', '/items'), leftKey: 'sku', rightKey: 'sku', type: 'inner' } }
  ], 'priced-products')),
  define('IW13', '의존 그래프 위상 정렬', 'graph-solver', workflow('iw13-toposort', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/graph.json' } },
    { id: 'result', op: 'graph.toposort', dependsOn: ['read'], args: { nodes: ref('read', '/value/nodes'), edges: ref('read', '/value/edges') } }
  ], 'topological-order')),
  define('IW14', '가중 그래프 최단 경로 탐색', 'graph-solver', workflow('iw14-shortest-path', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/weighted-graph.json' } },
    { id: 'result', op: 'graph.shortestPath', dependsOn: ['read'], args: { edges: ref('read', '/value/edges'), start: 'A', end: 'F' } }
  ], 'shortest-path')),
  define('IW15', '프로젝트 임계 경로 산출', 'graph-solver', workflow('iw15-critical-path', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/tasks.json' } },
    { id: 'result', op: 'graph.criticalPath', dependsOn: ['read'], args: { tasks: ref('read', '/items') } }
  ], 'critical-path')),
  define('IW16', '예산 제한 최적 포트폴리오 선택', 'graph-solver', workflow('iw16-knapsack', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/options.json' } },
    { id: 'result', op: 'solver.knapsack', dependsOn: ['read'], args: { items: ref('read', '/items'), capacity: 10 } }
  ], 'optimal-portfolio')),
  define('IW17', '선후행 제약 작업 일정 편성', 'graph-solver', workflow('iw17-schedule', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/tasks.json' } },
    { id: 'result', op: 'solver.schedule', dependsOn: ['read'], args: { tasks: ref('read', '/items'), resources: 2 } }
  ], 'resource-schedule')),
  define('IW18', '일정 결과의 개수 교차 검증', 'graph-solver', workflow('iw18-schedule-assert', [
    { id: 'read', op: 'data.readJson', args: { path: 'inputs/tasks.json' } },
    { id: 'schedule', op: 'solver.schedule', dependsOn: ['read'], args: { tasks: ref('read', '/items'), resources: 1 } },
    { id: 'result', op: 'assert.count', dependsOn: ['schedule'], args: { items: ref('schedule', '/items'), equals: 5 } }
  ], 'schedule-assertion')),
  define('IW19', '깊은 디렉터리 재귀 인벤토리', 'filesystem-analysis', workflow('iw19-inventory', [
    { id: 'result', op: 'fs.inventory', args: { path: 'inputs/tree', recursive: true, includeSha256: true } }
  ], 'tree-inventory')),
  define('IW20', '다중 파일 정규식 내용 검색', 'filesystem-analysis', workflow('iw20-search', [
    { id: 'result', op: 'fs.search', args: { path: 'inputs/tree', pattern: 'ERROR-[0-9]{3}', recursive: true, regex: true } }
  ], 'error-search')),
  define('IW21', '내용 해시 기반 중복 파일 탐지', 'filesystem-analysis', workflow('iw21-duplicates', [
    { id: 'result', op: 'fs.duplicates', args: { path: 'inputs/tree', recursive: true, algorithm: 'sha256' } }
  ], 'duplicate-groups')),
  define('IW22', '대용량 텍스트 청크 통계', 'filesystem-analysis', workflow('iw22-text-stats', [
    { id: 'read', op: 'text.read', args: { path: 'inputs/large.txt' } },
    { id: 'result', op: 'text.stats', dependsOn: ['read'], args: { text: ref('read', '/value'), chunkSize: 4096 } }
  ], 'large-text-stats')),
  define('IW23', '레코드별 템플릿 문서 대량 생성', 'filesystem-analysis', workflow('iw23-template-fanout', [
    { id: 'template', op: 'text.read', args: { path: 'inputs/template.txt' } },
    { id: 'records', op: 'data.readJson', args: { path: 'inputs/records.json' } },
    { id: 'result', op: 'template.renderMany', dependsOn: ['template', 'records'], args: { template: ref('template', '/value'), records: ref('records', '/items') } }
  ], 'rendered-documents')),
  define('IW24', '파일 검색 결과 집계와 증거화', 'filesystem-analysis', workflow('iw24-search-count', [
    { id: 'search', op: 'fs.search', args: { path: 'inputs/tree', pattern: 'needle', recursive: true } },
    { id: 'result', op: 'assert.count', dependsOn: ['search'], args: { items: ref('search', '/items'), equals: 3 } }
  ], 'search-count')),
  define('IW25', '격리된 로컬 프로세스 JSON 변환', 'process-orchestration', workflow('iw25-process-run', [
    { id: 'result', op: 'process.run', args: { scriptPath: 'inputs/process/transform.mjs', args: ['alpha', 'beta'], timeoutMs: 5000 } }
  ], 'process-result')),
  define('IW26', '세 단계 표준입출력 파이프라인', 'process-orchestration', workflow('iw26-process-pipeline', [
    { id: 'result', op: 'process.pipeline', args: { stdin: 'alpha\nbeta\nalpha\n', stages: [
      { scriptPath: 'inputs/process/uppercase.mjs' },
      { scriptPath: 'inputs/process/sort-lines.mjs' },
      { scriptPath: 'inputs/process/count-lines.mjs' }
    ], timeoutMs: 8000 } }
  ], 'pipeline-result')),
  define('IW27', '일시 실패 프로세스의 제한 재시도', 'process-orchestration', workflow('iw27-process-retry', [
    { id: 'result', op: 'process.run', retry: { maxAttempts: 2, backoffMs: 5 }, args: { scriptPath: 'inputs/process/flaky.mjs', args: ['outputs/retry-marker.txt'], timeoutMs: 5000 } }
  ], 'retry-result')),
  define('IW28', '대량 스트림 생성과 요약 파이프라인', 'process-orchestration', workflow('iw28-large-stream', [
    { id: 'result', op: 'process.pipeline', args: { stages: [
      { scriptPath: 'inputs/process/generate-lines.mjs', args: ['12000'] },
      { scriptPath: 'inputs/process/stream-summary.mjs' }
    ], timeoutMs: 10000, maxOutputBytes: 2097152 } }
  ], 'stream-summary')),
  define('IW29', 'CSV를 SQLite로 가져와 집계 질의', 'database', workflow('iw29-sqlite-import-query', [
    { id: 'read', op: 'data.readCsv', args: { path: 'inputs/transactions.csv' } },
    { id: 'import', op: 'sqlite.import', dependsOn: ['read'], args: { databasePath: 'outputs/transactions.db', table: 'transactions', items: ref('read', '/items'), transaction: true } },
    { id: 'result', op: 'sqlite.query', dependsOn: ['import'], args: { databasePath: ref('import', '/databasePath'), sql: 'SELECT category, SUM(CAST(amount AS REAL)) AS total FROM transactions GROUP BY category ORDER BY category' } }
  ], 'sqlite-summary', { csv: true })),
  define('IW30', 'SQLite 원자 업서트와 최종 상태 검증', 'database', workflow('iw30-sqlite-upsert', [
    { id: 'base', op: 'data.readJson', args: { path: 'inputs/base.json' } },
    { id: 'seed', op: 'sqlite.import', dependsOn: ['base'], args: { databasePath: 'outputs/inventory.db', table: 'inventory', items: ref('base', '/items'), mode: 'replace', key: 'id', transaction: true } },
    { id: 'updates', op: 'data.readJson', args: { path: 'inputs/updates.json' } },
    { id: 'upsert', op: 'sqlite.import', dependsOn: ['seed', 'updates'], args: { databasePath: ref('seed', '/databasePath'), table: 'inventory', items: ref('updates', '/items'), mode: 'upsert', key: 'id', transaction: true } },
    { id: 'result', op: 'sqlite.query', dependsOn: ['upsert'], args: { databasePath: ref('upsert', '/databasePath'), sql: 'SELECT id, name, quantity FROM inventory ORDER BY id' } }
  ], 'sqlite-inventory', { csv: true }))
];

export const impossibleWorkflow30Cases = deepFreeze(blueprints);
export const IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256 = sha256(stableStringify(canonicalCorpus(impossibleWorkflow30Cases)));

export function materializeImpossibleCommand(testCase, caseDir) {
  return testCase.commandTemplate.replaceAll(CASE_DIR_TOKEN, normalizeCommandPath(caseDir));
}

export function createImpossibleWorkflow30CorpusFingerprint(selected = impossibleWorkflow30Cases) {
  const canonicalPayload = canonicalCorpus(selected);
  return { canonicalPayload, corpusSha256: sha256(stableStringify(canonicalPayload)) };
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalCorpus(items) {
  return { version: IMPOSSIBLE_WORKFLOW_30_CORPUS_VERSION, cases: items.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    specFilename: item.specFilename,
    commandTemplate: item.commandTemplate,
    workflow: item.workflow
  })) };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function slug(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function normalizeCommandPath(path) {
  return String(path).replaceAll('\\', '/').replace(/\/$/u, '');
}

if (impossibleWorkflow30Cases.length !== 30) throw new Error(`Expected 30 impossible workflow cases, got ${impossibleWorkflow30Cases.length}.`);
if (new Set(impossibleWorkflow30Cases.map((item) => item.id)).size !== 30) throw new Error('Impossible workflow case ids must be unique.');
