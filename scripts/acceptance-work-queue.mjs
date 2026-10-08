import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

// This index preserves the acceptance ledger; it never promotes a gate.
const source = 'docs/universal-control-v3-acceptance.json';
const raw = readFileSync(source, 'utf8');
const ledger = JSON.parse(raw.replace(/^\uFEFF/, ''));
const packageSource = 'docs/expanded-build-work-packages.json';
const packageRaw = readFileSync(packageSource, 'utf8');
const build = JSON.parse(packageRaw);
if (build.acceptanceSource !== source || build.progressAuthority !== 'original-100-gates-only') {
  throw new Error('Build package must preserve the original acceptance authority');
}
const packages = build.packages.map(pkg => ({ ...pkg, acceptanceIds: pkg.acceptanceRanges.flatMap(([start,end]) => {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 100 || start > end) throw new Error('Invalid gate range');
  return Array.from({length:end-start+1},(_,i)=>`V3-${String(start+i).padStart(3,'0')}`);
}) }));
const packageIds = new Set(packages.map(pkg=>pkg.id));
if (packages.length !== 10 || packageIds.size !== 10 || packages.some(pkg=>pkg.dependsOn.some(id=>!packageIds.has(id)))) {
  throw new Error('Build package identity/dependencies invalid');
}
const tasks = ledger.stages.flatMap(stage => stage.gates.map(gate => ({
  id: gate.id, stage: stage.id, stageTitle: stage.title,
  workPackages: packages.filter(pkg=>pkg.acceptanceIds.includes(gate.id)).map(pkg=>pkg.id),
  requirement: gate.requirement, status: gate.status,
  evidence: gate.evidence ?? [], remainingConditions: gate.limitations ?? [],
  missingEvidence: (gate.evidence ?? []).filter(path => !existsSync(path)),
  completionRule: '원래 요구 전체의 실행·독립 검증 증거를 검토한 뒤에만 원장 상태 변경',
  nextAction: gate.status === 'verified' ? '기존 증거 회귀 유지'
    : gate.evidence?.length ? '기존 구현과 기록된 한계를 대조해 미충족 조건의 실행 검사 구성'
    : '기존 구현 검색 후 미구현 경로와 사전 조건을 확인하고 최소 종단 실행 구현'
})));
if (tasks.length !== 100 || new Set(tasks.map(task => task.id)).size !== 100) {
  throw new Error('Acceptance source must contain exactly 100 unique gates');
}
if (tasks.some(task=>!task.workPackages.length)) throw new Error('Build plan omitted an original acceptance gate');
const counts = Object.fromEntries(['verified', 'in_progress', 'pending'].map(status => [status, tasks.filter(task => task.status === status).length]));
if (Object.values(counts).reduce((a,b) => a+b,0) !== tasks.length) throw new Error('Unknown acceptance status');
writeFileSync('docs/universal-control-execution-queue.json', JSON.stringify({
  source, sourceSha256: createHash('sha256').update(raw).digest('hex'),
  snapshotAt: new Date().toISOString(), notIndependentValidation: true,
  progressDefinition: ledger.progressDefinition, counts,
  buildPackageSource: packageSource, buildPackageSha256: createHash('sha256').update(packageRaw).digest('hex'),
  workPackages: packages, tasks
}, null, 2) + '\n');
console.log(JSON.stringify({total: tasks.length, counts, statusChanges: 0, missingEvidence: tasks.reduce((n,t) => n+t.missingEvidence.length,0)}));
