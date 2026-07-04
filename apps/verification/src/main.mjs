import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ModuleId } from '../../../packages/shared/src/types.js';
import { readJsonBody, routeParams, routePath, safeHandle, sendJson } from '../../../packages/shared/src/http.js';
import { createOpenApiSpecFromRouteContracts, createRouteContract } from '../../../packages/shared/src/openapi-contract.js';
import { VerificationRuntime } from './verification-runtime.js';

export const verificationRouteContracts = [
  createRouteContract('GET', '/health', 'Read G verification health.'),
  createRouteContract('GET', '/openapi.json', 'Read G verification OpenAPI contract.'),
  createRouteContract('POST', '/verify/plan', 'Verify an A task plan.'),
  createRouteContract('GET', '/verify/plan/fixtures', 'Read plan verifier fixture pack.'),
  createRouteContract('POST', '/verify/plan/fixtures/run', 'Run plan verifier fixture pack.'),
  createRouteContract('GET', '/verify/plan/fixtures/trend', 'Read plan verifier fixture trend.'),
  createRouteContract('POST', '/verify/plan/document-diff-fixtures/run', 'Generate and run plan fixtures from document revision diffs.'),
  createRouteContract('GET', '/verify/plan/regression-visualization', 'Read plan verifier long-term regression visualization.'),
  createRouteContract('POST', '/verify/plan/ci-annotation', 'Export plan verifier CI annotation.'),
  createRouteContract('POST', '/verify/plan/artifacts/sync', 'Sync plan verifier artifacts to immutable artifact store.'),
  createRouteContract('POST', '/verify/plan/product-gate', 'Run plan verifier product readiness gate.'),
  createRouteContract('GET', '/documents/invariants', 'Read document-derived invariant catalog.'),
  createRouteContract('POST', '/documents/invariants/run', 'Run document invariant extraction.'),
  createRouteContract('GET', '/documents/invariants/trend', 'Read document invariant extraction trend.'),
  createRouteContract('GET', '/documents/invariants/dedupe', 'Read semantic invariant dedupe classifier.'),
  createRouteContract('POST', '/verify/policy', 'Verify E policy result.'),
  createRouteContract('POST', '/verify/policy/ci-annotation', 'Export policy compliance CI annotation.'),
  createRouteContract('POST', '/verify/policy/migration-approval-artifact', 'Export signed policy migration approval artifact.'),
  createRouteContract('POST', '/verify/policy/product-gate', 'Run policy compliance product readiness gate.'),
  createRouteContract('POST', '/verify/execution', 'Verify B execution evidence.'),
  createRouteContract('POST', '/verify/execution/corpus', 'Run execution verifier fixture corpus.'),
  createRouteContract('GET', '/verify/execution/trend', 'Read execution verifier trend.'),
  createRouteContract('GET', '/verify/execution/external-fixtures', 'Read execution verifier external adapter fixture pack.'),
  createRouteContract('POST', '/verify/execution/soak', 'Run execution verifier adapter soak trend.'),
  createRouteContract('GET', '/verify/execution/retention', 'Read execution verifier artifact retention dashboard.'),
  createRouteContract('GET', '/verify/execution/quarantine', 'Read execution verifier flaky fixture quarantine.'),
  createRouteContract('POST', '/verify/execution/product-gate', 'Run execution verifier product readiness gate.'),
  createRouteContract('POST', '/verify/execution/release-dossier', 'Create execution verifier release dossier.'),
  createRouteContract('POST', '/verify/learning', 'Verify F learning event.'),
  createRouteContract('GET', '/verify/learning/fixtures', 'Read learning verifier fixture pack.'),
  createRouteContract('POST', '/verify/learning/fixtures/run', 'Run learning verifier fixture pack.'),
  createRouteContract('POST', '/verify/learning/ci-annotation', 'Export learning verifier CI annotation.'),
  createRouteContract('POST', '/verify/learning/artifacts/sync', 'Sync learning verifier artifacts to immutable artifact store.'),
  createRouteContract('POST', '/verify/learning/product-gate', 'Run learning verifier product readiness gate.'),
  createRouteContract('POST', '/verify/approval-flow', 'Verify C approval flow.'),
  createRouteContract('POST', '/verify/approval-flow/corpus', 'Run approval-flow verifier fixture corpus.'),
  createRouteContract('GET', '/verify/approval-flow/trend', 'Read approval-flow verifier trend.'),
  createRouteContract('GET', '/verify/approval-flow/device-smoke', 'Read approval-flow device security smoke contract.'),
  createRouteContract('GET', '/verify/approval-flow/ux-latency-trend', 'Read approval-flow UX latency trend.'),
  createRouteContract('GET', '/verify/approval-flow/retention', 'Read approval-flow artifact retention dashboard.'),
  createRouteContract('POST', '/verify/approval-flow/product-gate', 'Run approval-flow verifier product readiness gate.'),
  createRouteContract('POST', '/verify/approval-flow/release-dossier', 'Create approval-flow release dossier.'),
  createRouteContract('POST', '/verify/bridge', 'Verify D bridge behavior.'),
  createRouteContract('GET', '/bridge-security/corpus', 'Read bridge security corpus.'),
  createRouteContract('POST', '/bridge-security/product-drill', 'Run bridge security product chaos drill.'),
  createRouteContract('POST', '/bridge-security/release-dossier', 'Create bridge security release dossier.'),
  createRouteContract('POST', '/simulate', 'Run a simulation scenario.'),
  createRouteContract('GET', '/simulation/scenarios', 'Read simulation scenarios.'),
  createRouteContract('GET', '/simulation/expanded-scenarios', 'Read expanded simulation scenario pack.'),
  createRouteContract('POST', '/simulation/chaos-schedule/run', 'Run dry-run chaos simulation schedule.'),
  createRouteContract('GET', '/simulation/trend', 'Read simulation trend.'),
  createRouteContract('GET', '/simulation/trend/retention', 'Read simulation trend retention dashboard.'),
  createRouteContract('POST', '/simulation/release-dossier', 'Create simulation release dossier.'),
  createRouteContract('POST', '/redteam/run', 'Run redteam fixture pack.'),
  createRouteContract('GET', '/redteam/corpus', 'Read redteam corpus.'),
  createRouteContract('GET', '/redteam/trend', 'Read redteam CI trend dashboard.'),
  createRouteContract('GET', '/redteam/retention', 'Read redteam artifact retention dashboard.'),
  createRouteContract('GET', '/redteam/quarantine', 'Read redteam failed mutation quarantine queue.'),
  createRouteContract('POST', '/redteam/product-gate', 'Run prompt redteam product readiness gate.'),
  createRouteContract('POST', '/tool-poisoning-leak/run', 'Run tool poisoning/leak suite.'),
  createRouteContract('POST', '/tool-poisoning-leak/release-dossier', 'Create tool poisoning/leak release dossier.'),
  createRouteContract('POST', '/regression/run', 'Run regression suite.'),
  createRouteContract('GET', '/regression/external-fixtures', 'Read external regression fixture pack coverage.'),
  createRouteContract('GET', '/regression/dashboard', 'Read regression dashboard.'),
  createRouteContract('POST', '/regression/artifacts/sync', 'Sync regression artifacts to long-term artifact store.'),
  createRouteContract('POST', '/regression/product-gate', 'Run regression suite product readiness gate.'),
  createRouteContract('POST', '/regression/release-dossier', 'Create regression suite release dossier.'),
  createRouteContract('POST', '/release/gate', 'Run operational release gate.'),
  createRouteContract('POST', '/release/schedule/run', 'Run CI-style scheduled release gate cycles.'),
  createRouteContract('GET', '/fixtures/matrix', 'Read fixture matrix.'),
  createRouteContract('POST', '/fixtures/run', 'Run fixture matrix.'),
  createRouteContract('POST', '/score', 'Generate 12D score report.'),
  createRouteContract('GET', '/score/rubric', 'Read 12D score rubric.'),
  createRouteContract('GET', '/score/document-rubric', 'Extract 12D rubric coverage from A-G documents.'),
  createRouteContract('GET', '/score/dashboard', 'Read 12D score trend dashboard.'),
  createRouteContract('POST', '/score/gate', 'Run score gate.'),
  createRouteContract('POST', '/score/ci-annotation', 'Export 12D score CI annotation.'),
  createRouteContract('POST', '/score/product-gate', 'Run 12D score product readiness gate.'),
  createRouteContract('POST', '/golden-traces', 'Create approved golden trace.'),
  createRouteContract('GET', '/golden-traces', 'List golden traces.'),
  createRouteContract('GET', '/golden-traces/retention', 'Read golden trace retention dashboard.'),
  createRouteContract('POST', '/golden-traces/rotate', 'Dry-run or execute golden trace retention rotation.'),
  createRouteContract('POST', '/golden-traces/release-dossier', 'Create golden trace release dossier.'),
  createRouteContract('POST', '/baseline/compare', 'Compare against approved baseline.'),
  createRouteContract('POST', '/baseline/approved-update', 'Approve baseline update.'),
  createRouteContract('GET', '/baseline/approval-dashboard', 'Read baseline approval dashboard.'),
  createRouteContract('GET', '/baseline/ci-trend', 'Read golden trace CI trend visualization.'),
  createRouteContract('GET', '/baseline/trend', 'Read baseline trend.'),
  createRouteContract('GET', '/reports', 'List verification reports.'),
  createRouteContract('GET', '/reports/trend', 'Read report trend.'),
  createRouteContract('GET', '/reports/trend/visualization', 'Read report long-term trend visualization.'),
  createRouteContract('GET', '/reports/retention', 'Read report retention status.'),
  createRouteContract('GET', '/reports/retention-policy-ui', 'Read report retention policy UI contract.'),
  createRouteContract('POST', '/reports/artifacts/sync', 'Sync reports to immutable artifact store.'),
  createRouteContract('POST', '/reports/diff', 'Diff verification reports.'),
  createRouteContract('POST', '/reports/cleanup', 'Clean verification reports.'),
  createRouteContract('POST', '/reports/cleanup/approval', 'Request or execute approved report cleanup.'),
  createRouteContract('POST', '/reports/product-gate', 'Run report store product readiness gate.'),
  createRouteContract('POST', '/reports/release-dossier', 'Create report store release dossier.'),
  createRouteContract('GET', '/reports/:reportId', 'Read a verification report.')
];

export function createVerificationOpenApiSpec() {
  return createOpenApiSpecFromRouteContracts({
    title: 'JARVIS G Verification API',
    moduleId: ModuleId.VERIFICATION,
    routes: verificationRouteContracts
  });
}

export function createVerificationServer(verificationRuntime) {
  return http.createServer((request, response) => {
    safeHandle(response, async () => {
      const path = routePath(request);
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, { status: 'ok', module: ModuleId.VERIFICATION, version: '1.0.0' });
      }
      if (request.method === 'GET' && path === '/openapi.json') {
        return sendJson(response, 200, createVerificationOpenApiSpec());
      }
      if (request.method === 'POST' && path === '/verify/plan') {
        return sendJson(response, 200, verificationRuntime.verifyPlan(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/plan/fixtures') {
        return sendJson(response, 200, verificationRuntime.planVerifierFixturePack());
      }
      if (request.method === 'POST' && path === '/verify/plan/fixtures/run') {
        return sendJson(response, 200, verificationRuntime.runPlanVerifierFixturePack(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/plan/fixtures/trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.planVerifierFixtureTrend({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/verify/plan/document-diff-fixtures/run') {
        return sendJson(response, 200, verificationRuntime.runPlanDocumentDiffFixtures(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/plan/regression-visualization') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.planRegressionVisualization({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/verify/plan/ci-annotation') {
        return sendJson(response, 200, verificationRuntime.planVerifierCiAnnotation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/plan/artifacts/sync') {
        return sendJson(response, 200, verificationRuntime.syncPlanVerifierArtifacts(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/plan/product-gate') {
        return sendJson(response, 200, verificationRuntime.planVerifierProductGate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/documents/invariants') {
        return sendJson(response, 200, verificationRuntime.documentInvariantCatalog());
      }
      if (request.method === 'POST' && path === '/documents/invariants/run') {
        return sendJson(response, 200, verificationRuntime.runDocumentInvariantExtraction(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/documents/invariants/trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.documentInvariantTrend({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'GET' && path === '/documents/invariants/dedupe') {
        return sendJson(response, 200, verificationRuntime.semanticInvariantDedupeClassifier());
      }
      if (request.method === 'POST' && path === '/verify/policy') {
        return sendJson(response, 200, verificationRuntime.verifyPolicy(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/policy/ci-annotation') {
        return sendJson(response, 200, verificationRuntime.policyComplianceCiAnnotation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/policy/migration-approval-artifact') {
        return sendJson(response, 200, verificationRuntime.policyComplianceMigrationApprovalArtifact(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/policy/product-gate') {
        return sendJson(response, 200, verificationRuntime.policyComplianceProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/execution') {
        return sendJson(response, 200, await verificationRuntime.verifyExecution(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/execution/corpus') {
        return sendJson(response, 200, await verificationRuntime.runExecutionVerifierCorpus(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/execution/trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.executionVerifierTrend({ limit: Number(url.searchParams.get('limit') ?? 20) }));
      }
      if (request.method === 'GET' && path === '/verify/execution/external-fixtures') {
        return sendJson(response, 200, verificationRuntime.executionExternalAdapterFixturePack());
      }
      if (request.method === 'POST' && path === '/verify/execution/soak') {
        return sendJson(response, 200, await verificationRuntime.runExecutionAdapterSoak(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/execution/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.executionVerifierArtifactRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 50),
          dryRun: true
        }));
      }
      if (request.method === 'GET' && path === '/verify/execution/quarantine') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.executionFlakyFixtureQuarantine({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/verify/execution/product-gate') {
        return sendJson(response, 200, await verificationRuntime.executionVerifierProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/execution/release-dossier') {
        return sendJson(response, 200, await verificationRuntime.executionVerifierReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/learning') {
        return sendJson(response, 200, verificationRuntime.verifyLearning(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/learning/fixtures') {
        return sendJson(response, 200, verificationRuntime.learningVerifierFixturePack());
      }
      if (request.method === 'POST' && path === '/verify/learning/fixtures/run') {
        return sendJson(response, 200, verificationRuntime.runLearningVerifierFixturePack(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/learning/ci-annotation') {
        return sendJson(response, 200, verificationRuntime.learningVerifierCiAnnotation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/learning/artifacts/sync') {
        return sendJson(response, 200, verificationRuntime.syncLearningVerifierArtifacts(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/learning/product-gate') {
        return sendJson(response, 200, verificationRuntime.learningVerifierProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/approval-flow') {
        return sendJson(response, 200, verificationRuntime.verifyApprovalFlow(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/approval-flow/corpus') {
        return sendJson(response, 200, verificationRuntime.runApprovalFlowVerifierCorpus(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/verify/approval-flow/trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.approvalFlowVerifierTrend({ limit: Number(url.searchParams.get('limit') ?? 20) }));
      }
      if (request.method === 'GET' && path === '/verify/approval-flow/device-smoke') {
        return sendJson(response, 200, verificationRuntime.approvalFlowDeviceSecuritySmokeContract());
      }
      if (request.method === 'GET' && path === '/verify/approval-flow/ux-latency-trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.approvalFlowUxLatencyTrend({
          cycles: Number(url.searchParams.get('cycles') ?? 5)
        }));
      }
      if (request.method === 'GET' && path === '/verify/approval-flow/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.approvalFlowArtifactRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 50),
          dryRun: true
        }));
      }
      if (request.method === 'POST' && path === '/verify/approval-flow/product-gate') {
        return sendJson(response, 200, verificationRuntime.approvalFlowProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/approval-flow/release-dossier') {
        return sendJson(response, 200, verificationRuntime.approvalFlowReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/verify/bridge') {
        return sendJson(response, 200, verificationRuntime.verifyBridge(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/bridge-security/corpus') {
        return sendJson(response, 200, verificationRuntime.bridgeSecurityCorpus());
      }
      if (request.method === 'POST' && path === '/bridge-security/product-drill') {
        return sendJson(response, 200, verificationRuntime.bridgeSecurityProductDrill(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/bridge-security/release-dossier') {
        return sendJson(response, 200, verificationRuntime.bridgeSecurityReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/simulate') {
        return sendJson(response, 200, verificationRuntime.simulationRunner.run(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/simulation/scenarios') {
        return sendJson(response, 200, verificationRuntime.simulationCorpus());
      }
      if (request.method === 'GET' && path === '/simulation/expanded-scenarios') {
        return sendJson(response, 200, verificationRuntime.simulationExpandedScenarioPack());
      }
      if (request.method === 'POST' && path === '/simulation/chaos-schedule/run') {
        return sendJson(response, 200, verificationRuntime.runSimulationChaosSchedule(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/simulation/trend') {
        return sendJson(response, 200, verificationRuntime.simulationTrend());
      }
      if (request.method === 'GET' && path === '/simulation/trend/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.simulationTrendRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 50),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null,
          dryRun: true
        }));
      }
      if (request.method === 'POST' && path === '/simulation/release-dossier') {
        return sendJson(response, 200, verificationRuntime.simulationReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/redteam/run') {
        return sendJson(response, 200, verificationRuntime.runRedTeam(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/redteam/corpus') {
        return sendJson(response, 200, verificationRuntime.redTeamCorpus());
      }
      if (request.method === 'GET' && path === '/redteam/trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.redTeamTrend({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'GET' && path === '/redteam/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.redTeamRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 50),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null,
          dryRun: true
        }));
      }
      if (request.method === 'GET' && path === '/redteam/quarantine') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.redTeamQuarantine({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/redteam/product-gate') {
        return sendJson(response, 200, verificationRuntime.redTeamProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/tool-poisoning-leak/run') {
        return sendJson(response, 200, verificationRuntime.runToolPoisoningLeakSuite(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/tool-poisoning-leak/release-dossier') {
        return sendJson(response, 200, verificationRuntime.toolPoisoningLeakReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/regression/run') {
        return sendJson(response, 200, verificationRuntime.runRegressionSuite(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/regression/external-fixtures') {
        return sendJson(response, 200, verificationRuntime.regressionExternalFixturePack());
      }
      if (request.method === 'GET' && path === '/regression/dashboard') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.regressionDashboard({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/regression/artifacts/sync') {
        return sendJson(response, 200, verificationRuntime.syncRegressionArtifacts(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/regression/product-gate') {
        return sendJson(response, 200, verificationRuntime.regressionProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/regression/release-dossier') {
        return sendJson(response, 200, verificationRuntime.regressionReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/release/gate') {
        return sendJson(response, 200, verificationRuntime.operationalReleaseGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/release/schedule/run') {
        return sendJson(response, 200, verificationRuntime.releaseGateCiSchedule(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/fixtures/matrix') {
        return sendJson(response, 200, verificationRuntime.fixtureMatrixCatalog());
      }
      if (request.method === 'POST' && path === '/fixtures/run') {
        return sendJson(response, 200, verificationRuntime.runFixtureMatrix(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/score') {
        return sendJson(response, 200, verificationRuntime.scoreReport(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/score/rubric') {
        return sendJson(response, 200, verificationRuntime.scoreRubric());
      }
      if (request.method === 'GET' && path === '/score/document-rubric') {
        return sendJson(response, 200, verificationRuntime.scoreDocumentRubric());
      }
      if (request.method === 'GET' && path === '/score/dashboard') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.scoreDashboard({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'POST' && path === '/score/gate') {
        return sendJson(response, 200, verificationRuntime.scoreGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/score/ci-annotation') {
        return sendJson(response, 200, verificationRuntime.scoreCiAnnotation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/score/product-gate') {
        return sendJson(response, 200, verificationRuntime.scoreProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/golden-traces') {
        return sendJson(response, 200, verificationRuntime.createGoldenTrace(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/golden-traces') {
        return sendJson(response, 200, verificationRuntime.listGoldenTraces());
      }
      if (request.method === 'GET' && path === '/golden-traces/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.goldenTraceRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 50),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null
        }));
      }
      if (request.method === 'POST' && path === '/golden-traces/rotate') {
        return sendJson(response, 200, verificationRuntime.rotateGoldenTraces(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/golden-traces/release-dossier') {
        return sendJson(response, 200, verificationRuntime.goldenTraceReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/baseline/compare') {
        return sendJson(response, 200, verificationRuntime.compareBaseline(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/baseline/approved-update') {
        return sendJson(response, 200, verificationRuntime.approveBaselineUpdate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/baseline/approval-dashboard') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.baselineApprovalDashboard({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'GET' && path === '/baseline/ci-trend') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.goldenTraceCiTrendVisualization({
          limit: Number(url.searchParams.get('limit') ?? 20)
        }));
      }
      if (request.method === 'GET' && path === '/baseline/trend') {
        return sendJson(response, 200, verificationRuntime.baselineTrend());
      }
      if (request.method === 'GET' && path === '/reports') {
        return sendJson(response, 200, verificationRuntime.listReports());
      }
      if (request.method === 'GET' && path === '/reports/trend') {
        return sendJson(response, 200, verificationRuntime.reportTrend());
      }
      if (request.method === 'GET' && path === '/reports/trend/visualization') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.reportLongTermTrendVisualization({
          limit: Number(url.searchParams.get('limit') ?? 100)
        }));
      }
      if (request.method === 'GET' && path === '/reports/retention') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.reportRetention({
          keepLast: Number(url.searchParams.get('keepLast') ?? 100),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null
        }));
      }
      if (request.method === 'GET' && path === '/reports/retention-policy-ui') {
        const url = new URL(request.url, 'http://127.0.0.1');
        return sendJson(response, 200, verificationRuntime.reportRetentionPolicyUi({
          keepLast: Number(url.searchParams.get('keepLast') ?? 100),
          maxAgeMs: url.searchParams.has('maxAgeMs') ? Number(url.searchParams.get('maxAgeMs')) : null
        }));
      }
      if (request.method === 'POST' && path === '/reports/artifacts/sync') {
        return sendJson(response, 200, verificationRuntime.syncReportArtifacts(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/reports/diff') {
        return sendJson(response, 200, verificationRuntime.diffReports(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/reports/cleanup') {
        return sendJson(response, 200, verificationRuntime.cleanupReports(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/reports/cleanup/approval') {
        return sendJson(response, 200, verificationRuntime.reportCleanupApprovalWorkflow(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/reports/product-gate') {
        return sendJson(response, 200, verificationRuntime.reportStoreProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/reports/release-dossier') {
        return sendJson(response, 200, verificationRuntime.reportStoreReleaseDossier(await readJsonBody(request)));
      }
      const reportParams = routeParams('/reports/:reportId', path);
      if (request.method === 'GET' && reportParams) {
        return sendJson(response, 200, verificationRuntime.getReport(reportParams.reportId));
      }
      sendJson(response, 404, { success: false, error: { code: 'G_ROUTE_NOT_FOUND' } });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 17781);
  createVerificationServer(new VerificationRuntime()).listen(port, '127.0.0.1', () => {
    console.log(`JARVIS-G Verification listening at http://127.0.0.1:${port}`);
  });
}
