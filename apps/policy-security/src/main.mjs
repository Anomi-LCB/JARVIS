import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { ModuleId, stableId } from '../../../packages/shared/src/types.js';
import { readJsonBody, routePath, safeHandle, sendJson } from '../../../packages/shared/src/http.js';
import { createOpenApiSpecFromRouteContracts, createRouteContract } from '../../../packages/shared/src/openapi-contract.js';
import { POLICY_VERSION, PolicySecurityRuntime } from './policy-runtime.js';

export const policySecurityRouteContracts = [
  createRouteContract('GET', '/health', 'Read E policy/security health.'),
  createRouteContract('GET', '/openapi.json', 'Read E policy/security OpenAPI contract.'),
  createRouteContract('GET', '/policy/constitution', 'Read immutable safety constitution.'),
  createRouteContract('GET', '/policy/constitution/workflow', 'Read constitution change workflow status.'),
  createRouteContract('POST', '/policy/constitution/change', 'Propose a constitution change.'),
  createRouteContract('POST', '/policy/constitution/review', 'Review a constitution change request.'),
  createRouteContract('GET', '/policy/constitution/hash-regression', 'Run constitution hash regression fixtures.'),
  createRouteContract('POST', '/policy/constitution/release-dossier', 'Run immutable constitution release dossier checks.'),
  createRouteContract('GET', '/policy/as-code', 'Read policy-as-code status.'),
  createRouteContract('GET', '/policy/as-code/schema', 'Read policy-as-code external JSON Schema.'),
  createRouteContract('POST', '/policy/as-code/ci-annotation', 'Export policy-as-code CI annotation.'),
  createRouteContract('POST', '/policy/as-code/ci-approval-artifact', 'Export signed policy-as-code CI approval artifact.'),
  createRouteContract('POST', '/policy/as-code/release-dossier', 'Build hash-only policy-as-code release dossier.'),
  createRouteContract('POST', '/policy/as-code/product-gate', 'Run policy-as-code fixture matrix and drift gate.'),
  createRouteContract('GET', '/policy/bundle', 'Read signed policy bundle status.'),
  createRouteContract('POST', '/policy/bundle/rotate', 'Rotate a signed policy bundle.'),
  createRouteContract('POST', '/policy/reload', 'Reload a signed policy bundle.'),
  createRouteContract('GET', '/approval/policy/workflow', 'Read approval policy change workflow.'),
  createRouteContract('POST', '/approval/policy/change', 'Propose an approval policy change.'),
  createRouteContract('POST', '/approval/policy/review', 'Review an approval policy change.'),
  createRouteContract('GET', '/approval/policy/history', 'Read signed approval policy change history.'),
  createRouteContract('POST', '/approval/policy/rollback-drill', 'Run approval policy rollback drill.'),
  createRouteContract('POST', '/approval/policy/ci-approval-artifact', 'Export approval policy CI approval artifact.'),
  createRouteContract('POST', '/approval/policy/product-gate', 'Run approval policy product gate.'),
  createRouteContract('POST', '/policy/evaluate', 'Evaluate a task plan against policy.'),
  createRouteContract('POST', '/approval/validate', 'Validate an approval decision.'),
  createRouteContract('POST', '/security/scan', 'Scan content for prompt-injection and data risks.'),
  createRouteContract('GET', '/security/prompt-injection/corpus', 'Read prompt-injection corpus.'),
  createRouteContract('POST', '/security/prompt-injection/run', 'Run prompt-injection corpus checks.'),
  createRouteContract('GET', '/security/prompt-injection/semantic-adapter', 'Read prompt-injection semantic classifier adapter contract.'),
  createRouteContract('GET', '/security/prompt-injection/production-miss-corpus', 'Read hash-only prompt-injection production miss corpus.'),
  createRouteContract('POST', '/security/prompt-injection/semantic-trend', 'Run prompt-injection semantic provider comparison trend.'),
  createRouteContract('POST', '/security/prompt-injection/product-gate', 'Run prompt-injection product gate.'),
  createRouteContract('POST', '/security/prompt-injection/release-dossier', 'Build prompt-injection release dossier.'),
  createRouteContract('GET', '/security/redteam/corpus', 'Read E security redteam corpus.'),
  createRouteContract('POST', '/security/redteam/run', 'Run E security redteam corpus checks.'),
  createRouteContract('GET', '/security/redteam/trend', 'Read E security redteam trend.'),
  createRouteContract('GET', '/risk/calibration/corpus', 'Read risk-classifier calibration corpus.'),
  createRouteContract('POST', '/risk/calibration/run', 'Run risk-classifier calibration corpus.'),
  createRouteContract('POST', '/risk/calibration/review', 'Review a risk-classifier false-positive or false-negative.'),
  createRouteContract('GET', '/risk/operational-corpus', 'Read anonymized operational risk-calibration corpus.'),
  createRouteContract('POST', '/risk/drift-trend', 'Run risk-classifier policy drift trend checks.'),
  createRouteContract('POST', '/risk/release-dossier', 'Run risk-classifier release dossier checks.'),
  createRouteContract('POST', '/risk/product-gate', 'Run risk-classifier product gate.'),
  createRouteContract('POST', '/data/classify', 'Classify sensitive fields.'),
  createRouteContract('POST', '/data/false-positive-review', 'Review and suppress a data-classifier false positive.'),
  createRouteContract('POST', '/data/tuning-dashboard', 'Run data-classifier tuning corpus dashboard.'),
  createRouteContract('GET', '/data/external-ner-contract', 'Read optional external NER provider contract.'),
  createRouteContract('POST', '/data/precision-recall-trend', 'Run data-classifier precision/recall trend.'),
  createRouteContract('POST', '/data/product-gate', 'Run data-classifier product gate.'),
  createRouteContract('POST', '/data/release-dossier', 'Run data-classifier release dossier checks.'),
  createRouteContract('GET', '/data/minimizer-adapter', 'Read F minimizer adapter contract.'),
  createRouteContract('GET', '/audit/summary', 'Read policy audit summary.'),
  createRouteContract('POST', '/audit/search', 'Search policy audit events with DSL filters.'),
  createRouteContract('GET', '/audit/export', 'Export signed policy audit records.'),
  createRouteContract('GET', '/audit/siem-export', 'Export SIEM-compatible policy audit events.'),
  createRouteContract('POST', '/audit/retention/run', 'Run policy audit retention scheduler.'),
  createRouteContract('POST', '/audit/archive/sync', 'Sync policy audit archives to immutable storage manifest.'),
  createRouteContract('POST', '/audit/rotate', 'Rotate policy audit records.'),
  createRouteContract('POST', '/audit/product-gate', 'Run security audit API product gate.'),
  createRouteContract('POST', '/audit/release-dossier', 'Run security audit API release dossier checks.'),
  createRouteContract('POST', '/tool-output/evaluate', 'Evaluate tool output eligibility.'),
  createRouteContract('GET', '/tool-output/provenance', 'Read tool output provenance summary.'),
  createRouteContract('GET', '/tool-output/provenance/retention', 'Read tool provenance retention dashboard.'),
  createRouteContract('POST', '/tool-output/artifact-diff', 'Create sanitized tool-output artifact diff.'),
  createRouteContract('POST', '/tool-output/product-gate', 'Run tool poisoning product gate.'),
  createRouteContract('POST', '/tool-output/release-dossier', 'Run tool poisoning release dossier checks.'),
  createRouteContract('POST', '/capability/issue', 'Issue a scoped capability token.'),
  createRouteContract('POST', '/capability/validate', 'Validate a scoped capability token.'),
  createRouteContract('POST', '/capability/consume', 'Consume a scoped capability token.'),
  createRouteContract('POST', '/capability/revoke', 'Revoke a scoped capability token.'),
  createRouteContract('GET', '/capability/journal', 'Read capability token journal.'),
  createRouteContract('GET', '/capability/signing-key', 'Read capability token signing key provider status.'),
  createRouteContract('POST', '/capability/key-rotation-drill', 'Run capability signing key rotation drill.'),
  createRouteContract('GET', '/capability/journal/export', 'Export encrypted capability token journal.'),
  createRouteContract('POST', '/capability/journal/import-recovery', 'Recover capability token ledger from encrypted journal export.'),
  createRouteContract('POST', '/capability/lifecycle/product-gate', 'Run capability token lifecycle product gate.'),
  createRouteContract('POST', '/capability/lifecycle/release-dossier', 'Run capability token lifecycle release dossier checks.'),
  createRouteContract('POST', '/autonomy/evaluate', 'Evaluate an autonomy candidate.'),
  createRouteContract('GET', '/autonomy/evaluations', 'Read autonomy evaluation ledger.'),
  createRouteContract('GET', '/autonomy/trend', 'Read autonomy policy decision trend.'),
  createRouteContract('POST', '/autonomy/review', 'Review an autonomy policy evaluation.'),
  createRouteContract('POST', '/autonomy/product-gate', 'Run autonomy contract product gate.'),
  createRouteContract('POST', '/autonomy/release-dossier', 'Run autonomy contract release dossier checks.')
];

export function createPolicySecurityOpenApiSpec() {
  return createOpenApiSpecFromRouteContracts({
    title: 'JARVIS E Policy/Security API',
    moduleId: ModuleId.POLICY_SECURITY,
    routes: policySecurityRouteContracts
  });
}

export function createPolicySecurityServer(policyRuntime) {
  return http.createServer((request, response) => {
    safeHandle(response, async () => {
      const path = routePath(request);
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && path === '/health') {
        return sendJson(response, 200, { status: 'ok', module: ModuleId.POLICY_SECURITY, version: '1.0.0', policyVersion: policyRuntime.policyVersion ?? POLICY_VERSION });
      }
      if (request.method === 'GET' && path === '/openapi.json') {
        return sendJson(response, 200, createPolicySecurityOpenApiSpec());
      }
      if (request.method === 'GET' && path === '/policy/constitution') {
        return sendJson(response, 200, {
          policyVersion: policyRuntime.policyVersion ?? POLICY_VERSION,
          schemaVersion: policyRuntime.compiledPolicy.schemaVersion,
          principles: policyRuntime.compiledPolicy.constitution.principles,
          constitutionHash: policyRuntime.compiledPolicy.constitutionHash,
          immutable: true,
          pinned: true,
          workflow: policyRuntime.constitutionWorkflowStatus(),
          policyBundle: policyRuntime.policyBundleStatus()
        });
      }
      if (request.method === 'GET' && path === '/policy/constitution/workflow') {
        return sendJson(response, 200, policyRuntime.constitutionWorkflowStatus());
      }
      if (request.method === 'POST' && path === '/policy/constitution/change') {
        return sendJson(response, 200, policyRuntime.proposeConstitutionChange(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/constitution/review') {
        return sendJson(response, 200, policyRuntime.reviewConstitutionChange(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/policy/constitution/hash-regression') {
        return sendJson(response, 200, policyRuntime.constitutionHashRegression());
      }
      if (request.method === 'POST' && path === '/policy/constitution/release-dossier') {
        return sendJson(response, 200, policyRuntime.constitutionReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/policy/as-code') {
        return sendJson(response, 200, policyRuntime.policyAsCodeStatus());
      }
      if (request.method === 'GET' && path === '/policy/as-code/schema') {
        return sendJson(response, 200, policyRuntime.policyCompiler.externalJsonSchema());
      }
      if (request.method === 'POST' && path === '/policy/as-code/ci-annotation') {
        return sendJson(response, 200, policyRuntime.policyAsCodeCiAnnotation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/as-code/ci-approval-artifact') {
        return sendJson(response, 200, policyRuntime.policyAsCodeCiApprovalArtifact(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/as-code/release-dossier') {
        return sendJson(response, 200, policyRuntime.policyAsCodeReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/as-code/product-gate') {
        return sendJson(response, 200, policyRuntime.policyAsCodeProductGate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/policy/bundle') {
        return sendJson(response, 200, {
          module: ModuleId.POLICY_SECURITY,
          generatedAt: new Date().toISOString(),
          bundle: policyRuntime.policyBundleStatus()
        });
      }
      if (request.method === 'POST' && path === '/policy/bundle/rotate') {
        return sendJson(response, 200, policyRuntime.rotateSignedPolicyBundle(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/reload') {
        return sendJson(response, 200, policyRuntime.reloadPolicy(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/approval/policy/workflow') {
        return sendJson(response, 200, policyRuntime.approvalPolicyWorkflowStatus());
      }
      if (request.method === 'POST' && path === '/approval/policy/change') {
        return sendJson(response, 200, policyRuntime.proposeApprovalPolicyChange(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/approval/policy/review') {
        return sendJson(response, 200, policyRuntime.reviewApprovalPolicyChange(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/approval/policy/history') {
        return sendJson(response, 200, policyRuntime.approvalPolicySignedHistory({
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined
        }));
      }
      if (request.method === 'POST' && path === '/approval/policy/rollback-drill') {
        return sendJson(response, 200, policyRuntime.approvalPolicyRollbackDrill(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/approval/policy/ci-approval-artifact') {
        return sendJson(response, 200, policyRuntime.approvalPolicyCiApprovalArtifact(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/approval/policy/product-gate') {
        return sendJson(response, 200, policyRuntime.approvalPolicyProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/policy/evaluate') {
        const body = await readJsonBody(request);
        const createdAt = body.createdAt ?? new Date().toISOString();
        const action = body.action ?? {
          actionType: body.actionType,
          toolName: body.toolName ?? 'filesystem.createTextFile',
          skillId: body.skillId ?? 'jarvis.local.mvp'
        };
        return sendJson(
          response,
          200,
          policyRuntime.evaluatePlan({
            taskRequest: {
              createdAt,
              command: { rawText: body.userCommand ?? body.rawText ?? '' }
            },
            plan: {
              planId: body.planId ?? stableId('plan', body.actionType ?? 'action', createdAt),
              taskId: body.taskId ?? stableId('task', body.actionType ?? 'action', createdAt),
              action
            }
          })
        );
      }
      if (request.method === 'POST' && path === '/approval/validate') {
        return sendJson(response, 200, policyRuntime.validateApprovalDecision(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/security/scan') {
        return sendJson(response, 200, policyRuntime.scanContent(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/security/prompt-injection/corpus') {
        return sendJson(response, 200, {
          module: ModuleId.POLICY_SECURITY,
          cases: policyRuntime.promptInjectionCorpus()
        });
      }
      if (request.method === 'POST' && path === '/security/prompt-injection/run') {
        const body = await readJsonBody(request);
        return sendJson(response, 200, policyRuntime.runPromptInjectionCorpus(body.cases));
      }
      if (request.method === 'GET' && path === '/security/prompt-injection/semantic-adapter') {
        return sendJson(response, 200, policyRuntime.promptInjectionDetector.semanticAdapterContract());
      }
      if (request.method === 'GET' && path === '/security/prompt-injection/production-miss-corpus') {
        return sendJson(response, 200, policyRuntime.promptInjectionProductionMissCorpus());
      }
      if (request.method === 'POST' && path === '/security/prompt-injection/semantic-trend') {
        return sendJson(response, 200, policyRuntime.promptSemanticProviderTrend(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/security/prompt-injection/product-gate') {
        return sendJson(response, 200, policyRuntime.promptInjectionProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/security/prompt-injection/release-dossier') {
        return sendJson(response, 200, policyRuntime.promptInjectionReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/security/redteam/corpus') {
        return sendJson(response, 200, policyRuntime.securityRedteamCorpus());
      }
      if (request.method === 'POST' && path === '/security/redteam/run') {
        return sendJson(response, 200, policyRuntime.runSecurityRedteamCorpus(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/security/redteam/trend') {
        return sendJson(response, 200, policyRuntime.securityRedteamTrend({
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined
        }));
      }
      if (request.method === 'GET' && path === '/risk/calibration/corpus') {
        return sendJson(response, 200, policyRuntime.riskCalibrationCorpus());
      }
      if (request.method === 'POST' && path === '/risk/calibration/run') {
        return sendJson(response, 200, policyRuntime.runRiskCalibrationCorpus(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/risk/calibration/review') {
        return sendJson(response, 200, policyRuntime.reviewRiskCalibration(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/risk/operational-corpus') {
        return sendJson(response, 200, policyRuntime.riskOperationalCalibrationCorpus({
          minEvents: url.searchParams.get('minEvents') ? Number(url.searchParams.get('minEvents')) : undefined
        }));
      }
      if (request.method === 'POST' && path === '/risk/drift-trend') {
        return sendJson(response, 200, policyRuntime.riskPolicyDriftTrend(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/risk/release-dossier') {
        return sendJson(response, 200, policyRuntime.riskClassifierReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/risk/product-gate') {
        return sendJson(response, 200, policyRuntime.riskClassifierProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/data/classify') {
        const body = await readJsonBody(request);
        return sendJson(response, 200, policyRuntime.dataClassifier.classifyFields(body.record ?? body));
      }
      if (request.method === 'POST' && path === '/data/false-positive-review') {
        return sendJson(response, 200, policyRuntime.reviewDataClassifierFalsePositive(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/data/tuning-dashboard') {
        return sendJson(response, 200, policyRuntime.dataClassifierTuningDashboard(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/data/external-ner-contract') {
        return sendJson(response, 200, policyRuntime.dataClassifier.externalNerProviderContract());
      }
      if (request.method === 'POST' && path === '/data/precision-recall-trend') {
        return sendJson(response, 200, policyRuntime.dataClassifierPrecisionRecallTrend(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/data/product-gate') {
        return sendJson(response, 200, policyRuntime.dataClassifierProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/data/release-dossier') {
        return sendJson(response, 200, policyRuntime.dataClassifierReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/data/minimizer-adapter') {
        return sendJson(response, 200, policyRuntime.dataClassifier.minimizerAdapterContract());
      }
      if (request.method === 'GET' && path === '/audit/summary') {
        return sendJson(response, 200, policyRuntime.auditSummary({
          category: url.searchParams.get('category'),
          severity: url.searchParams.get('severity'),
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit')
        }));
      }
      if (request.method === 'POST' && path === '/audit/search') {
        return sendJson(response, 200, policyRuntime.auditSearch(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/audit/export') {
        return sendJson(response, 200, policyRuntime.auditExport({
          category: url.searchParams.get('category'),
          severity: url.searchParams.get('severity'),
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit'),
          reason: url.searchParams.get('reason') ?? 'http_audit_export'
        }));
      }
      if (request.method === 'GET' && path === '/audit/siem-export') {
        return sendJson(response, 200, policyRuntime.auditSiemExport({
          query: {
            category: url.searchParams.get('category'),
            severity: url.searchParams.get('severity'),
            contains: url.searchParams.get('contains')
          },
          format: url.searchParams.get('format') ?? 'cef',
          cursor: url.searchParams.get('cursor'),
          limit: url.searchParams.get('limit'),
          reason: url.searchParams.get('reason') ?? 'http_audit_siem_export'
        }));
      }
      if (request.method === 'POST' && path === '/audit/retention/run') {
        return sendJson(response, 200, policyRuntime.auditRetentionRun(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/audit/archive/sync') {
        return sendJson(response, 200, policyRuntime.auditArchiveSync(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/audit/rotate') {
        return sendJson(response, 200, policyRuntime.auditRotate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/audit/product-gate') {
        return sendJson(response, 200, policyRuntime.auditApiProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/audit/release-dossier') {
        return sendJson(response, 200, policyRuntime.auditApiReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/tool-output/evaluate') {
        return sendJson(response, 200, policyRuntime.evaluateToolOutput(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/tool-output/provenance') {
        return sendJson(response, 200, policyRuntime.toolProvenanceSummary());
      }
      if (request.method === 'GET' && path === '/tool-output/provenance/retention') {
        return sendJson(response, 200, policyRuntime.toolProvenanceRetentionDashboard({
          keepLast: url.searchParams.get('keepLast') ? Number(url.searchParams.get('keepLast')) : undefined
        }));
      }
      if (request.method === 'POST' && path === '/tool-output/artifact-diff') {
        return sendJson(response, 200, policyRuntime.toolOutputArtifactDiff(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/tool-output/product-gate') {
        return sendJson(response, 200, policyRuntime.toolPoisoningProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/tool-output/release-dossier') {
        return sendJson(response, 200, policyRuntime.toolPoisoningReleaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/issue') {
        return sendJson(response, 200, policyRuntime.capabilities.issue(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/validate') {
        return sendJson(response, 200, policyRuntime.capabilities.validate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/consume') {
        return sendJson(response, 200, policyRuntime.capabilities.consume(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/revoke') {
        return sendJson(response, 200, policyRuntime.capabilities.revoke(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/capability/journal') {
        return sendJson(response, 200, {
          module: ModuleId.POLICY_SECURITY,
          generatedAt: new Date().toISOString(),
          ...policyRuntime.capabilities.journalSnapshot()
        });
      }
      if (request.method === 'GET' && path === '/capability/signing-key') {
        return sendJson(response, 200, {
          module: ModuleId.POLICY_SECURITY,
          ...policyRuntime.capabilities.signingKeyProviderStatus()
        });
      }
      if (request.method === 'POST' && path === '/capability/key-rotation-drill') {
        return sendJson(response, 200, policyRuntime.capabilities.keyRotationDrill(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/capability/journal/export') {
        return sendJson(response, 200, policyRuntime.capabilities.exportEncryptedJournal({
          reason: url.searchParams.get('reason') ?? 'http_capability_journal_export'
        }));
      }
      if (request.method === 'POST' && path === '/capability/journal/import-recovery') {
        return sendJson(response, 200, policyRuntime.capabilities.importEncryptedJournal(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/lifecycle/product-gate') {
        return sendJson(response, 200, policyRuntime.capabilities.productLifecycleGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/capability/lifecycle/release-dossier') {
        return sendJson(response, 200, policyRuntime.capabilities.releaseDossier(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/autonomy/evaluate') {
        return sendJson(response, 200, policyRuntime.evaluateAutonomyCandidate(await readJsonBody(request)));
      }
      if (request.method === 'GET' && path === '/autonomy/evaluations') {
        return sendJson(response, 200, policyRuntime.autonomyEvaluationLedgerSnapshot({
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50
        }));
      }
      if (request.method === 'GET' && path === '/autonomy/trend') {
        return sendJson(response, 200, policyRuntime.autonomyDecisionTrend({
          limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50
        }));
      }
      if (request.method === 'POST' && path === '/autonomy/review') {
        return sendJson(response, 200, policyRuntime.reviewAutonomyEvaluation(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/autonomy/product-gate') {
        return sendJson(response, 200, policyRuntime.autonomyProductGate(await readJsonBody(request)));
      }
      if (request.method === 'POST' && path === '/autonomy/release-dossier') {
        return sendJson(response, 200, policyRuntime.autonomyReleaseDossier(await readJsonBody(request)));
      }
      sendJson(response, 404, { success: false, error: { code: 'E_ROUTE_NOT_FOUND' } });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 17782);
  createPolicySecurityServer(new PolicySecurityRuntime()).listen(port, '127.0.0.1', () => {
    console.log(`JARVIS-E Policy Security listening at http://127.0.0.1:${port}`);
  });
}
