import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillRouter } from '../packages/core/src/routing/skill-router.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const corpusPath = resolve(process.env.JARVIS_EXECUTION_STRATEGY_CORPUS ?? joinFromRoot('scripts/fixtures/execution-strategy-corpus.json'));
const reportPath = resolve(process.env.JARVIS_EXECUTION_STRATEGY_REPORT ?? joinFromRoot('dist/verification/execution-strategy-audit.json'));
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
const router = new SkillRouter();
const matrix = router.capabilityMatrix();
const scenarioResults = [];

for (const scenario of corpus.scenarios ?? []) {
  const selection = router.shortlistCapabilities(matrix, {
    objective: scenario.objective,
    constraints: scenario.constraints ?? [],
    maxTools: scenario.maxTools
  });
  const primary = selection.capabilities[0] ?? null;
  const selectedSet = new Set(selection.selectedToolNames);
  const forbiddenSelections = selection.capabilities
    .filter((capability) => (scenario.forbiddenChannels ?? []).includes(capability.executionStrategy?.channel))
    .map((capability) => ({ toolName: capability.toolName, channel: capability.executionStrategy?.channel }));
  const checks = [
    check('primary-tool', primary?.toolName === scenario.expectedPrimaryTool, {
      expected: scenario.expectedPrimaryTool,
      actual: primary?.toolName ?? null
    }),
    check('catalog-bounded', selection.selectedCount <= scenario.maxTools, {
      selectedCount: selection.selectedCount,
      maxTools: scenario.maxTools
    }),
    check('catalog-unique', selectedSet.size === selection.selectedToolNames.length),
    check('required-tools-retained', (scenario.requiredTools ?? []).every((toolName) => selectedSet.has(toolName)), {
      required: scenario.requiredTools ?? [],
      selected: selection.selectedToolNames
    }),
    check('forbidden-channels-excluded', forbiddenSelections.length === 0, { forbiddenSelections }),
    check('strategy-evidence-complete', selection.capabilities.every((capability) => (
      capability.executionStrategy?.strategyVersion === 'a-execution-strategy-v1'
      && Number.isFinite(capability.executionStrategy?.score)
      && capability.executionStrategy?.rank >= 1
    )))
  ];
  scenarioResults.push({
    id: scenario.id,
    objective: scenario.objective,
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    primaryTool: primary?.toolName ?? null,
    primaryChannel: primary?.executionStrategy?.channel ?? null,
    selectedToolNames: selection.selectedToolNames,
    deferredCount: selection.deferredCount,
    checks
  });
}

const passedCount = scenarioResults.filter((scenario) => scenario.status === 'passed').length;
const defaultSelections = (corpus.scenarios ?? []).map((scenario) => router.shortlistCapabilities(matrix, {
  objective: scenario.objective,
  constraints: scenario.constraints ?? []
}));
const averageDefaultSelectedCount = average(defaultSelections.map((selection) => selection.selectedCount));
const averageDefaultDeferredCount = average(defaultSelections.map((selection) => selection.deferredCount));
const averageDefaultReductionPercent = matrix.length
  ? Math.round((1 - averageDefaultSelectedCount / matrix.length) * 10000) / 100
  : 0;
const report = {
  reportVersion: 'jarvis-execution-strategy-audit-v1',
  generatedAt: new Date().toISOString(),
  status: passedCount === scenarioResults.length ? 'passed' : 'failed',
  corpusVersion: corpus.corpusVersion,
  corpusPath,
  scenarioCount: scenarioResults.length,
  passedCount,
  failedCount: scenarioResults.length - passedCount,
  skillCount: matrix.length,
  efficiency: {
    defaultMaxCatalogSize: router.executionStrategyRouter.maxCatalogSize,
    averageSelectedToolCount: averageDefaultSelectedCount,
    averageDeferredToolCount: averageDefaultDeferredCount,
    averageCatalogReductionPercent: averageDefaultReductionPercent,
    modelReceivesDeferredToolSchemas: false
  },
  fabric: router.executionFabricStatus(),
  scenarios: scenarioResults
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, renderMarkdown(report), 'utf8');

console.log(JSON.stringify({
  status: report.status,
  scenarios: `${report.passedCount}/${report.scenarioCount}`,
  skills: report.skillCount,
  availableChannels: report.fabric.availableChannels.map((item) => item.channel),
  missingChannels: report.fabric.missingChannels,
  averageCatalogReductionPercent: report.efficiency.averageCatalogReductionPercent,
  reportPath,
  markdownPath
}, null, 2));

if (report.status !== 'passed') process.exitCode = 1;

function joinFromRoot(path) {
  return resolve(repoRoot, path);
}

function check(id, passed, detail = null) {
  return { id, passed: passed === true, detail };
}

function average(values) {
  if (values.length === 0) return 0;
  return Math.round((values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length) * 100) / 100;
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS Execution Strategy Audit',
    '',
    `- Status: **${report.status.toUpperCase()}**`,
    `- Scenarios: **${report.passedCount}/${report.scenarioCount}**`,
    `- Registered skills: **${report.skillCount}**`,
    `- Default model catalog: **${report.efficiency.averageSelectedToolCount}/${report.skillCount}** tools (${report.efficiency.averageCatalogReductionPercent}% deferred)`,
    `- Available channels: ${report.fabric.availableChannels.map((item) => item.channel).join(', ')}`,
    `- Missing channels: ${report.fabric.missingChannels.join(', ') || 'none'}`,
    '',
    '| Scenario | Status | Primary route | Selected tools |',
    '| --- | --- | --- | --- |',
    ...report.scenarios.map((scenario) => `| ${scenario.id} | ${scenario.status} | ${scenario.primaryTool} (${scenario.primaryChannel}) | ${scenario.selectedToolNames.join(', ')} |`),
    ''
  ];
  return `${lines.join('\n')}\n`;
}
