// Generated from ContractRegistry.federatedOpenApiBundle
// a-federated-openapi-client-types-v1
// generatedAt 2026-07-04T12:11:47.896Z
export const federatedOpenApiBundleHash = "sha256:04e5361fde8566d8e850574bd3447d3c0130224fdb0788dfb2dc3833063a6e68";
export const federatedOpenApiBundleVersion = "a-federated-openapi-contract-bundle-v1";
export type FederatedOpenApiModuleId =
  | "A_CORE"
  | "B_PC_AGENT"
  | "D_BRIDGE"
  | "E_POLICY_SECURITY"
  | "F_GROWTH_MEMORY"
  | "G_VERIFICATION";
export type FederatedOpenApiRouteKey =
  | "A_CORE:GET:/admin/diagnostics"
  | "A_CORE:GET:/health"
  | "A_CORE:GET:/openapi.json"
  | "A_CORE:GET:/runtime/supervisor"
  | "A_CORE:GET:/tasks"
  | "A_CORE:GET:/tasks/{taskId}"
  | "A_CORE:GET:/tasks/{taskId}/plan-artifacts"
  | "A_CORE:GET:/tasks/{taskId}/resume"
  | "A_CORE:GET:/worker/daemon"
  | "A_CORE:GET:/worker/leases"
  | "A_CORE:GET:/worker/plan-artifacts"
  | "A_CORE:GET:/worker/queue"
  | "A_CORE:GET:/worker/timeouts"
  | "A_CORE:POST:/runtime/service-plan"
  | "A_CORE:POST:/runtime/supervisor/tick"
  | "A_CORE:POST:/tasks"
  | "A_CORE:POST:/tasks/{taskId}/approve"
  | "A_CORE:POST:/tasks/{taskId}/compensation"
  | "A_CORE:POST:/tasks/{taskId}/compensation/run"
  | "A_CORE:POST:/tasks/{taskId}/plan-graph/product-gate"
  | "A_CORE:POST:/tasks/{taskId}/queue"
  | "A_CORE:POST:/tasks/{taskId}/run"
  | "A_CORE:POST:/worker/daemon/start"
  | "A_CORE:POST:/worker/daemon/stop"
  | "A_CORE:POST:/worker/daemon/tick"
  | "A_CORE:POST:/worker/leases/recover"
  | "A_CORE:POST:/worker/queue/drain"
  | "A_CORE:POST:/worker/state-product-gate"
  | "B_PC_AGENT:GET:/api/contract-snapshot"
  | "B_PC_AGENT:GET:/api/security/status"
  | "B_PC_AGENT:GET:/capability-vault/export"
  | "B_PC_AGENT:GET:/capability-vault/status"
  | "B_PC_AGENT:GET:/evidence/privacy-fixtures"
  | "B_PC_AGENT:GET:/evidence/query"
  | "B_PC_AGENT:GET:/evidence/retention"
  | "B_PC_AGENT:GET:/evidence/schema-snapshot"
  | "B_PC_AGENT:GET:/execution-packets/journal"
  | "B_PC_AGENT:GET:/execution-packets/queue"
  | "B_PC_AGENT:GET:/execution-packets/queue/poison"
  | "B_PC_AGENT:GET:/execution-packets/queue/policy"
  | "B_PC_AGENT:GET:/health"
  | "B_PC_AGENT:GET:/logs/recent"
  | "B_PC_AGENT:GET:/memory-events/query"
  | "B_PC_AGENT:GET:/memory-events/recent"
  | "B_PC_AGENT:GET:/openapi.json"
  | "B_PC_AGENT:GET:/rollback/{taskId}/plan"
  | "B_PC_AGENT:GET:/rollback/journal"
  | "B_PC_AGENT:GET:/rollback/transactions"
  | "B_PC_AGENT:GET:/service/runtime"
  | "B_PC_AGENT:GET:/service/status"
  | "B_PC_AGENT:GET:/service/verification"
  | "B_PC_AGENT:GET:/tasks/{taskId}"
  | "B_PC_AGENT:GET:/tasks/{taskId}/evidence"
  | "B_PC_AGENT:GET:/tasks/{taskId}/result"
  | "B_PC_AGENT:GET:/tray/state"
  | "B_PC_AGENT:POST:/api/product-gate"
  | "B_PC_AGENT:POST:/capability-vault/import-recovery"
  | "B_PC_AGENT:POST:/capability-vault/key-rotation-drill"
  | "B_PC_AGENT:POST:/capability-vault/product-gate"
  | "B_PC_AGENT:POST:/evidence/product-gate"
  | "B_PC_AGENT:POST:/evidence/rotate"
  | "B_PC_AGENT:POST:/evidence/schema-regression"
  | "B_PC_AGENT:POST:/execution-packets"
  | "B_PC_AGENT:POST:/execution-packets/queue"
  | "B_PC_AGENT:POST:/execution-packets/queue/drain"
  | "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/ignore"
  | "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/requeue"
  | "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/review"
  | "B_PC_AGENT:POST:/execution-packets/queue/policy"
  | "B_PC_AGENT:POST:/rollback/{taskId}"
  | "B_PC_AGENT:POST:/rollback/{taskId}/export"
  | "B_PC_AGENT:POST:/rollback/product-gate"
  | "D_BRIDGE:DELETE:/devices/{deviceId}"
  | "D_BRIDGE:GET:/approvals"
  | "D_BRIDGE:GET:/approvals/{approvalId}"
  | "D_BRIDGE:GET:/approvals/{approvalId}/history"
  | "D_BRIDGE:GET:/audit/export"
  | "D_BRIDGE:GET:/audit/siem-export"
  | "D_BRIDGE:GET:/audit/summary"
  | "D_BRIDGE:GET:/cache/schema-snapshot"
  | "D_BRIDGE:GET:/cache/snapshot"
  | "D_BRIDGE:GET:/devices"
  | "D_BRIDGE:GET:/devices/inventory"
  | "D_BRIDGE:GET:/devices/token/policy"
  | "D_BRIDGE:GET:/events"
  | "D_BRIDGE:GET:/events/fallback-ux"
  | "D_BRIDGE:GET:/events/reconnect-plan"
  | "D_BRIDGE:GET:/events/stream"
  | "D_BRIDGE:GET:/events/stream/status"
  | "D_BRIDGE:GET:/events/ws"
  | "D_BRIDGE:GET:/growth/decisions/history"
  | "D_BRIDGE:GET:/growth/decisions/trends"
  | "D_BRIDGE:GET:/growth/review/latest"
  | "D_BRIDGE:GET:/health"
  | "D_BRIDGE:GET:/openapi.json"
  | "D_BRIDGE:GET:/pc-agent/poison-packets"
  | "D_BRIDGE:GET:/pc-agent/queue-policy"
  | "D_BRIDGE:GET:/pc-console/approval-handoffs"
  | "D_BRIDGE:GET:/rate-limit/abuse-corpus"
  | "D_BRIDGE:GET:/rate-limit/status"
  | "D_BRIDGE:GET:/request-nonces/clock-skew-fixtures"
  | "D_BRIDGE:GET:/request-nonces/policy"
  | "D_BRIDGE:GET:/results/{taskId}"
  | "D_BRIDGE:GET:/server/deployment-profile"
  | "D_BRIDGE:GET:/server/profile"
  | "D_BRIDGE:GET:/server/reverse-proxy-lab"
  | "D_BRIDGE:GET:/tasks"
  | "D_BRIDGE:GET:/tasks/{taskId}"
  | "D_BRIDGE:POST:/approvals/{approvalId}/cancel"
  | "D_BRIDGE:POST:/approvals/{approvalId}/decision"
  | "D_BRIDGE:POST:/approvals/{approvalId}/pc-handoff"
  | "D_BRIDGE:POST:/approvals/{approvalId}/re-request"
  | "D_BRIDGE:POST:/approvals/{approvalId}/renew"
  | "D_BRIDGE:POST:/audit/archive/restore-drill"
  | "D_BRIDGE:POST:/audit/archive/sync"
  | "D_BRIDGE:POST:/audit/product-gate"
  | "D_BRIDGE:POST:/audit/release-dossier"
  | "D_BRIDGE:POST:/audit/retention/run"
  | "D_BRIDGE:POST:/audit/rotate"
  | "D_BRIDGE:POST:/cache/compact"
  | "D_BRIDGE:POST:/cache/product-gate"
  | "D_BRIDGE:POST:/cache/release-dossier"
  | "D_BRIDGE:POST:/cache/schema-diff"
  | "D_BRIDGE:POST:/connection/heartbeat"
  | "D_BRIDGE:POST:/devices/token/release-dossier"
  | "D_BRIDGE:POST:/devices/token/rotate"
  | "D_BRIDGE:POST:/devices/token/rotation-drill"
  | "D_BRIDGE:POST:/events/ack"
  | "D_BRIDGE:POST:/events/chaos-drill"
  | "D_BRIDGE:POST:/events/cursors/compact"
  | "D_BRIDGE:POST:/events/product-gate"
  | "D_BRIDGE:POST:/events/release-dossier"
  | "D_BRIDGE:POST:/execution-handoffs/{handoffId}/confirm"
  | "D_BRIDGE:POST:/feedback"
  | "D_BRIDGE:POST:/growth/hygiene/decisions"
  | "D_BRIDGE:POST:/growth/hygiene/decisions/batch"
  | "D_BRIDGE:POST:/growth/preferences/{hypothesisId}/decision"
  | "D_BRIDGE:POST:/growth/routing/release-dossier"
  | "D_BRIDGE:POST:/pairing/confirm"
  | "D_BRIDGE:POST:/pairing/release-dossier"
  | "D_BRIDGE:POST:/pairing/start"
  | "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/ignore"
  | "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/requeue"
  | "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/review"
  | "D_BRIDGE:POST:/pc-agent/queue-policy"
  | "D_BRIDGE:POST:/pc-agent/queue/drain"
  | "D_BRIDGE:POST:/pc-console/approval-handoffs/{handoffId}/decision"
  | "D_BRIDGE:POST:/rate-limit/product-gate"
  | "D_BRIDGE:POST:/rate-limit/release-dossier"
  | "D_BRIDGE:POST:/request-nonces/compact"
  | "D_BRIDGE:POST:/request-nonces/product-gate"
  | "D_BRIDGE:POST:/request-nonces/release-dossier"
  | "D_BRIDGE:POST:/results/{taskId}/rollback"
  | "D_BRIDGE:POST:/server/product-gate"
  | "D_BRIDGE:POST:/task-approval-result/release-dossier"
  | "D_BRIDGE:POST:/tasks"
  | "E_POLICY_SECURITY:GET:/approval/policy/history"
  | "E_POLICY_SECURITY:GET:/approval/policy/workflow"
  | "E_POLICY_SECURITY:GET:/audit/export"
  | "E_POLICY_SECURITY:GET:/audit/siem-export"
  | "E_POLICY_SECURITY:GET:/audit/summary"
  | "E_POLICY_SECURITY:GET:/autonomy/evaluations"
  | "E_POLICY_SECURITY:GET:/autonomy/trend"
  | "E_POLICY_SECURITY:GET:/capability/journal"
  | "E_POLICY_SECURITY:GET:/capability/journal/export"
  | "E_POLICY_SECURITY:GET:/capability/signing-key"
  | "E_POLICY_SECURITY:GET:/data/external-ner-contract"
  | "E_POLICY_SECURITY:GET:/data/minimizer-adapter"
  | "E_POLICY_SECURITY:GET:/health"
  | "E_POLICY_SECURITY:GET:/openapi.json"
  | "E_POLICY_SECURITY:GET:/policy/as-code"
  | "E_POLICY_SECURITY:GET:/policy/as-code/schema"
  | "E_POLICY_SECURITY:GET:/policy/bundle"
  | "E_POLICY_SECURITY:GET:/policy/constitution"
  | "E_POLICY_SECURITY:GET:/policy/constitution/hash-regression"
  | "E_POLICY_SECURITY:GET:/policy/constitution/workflow"
  | "E_POLICY_SECURITY:GET:/risk/calibration/corpus"
  | "E_POLICY_SECURITY:GET:/risk/operational-corpus"
  | "E_POLICY_SECURITY:GET:/security/prompt-injection/corpus"
  | "E_POLICY_SECURITY:GET:/security/prompt-injection/production-miss-corpus"
  | "E_POLICY_SECURITY:GET:/security/prompt-injection/semantic-adapter"
  | "E_POLICY_SECURITY:GET:/security/redteam/corpus"
  | "E_POLICY_SECURITY:GET:/security/redteam/trend"
  | "E_POLICY_SECURITY:GET:/tool-output/provenance"
  | "E_POLICY_SECURITY:GET:/tool-output/provenance/retention"
  | "E_POLICY_SECURITY:POST:/approval/policy/change"
  | "E_POLICY_SECURITY:POST:/approval/policy/ci-approval-artifact"
  | "E_POLICY_SECURITY:POST:/approval/policy/product-gate"
  | "E_POLICY_SECURITY:POST:/approval/policy/review"
  | "E_POLICY_SECURITY:POST:/approval/policy/rollback-drill"
  | "E_POLICY_SECURITY:POST:/approval/validate"
  | "E_POLICY_SECURITY:POST:/audit/archive/sync"
  | "E_POLICY_SECURITY:POST:/audit/product-gate"
  | "E_POLICY_SECURITY:POST:/audit/release-dossier"
  | "E_POLICY_SECURITY:POST:/audit/retention/run"
  | "E_POLICY_SECURITY:POST:/audit/rotate"
  | "E_POLICY_SECURITY:POST:/audit/search"
  | "E_POLICY_SECURITY:POST:/autonomy/evaluate"
  | "E_POLICY_SECURITY:POST:/autonomy/product-gate"
  | "E_POLICY_SECURITY:POST:/autonomy/release-dossier"
  | "E_POLICY_SECURITY:POST:/autonomy/review"
  | "E_POLICY_SECURITY:POST:/capability/consume"
  | "E_POLICY_SECURITY:POST:/capability/issue"
  | "E_POLICY_SECURITY:POST:/capability/journal/import-recovery"
  | "E_POLICY_SECURITY:POST:/capability/key-rotation-drill"
  | "E_POLICY_SECURITY:POST:/capability/lifecycle/product-gate"
  | "E_POLICY_SECURITY:POST:/capability/lifecycle/release-dossier"
  | "E_POLICY_SECURITY:POST:/capability/revoke"
  | "E_POLICY_SECURITY:POST:/capability/validate"
  | "E_POLICY_SECURITY:POST:/data/classify"
  | "E_POLICY_SECURITY:POST:/data/false-positive-review"
  | "E_POLICY_SECURITY:POST:/data/precision-recall-trend"
  | "E_POLICY_SECURITY:POST:/data/product-gate"
  | "E_POLICY_SECURITY:POST:/data/release-dossier"
  | "E_POLICY_SECURITY:POST:/data/tuning-dashboard"
  | "E_POLICY_SECURITY:POST:/policy/as-code/ci-annotation"
  | "E_POLICY_SECURITY:POST:/policy/as-code/ci-approval-artifact"
  | "E_POLICY_SECURITY:POST:/policy/as-code/product-gate"
  | "E_POLICY_SECURITY:POST:/policy/as-code/release-dossier"
  | "E_POLICY_SECURITY:POST:/policy/bundle/rotate"
  | "E_POLICY_SECURITY:POST:/policy/constitution/change"
  | "E_POLICY_SECURITY:POST:/policy/constitution/release-dossier"
  | "E_POLICY_SECURITY:POST:/policy/constitution/review"
  | "E_POLICY_SECURITY:POST:/policy/evaluate"
  | "E_POLICY_SECURITY:POST:/policy/reload"
  | "E_POLICY_SECURITY:POST:/risk/calibration/review"
  | "E_POLICY_SECURITY:POST:/risk/calibration/run"
  | "E_POLICY_SECURITY:POST:/risk/drift-trend"
  | "E_POLICY_SECURITY:POST:/risk/product-gate"
  | "E_POLICY_SECURITY:POST:/risk/release-dossier"
  | "E_POLICY_SECURITY:POST:/security/prompt-injection/product-gate"
  | "E_POLICY_SECURITY:POST:/security/prompt-injection/release-dossier"
  | "E_POLICY_SECURITY:POST:/security/prompt-injection/run"
  | "E_POLICY_SECURITY:POST:/security/prompt-injection/semantic-trend"
  | "E_POLICY_SECURITY:POST:/security/redteam/run"
  | "E_POLICY_SECURITY:POST:/security/scan"
  | "E_POLICY_SECURITY:POST:/tool-output/artifact-diff"
  | "E_POLICY_SECURITY:POST:/tool-output/evaluate"
  | "E_POLICY_SECURITY:POST:/tool-output/product-gate"
  | "E_POLICY_SECURITY:POST:/tool-output/release-dossier"
  | "F_GROWTH_MEMORY:GET:/advanced-learning"
  | "F_GROWTH_MEMORY:GET:/advanced-learning/skill-registry"
  | "F_GROWTH_MEMORY:GET:/advanced-learning/verifier"
  | "F_GROWTH_MEMORY:GET:/autonomy/candidates"
  | "F_GROWTH_MEMORY:GET:/autonomy/candidates/trends"
  | "F_GROWTH_MEMORY:GET:/failures"
  | "F_GROWTH_MEMORY:GET:/failures/effectiveness-tuning"
  | "F_GROWTH_MEMORY:GET:/failures/guardrail-review-queue"
  | "F_GROWTH_MEMORY:GET:/failures/recurrence-dashboard"
  | "F_GROWTH_MEMORY:GET:/failures/recurrence-visualization"
  | "F_GROWTH_MEMORY:GET:/failures/taxonomy-fixtures"
  | "F_GROWTH_MEMORY:GET:/failures/trends"
  | "F_GROWTH_MEMORY:GET:/genomes/drift-diff"
  | "F_GROWTH_MEMORY:GET:/genomes/threshold-alerts"
  | "F_GROWTH_MEMORY:GET:/genomes/trends"
  | "F_GROWTH_MEMORY:GET:/genomes/weight-calibration"
  | "F_GROWTH_MEMORY:GET:/growth/review/latest"
  | "F_GROWTH_MEMORY:GET:/health"
  | "F_GROWTH_MEMORY:GET:/maturity-score"
  | "F_GROWTH_MEMORY:GET:/maturity-score/alerts"
  | "F_GROWTH_MEMORY:GET:/maturity-score/dashboard"
  | "F_GROWTH_MEMORY:GET:/maturity-score/threshold-profile"
  | "F_GROWTH_MEMORY:GET:/maturity-score/thresholds"
  | "F_GROWTH_MEMORY:GET:/maturity-score/trends"
  | "F_GROWTH_MEMORY:GET:/memory/events/fixtures"
  | "F_GROWTH_MEMORY:GET:/memory/events/generated-fixture-drift"
  | "F_GROWTH_MEMORY:GET:/memory/events/ingest-telemetry"
  | "F_GROWTH_MEMORY:GET:/memory/events/learning-verifier-matrix"
  | "F_GROWTH_MEMORY:GET:/memory/events/operational-corpus"
  | "F_GROWTH_MEMORY:GET:/memory/events/schema"
  | "F_GROWTH_MEMORY:GET:/memory/events/schema-bundle"
  | "F_GROWTH_MEMORY:GET:/memory/hygiene/decisions/history"
  | "F_GROWTH_MEMORY:GET:/memory/hygiene/report"
  | "F_GROWTH_MEMORY:GET:/memory/hygiene/trends"
  | "F_GROWTH_MEMORY:GET:/memory/minimize/false-positive-dashboard"
  | "F_GROWTH_MEMORY:GET:/memory/minimize/fixtures"
  | "F_GROWTH_MEMORY:GET:/memory/retention/calendar"
  | "F_GROWTH_MEMORY:GET:/memory/retention/policy-ui"
  | "F_GROWTH_MEMORY:GET:/memory/retention/report"
  | "F_GROWTH_MEMORY:GET:/memory/retention/schedule"
  | "F_GROWTH_MEMORY:GET:/openapi.json"
  | "F_GROWTH_MEMORY:GET:/patterns"
  | "F_GROWTH_MEMORY:GET:/patterns/cluster-review"
  | "F_GROWTH_MEMORY:GET:/patterns/corpus"
  | "F_GROWTH_MEMORY:GET:/patterns/embedding-adapters"
  | "F_GROWTH_MEMORY:GET:/patterns/trends"
  | "F_GROWTH_MEMORY:GET:/planning-context"
  | "F_GROWTH_MEMORY:GET:/planning-guardrails"
  | "F_GROWTH_MEMORY:GET:/preferences"
  | "F_GROWTH_MEMORY:GET:/preferences/confidence-calibration"
  | "F_GROWTH_MEMORY:GET:/preferences/confirmed"
  | "F_GROWTH_MEMORY:GET:/preferences/confirmed/drift-trend"
  | "F_GROWTH_MEMORY:GET:/preferences/conflicts"
  | "F_GROWTH_MEMORY:GET:/preferences/tolerance-profile"
  | "F_GROWTH_MEMORY:GET:/storage/at-rest-encryption-policy"
  | "F_GROWTH_MEMORY:GET:/storage/backup-location-policy"
  | "F_GROWTH_MEMORY:GET:/storage/backups/retention"
  | "F_GROWTH_MEMORY:GET:/storage/encryption-key"
  | "F_GROWTH_MEMORY:GET:/storage/status"
  | "F_GROWTH_MEMORY:GET:/trends/archive"
  | "F_GROWTH_MEMORY:PATCH:/preferences/confirmed/{preferenceId}"
  | "F_GROWTH_MEMORY:POST:/advanced-learning/product-gate"
  | "F_GROWTH_MEMORY:POST:/advanced-learning/release-dossier"
  | "F_GROWTH_MEMORY:POST:/advanced-learning/skill-drafts/{draftId}/review"
  | "F_GROWTH_MEMORY:POST:/advanced-learning/skill-registry/{skillId}/usefulness"
  | "F_GROWTH_MEMORY:POST:/autonomy/candidates/{candidateId}/review"
  | "F_GROWTH_MEMORY:POST:/autonomy/candidates/{candidateId}/submit-to-policy"
  | "F_GROWTH_MEMORY:POST:/autonomy/candidates/expiry/run"
  | "F_GROWTH_MEMORY:POST:/autonomy/candidates/generate"
  | "F_GROWTH_MEMORY:POST:/autonomy/candidates/release-dossier"
  | "F_GROWTH_MEMORY:POST:/events"
  | "F_GROWTH_MEMORY:POST:/failures/{failureId}/guardrail"
  | "F_GROWTH_MEMORY:POST:/failures/product-gate"
  | "F_GROWTH_MEMORY:POST:/failures/release-dossier"
  | "F_GROWTH_MEMORY:POST:/feedback"
  | "F_GROWTH_MEMORY:POST:/genomes/product-gate"
  | "F_GROWTH_MEMORY:POST:/genomes/release-dossier"
  | "F_GROWTH_MEMORY:POST:/maturity-score/product-gate"
  | "F_GROWTH_MEMORY:POST:/maturity-score/release-dossier"
  | "F_GROWTH_MEMORY:POST:/maturity-score/threshold-migration-diff"
  | "F_GROWTH_MEMORY:POST:/maturity-score/thresholds/calibration"
  | "F_GROWTH_MEMORY:POST:/memory/events/migration-compatibility"
  | "F_GROWTH_MEMORY:POST:/memory/events/product-gate"
  | "F_GROWTH_MEMORY:POST:/memory/events/release-dossier"
  | "F_GROWTH_MEMORY:POST:/memory/events/schema-diff"
  | "F_GROWTH_MEMORY:POST:/memory/events/schema-diff-review"
  | "F_GROWTH_MEMORY:POST:/memory/hygiene/decisions"
  | "F_GROWTH_MEMORY:POST:/memory/hygiene/decisions/batch"
  | "F_GROWTH_MEMORY:POST:/memory/hygiene/product-gate"
  | "F_GROWTH_MEMORY:POST:/memory/hygiene/release-dossier"
  | "F_GROWTH_MEMORY:POST:/memory/minimize/preview"
  | "F_GROWTH_MEMORY:POST:/memory/minimize/release-dossier"
  | "F_GROWTH_MEMORY:POST:/memory/query"
  | "F_GROWTH_MEMORY:POST:/memory/retention/apply"
  | "F_GROWTH_MEMORY:POST:/memory/retention/run"
  | "F_GROWTH_MEMORY:POST:/patterns/calibration"
  | "F_GROWTH_MEMORY:POST:/patterns/product-gate"
  | "F_GROWTH_MEMORY:POST:/preferences/{hypothesisId}/decision"
  | "F_GROWTH_MEMORY:POST:/preferences/batch-decision"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/{preferenceId}"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/{preferenceId}/revoke"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/application-preview"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/conflict-dossier"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/migration-review-queue"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/product-gate"
  | "F_GROWTH_MEMORY:POST:/preferences/confirmed/release-dossier"
  | "F_GROWTH_MEMORY:POST:/preferences/migration-diff"
  | "F_GROWTH_MEMORY:POST:/preferences/product-gate"
  | "F_GROWTH_MEMORY:POST:/preferences/release-dossier"
  | "F_GROWTH_MEMORY:POST:/storage/backup"
  | "F_GROWTH_MEMORY:POST:/storage/backups/rotate"
  | "F_GROWTH_MEMORY:POST:/storage/encrypted-backup"
  | "F_GROWTH_MEMORY:POST:/storage/large-migration-fixture"
  | "F_GROWTH_MEMORY:POST:/storage/periodic-restore-drill"
  | "F_GROWTH_MEMORY:POST:/storage/product-gate"
  | "F_GROWTH_MEMORY:POST:/storage/release-dossier"
  | "F_GROWTH_MEMORY:POST:/storage/restore"
  | "F_GROWTH_MEMORY:POST:/storage/restore-drill"
  | "F_GROWTH_MEMORY:POST:/storage/worm-sync"
  | "G_VERIFICATION:GET:/baseline/approval-dashboard"
  | "G_VERIFICATION:GET:/baseline/ci-trend"
  | "G_VERIFICATION:GET:/baseline/trend"
  | "G_VERIFICATION:GET:/bridge-security/corpus"
  | "G_VERIFICATION:GET:/documents/invariants"
  | "G_VERIFICATION:GET:/documents/invariants/dedupe"
  | "G_VERIFICATION:GET:/documents/invariants/trend"
  | "G_VERIFICATION:GET:/fixtures/matrix"
  | "G_VERIFICATION:GET:/golden-traces"
  | "G_VERIFICATION:GET:/golden-traces/retention"
  | "G_VERIFICATION:GET:/health"
  | "G_VERIFICATION:GET:/openapi.json"
  | "G_VERIFICATION:GET:/redteam/corpus"
  | "G_VERIFICATION:GET:/redteam/quarantine"
  | "G_VERIFICATION:GET:/redteam/retention"
  | "G_VERIFICATION:GET:/redteam/trend"
  | "G_VERIFICATION:GET:/regression/dashboard"
  | "G_VERIFICATION:GET:/regression/external-fixtures"
  | "G_VERIFICATION:GET:/reports"
  | "G_VERIFICATION:GET:/reports/{reportId}"
  | "G_VERIFICATION:GET:/reports/retention"
  | "G_VERIFICATION:GET:/reports/retention-policy-ui"
  | "G_VERIFICATION:GET:/reports/trend"
  | "G_VERIFICATION:GET:/reports/trend/visualization"
  | "G_VERIFICATION:GET:/score/dashboard"
  | "G_VERIFICATION:GET:/score/document-rubric"
  | "G_VERIFICATION:GET:/score/rubric"
  | "G_VERIFICATION:GET:/simulation/expanded-scenarios"
  | "G_VERIFICATION:GET:/simulation/scenarios"
  | "G_VERIFICATION:GET:/simulation/trend"
  | "G_VERIFICATION:GET:/simulation/trend/retention"
  | "G_VERIFICATION:GET:/verify/approval-flow/device-smoke"
  | "G_VERIFICATION:GET:/verify/approval-flow/retention"
  | "G_VERIFICATION:GET:/verify/approval-flow/trend"
  | "G_VERIFICATION:GET:/verify/approval-flow/ux-latency-trend"
  | "G_VERIFICATION:GET:/verify/execution/external-fixtures"
  | "G_VERIFICATION:GET:/verify/execution/quarantine"
  | "G_VERIFICATION:GET:/verify/execution/retention"
  | "G_VERIFICATION:GET:/verify/execution/trend"
  | "G_VERIFICATION:GET:/verify/learning/fixtures"
  | "G_VERIFICATION:GET:/verify/plan/fixtures"
  | "G_VERIFICATION:GET:/verify/plan/fixtures/trend"
  | "G_VERIFICATION:GET:/verify/plan/regression-visualization"
  | "G_VERIFICATION:POST:/baseline/approved-update"
  | "G_VERIFICATION:POST:/baseline/compare"
  | "G_VERIFICATION:POST:/bridge-security/product-drill"
  | "G_VERIFICATION:POST:/bridge-security/release-dossier"
  | "G_VERIFICATION:POST:/documents/invariants/run"
  | "G_VERIFICATION:POST:/fixtures/run"
  | "G_VERIFICATION:POST:/golden-traces"
  | "G_VERIFICATION:POST:/golden-traces/release-dossier"
  | "G_VERIFICATION:POST:/golden-traces/rotate"
  | "G_VERIFICATION:POST:/redteam/product-gate"
  | "G_VERIFICATION:POST:/redteam/run"
  | "G_VERIFICATION:POST:/regression/artifacts/sync"
  | "G_VERIFICATION:POST:/regression/product-gate"
  | "G_VERIFICATION:POST:/regression/release-dossier"
  | "G_VERIFICATION:POST:/regression/run"
  | "G_VERIFICATION:POST:/release/gate"
  | "G_VERIFICATION:POST:/release/schedule/run"
  | "G_VERIFICATION:POST:/reports/artifacts/sync"
  | "G_VERIFICATION:POST:/reports/cleanup"
  | "G_VERIFICATION:POST:/reports/cleanup/approval"
  | "G_VERIFICATION:POST:/reports/diff"
  | "G_VERIFICATION:POST:/reports/product-gate"
  | "G_VERIFICATION:POST:/reports/release-dossier"
  | "G_VERIFICATION:POST:/score"
  | "G_VERIFICATION:POST:/score/ci-annotation"
  | "G_VERIFICATION:POST:/score/gate"
  | "G_VERIFICATION:POST:/score/product-gate"
  | "G_VERIFICATION:POST:/simulate"
  | "G_VERIFICATION:POST:/simulation/chaos-schedule/run"
  | "G_VERIFICATION:POST:/simulation/release-dossier"
  | "G_VERIFICATION:POST:/tool-poisoning-leak/release-dossier"
  | "G_VERIFICATION:POST:/tool-poisoning-leak/run"
  | "G_VERIFICATION:POST:/verify/approval-flow"
  | "G_VERIFICATION:POST:/verify/approval-flow/corpus"
  | "G_VERIFICATION:POST:/verify/approval-flow/product-gate"
  | "G_VERIFICATION:POST:/verify/approval-flow/release-dossier"
  | "G_VERIFICATION:POST:/verify/bridge"
  | "G_VERIFICATION:POST:/verify/execution"
  | "G_VERIFICATION:POST:/verify/execution/corpus"
  | "G_VERIFICATION:POST:/verify/execution/product-gate"
  | "G_VERIFICATION:POST:/verify/execution/release-dossier"
  | "G_VERIFICATION:POST:/verify/execution/soak"
  | "G_VERIFICATION:POST:/verify/learning"
  | "G_VERIFICATION:POST:/verify/learning/artifacts/sync"
  | "G_VERIFICATION:POST:/verify/learning/ci-annotation"
  | "G_VERIFICATION:POST:/verify/learning/fixtures/run"
  | "G_VERIFICATION:POST:/verify/learning/product-gate"
  | "G_VERIFICATION:POST:/verify/plan"
  | "G_VERIFICATION:POST:/verify/plan/artifacts/sync"
  | "G_VERIFICATION:POST:/verify/plan/ci-annotation"
  | "G_VERIFICATION:POST:/verify/plan/document-diff-fixtures/run"
  | "G_VERIFICATION:POST:/verify/plan/fixtures/run"
  | "G_VERIFICATION:POST:/verify/plan/product-gate"
  | "G_VERIFICATION:POST:/verify/policy"
  | "G_VERIFICATION:POST:/verify/policy/ci-annotation"
  | "G_VERIFICATION:POST:/verify/policy/migration-approval-artifact"
  | "G_VERIFICATION:POST:/verify/policy/product-gate";
export interface FederatedOpenApiOperationMap {
  "A_CORE:GET:/admin/diagnostics": { moduleId: "A_CORE"; method: "GET"; path: "/admin/diagnostics"; operationId: "getCoreAdminDiagnostics"; responseCodes: ["200","401"]; };
  "A_CORE:GET:/health": { moduleId: "A_CORE"; method: "GET"; path: "/health"; operationId: "getCoreHealth"; responseCodes: ["200"]; };
  "A_CORE:GET:/openapi.json": { moduleId: "A_CORE"; method: "GET"; path: "/openapi.json"; operationId: "getCoreOpenApiSpec"; responseCodes: ["200"]; };
  "A_CORE:GET:/runtime/supervisor": { moduleId: "A_CORE"; method: "GET"; path: "/runtime/supervisor"; operationId: "getCoreRuntimeSupervisor"; responseCodes: ["200"]; };
  "A_CORE:GET:/tasks": { moduleId: "A_CORE"; method: "GET"; path: "/tasks"; operationId: "listCoreTasks"; responseCodes: ["200"]; };
  "A_CORE:GET:/tasks/{taskId}": { moduleId: "A_CORE"; method: "GET"; path: "/tasks/{taskId}"; operationId: "getCoreTask"; responseCodes: ["200","404"]; };
  "A_CORE:GET:/tasks/{taskId}/plan-artifacts": { moduleId: "A_CORE"; method: "GET"; path: "/tasks/{taskId}/plan-artifacts"; operationId: "exportCorePlanNodeArtifacts"; responseCodes: ["200","503"]; };
  "A_CORE:GET:/tasks/{taskId}/resume": { moduleId: "A_CORE"; method: "GET"; path: "/tasks/{taskId}/resume"; operationId: "resumeCoreTask"; responseCodes: ["200"]; };
  "A_CORE:GET:/worker/daemon": { moduleId: "A_CORE"; method: "GET"; path: "/worker/daemon"; operationId: "getCoreWorkerDaemon"; responseCodes: ["200","503"]; };
  "A_CORE:GET:/worker/leases": { moduleId: "A_CORE"; method: "GET"; path: "/worker/leases"; operationId: "getCoreWorkerLeases"; responseCodes: ["200","503"]; };
  "A_CORE:GET:/worker/plan-artifacts": { moduleId: "A_CORE"; method: "GET"; path: "/worker/plan-artifacts"; operationId: "getCorePlanNodeArtifactRetentionStatus"; responseCodes: ["200","503"]; };
  "A_CORE:GET:/worker/queue": { moduleId: "A_CORE"; method: "GET"; path: "/worker/queue"; operationId: "getCoreWorkerQueue"; responseCodes: ["200","503"]; };
  "A_CORE:GET:/worker/timeouts": { moduleId: "A_CORE"; method: "GET"; path: "/worker/timeouts"; operationId: "getCoreWorkerTimeoutScheduler"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/runtime/service-plan": { moduleId: "A_CORE"; method: "POST"; path: "/runtime/service-plan"; operationId: "createCoreServiceLifecyclePlan"; responseCodes: ["200","401","403"]; };
  "A_CORE:POST:/runtime/supervisor/tick": { moduleId: "A_CORE"; method: "POST"; path: "/runtime/supervisor/tick"; operationId: "tickCoreRuntimeSupervisor"; responseCodes: ["200"]; };
  "A_CORE:POST:/tasks": { moduleId: "A_CORE"; method: "POST"; path: "/tasks"; operationId: "createCoreTask"; responseCodes: ["201","400"]; };
  "A_CORE:POST:/tasks/{taskId}/approve": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/approve"; operationId: "decideCoreApproval"; responseCodes: ["200","404"]; };
  "A_CORE:POST:/tasks/{taskId}/compensation": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/compensation"; operationId: "beginCoreCompensation"; responseCodes: ["200"]; };
  "A_CORE:POST:/tasks/{taskId}/compensation/run": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/compensation/run"; operationId: "runCoreCompensationReplay"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/tasks/{taskId}/plan-graph/product-gate": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/plan-graph/product-gate"; operationId: "runCorePlanGraphProductGate"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/tasks/{taskId}/queue": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/queue"; operationId: "enqueueCoreWorkerTask"; responseCodes: ["202","404","503"]; };
  "A_CORE:POST:/tasks/{taskId}/run": { moduleId: "A_CORE"; method: "POST"; path: "/tasks/{taskId}/run"; operationId: "runTaskThroughCoreWorker"; responseCodes: ["200","409","503"]; };
  "A_CORE:POST:/worker/daemon/start": { moduleId: "A_CORE"; method: "POST"; path: "/worker/daemon/start"; operationId: "startCoreWorkerDaemon"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/worker/daemon/stop": { moduleId: "A_CORE"; method: "POST"; path: "/worker/daemon/stop"; operationId: "stopCoreWorkerDaemon"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/worker/daemon/tick": { moduleId: "A_CORE"; method: "POST"; path: "/worker/daemon/tick"; operationId: "tickCoreWorkerDaemon"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/worker/leases/recover": { moduleId: "A_CORE"; method: "POST"; path: "/worker/leases/recover"; operationId: "recoverCoreWorkerLeases"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/worker/queue/drain": { moduleId: "A_CORE"; method: "POST"; path: "/worker/queue/drain"; operationId: "drainCoreWorkerQueue"; responseCodes: ["200","503"]; };
  "A_CORE:POST:/worker/state-product-gate": { moduleId: "A_CORE"; method: "POST"; path: "/worker/state-product-gate"; operationId: "runCoreWorkerStateProductGate"; responseCodes: ["200","503"]; };
  "B_PC_AGENT:GET:/api/contract-snapshot": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/api/contract-snapshot"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/api/security/status": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/api/security/status"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/capability-vault/export": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/capability-vault/export"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/capability-vault/status": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/capability-vault/status"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/evidence/privacy-fixtures": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/evidence/privacy-fixtures"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/evidence/query": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/evidence/query"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/evidence/retention": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/evidence/retention"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/evidence/schema-snapshot": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/evidence/schema-snapshot"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/execution-packets/journal": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/execution-packets/journal"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/execution-packets/queue": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/execution-packets/queue"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/execution-packets/queue/poison": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/execution-packets/queue/poison"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/execution-packets/queue/policy": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/execution-packets/queue/policy"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/health": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/health"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/logs/recent": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/logs/recent"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/memory-events/query": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/memory-events/query"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/memory-events/recent": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/memory-events/recent"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/openapi.json": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/openapi.json"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/rollback/{taskId}/plan": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/rollback/{taskId}/plan"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/rollback/journal": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/rollback/journal"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/rollback/transactions": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/rollback/transactions"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/service/runtime": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/service/runtime"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/service/status": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/service/status"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/service/verification": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/service/verification"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/tasks/{taskId}": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/tasks/{taskId}"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/tasks/{taskId}/evidence": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/tasks/{taskId}/evidence"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/tasks/{taskId}/result": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/tasks/{taskId}/result"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:GET:/tray/state": { moduleId: "B_PC_AGENT"; method: "GET"; path: "/tray/state"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/api/product-gate": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/api/product-gate"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/capability-vault/import-recovery": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/capability-vault/import-recovery"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/capability-vault/key-rotation-drill": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/capability-vault/key-rotation-drill"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/capability-vault/product-gate": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/capability-vault/product-gate"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/evidence/product-gate": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/evidence/product-gate"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/evidence/rotate": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/evidence/rotate"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/evidence/schema-regression": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/evidence/schema-regression"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/execution-packets": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets"; operationId: null; responseCodes: ["200","400","401","429"]; };
  "B_PC_AGENT:POST:/execution-packets/queue": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue"; operationId: null; responseCodes: ["202"]; };
  "B_PC_AGENT:POST:/execution-packets/queue/drain": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue/drain"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/ignore": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue/poison/{queueId}/ignore"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/requeue": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue/poison/{queueId}/requeue"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/execution-packets/queue/poison/{queueId}/review": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue/poison/{queueId}/review"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/execution-packets/queue/policy": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/execution-packets/queue/policy"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/rollback/{taskId}": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/rollback/{taskId}"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/rollback/{taskId}/export": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/rollback/{taskId}/export"; operationId: null; responseCodes: ["200"]; };
  "B_PC_AGENT:POST:/rollback/product-gate": { moduleId: "B_PC_AGENT"; method: "POST"; path: "/rollback/product-gate"; operationId: null; responseCodes: ["200"]; };
  "D_BRIDGE:DELETE:/devices/{deviceId}": { moduleId: "D_BRIDGE"; method: "DELETE"; path: "/devices/{deviceId}"; operationId: "device_revoke"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/approvals": { moduleId: "D_BRIDGE"; method: "GET"; path: "/approvals"; operationId: "approvals_list"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/approvals/{approvalId}": { moduleId: "D_BRIDGE"; method: "GET"; path: "/approvals/{approvalId}"; operationId: "approval_read"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/approvals/{approvalId}/history": { moduleId: "D_BRIDGE"; method: "GET"; path: "/approvals/{approvalId}/history"; operationId: "approval_history"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/audit/export": { moduleId: "D_BRIDGE"; method: "GET"; path: "/audit/export"; operationId: "audit_export"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/audit/siem-export": { moduleId: "D_BRIDGE"; method: "GET"; path: "/audit/siem-export"; operationId: "audit_siem_export"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/audit/summary": { moduleId: "D_BRIDGE"; method: "GET"; path: "/audit/summary"; operationId: "audit_summary"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/cache/schema-snapshot": { moduleId: "D_BRIDGE"; method: "GET"; path: "/cache/schema-snapshot"; operationId: "cache_schema_snapshot"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/cache/snapshot": { moduleId: "D_BRIDGE"; method: "GET"; path: "/cache/snapshot"; operationId: "cache_snapshot"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/devices": { moduleId: "D_BRIDGE"; method: "GET"; path: "/devices"; operationId: "devices_list"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/devices/inventory": { moduleId: "D_BRIDGE"; method: "GET"; path: "/devices/inventory"; operationId: "devices_inventory"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/devices/token/policy": { moduleId: "D_BRIDGE"; method: "GET"; path: "/devices/token/policy"; operationId: "device_token_policy"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events"; operationId: "events_feed"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events/fallback-ux": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events/fallback-ux"; operationId: "events_fallback_ux"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events/reconnect-plan": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events/reconnect-plan"; operationId: "events_reconnect_plan"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events/stream": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events/stream"; operationId: "events_stream"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events/stream/status": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events/stream/status"; operationId: "events_stream_status"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/events/ws": { moduleId: "D_BRIDGE"; method: "GET"; path: "/events/ws"; operationId: "events_websocket"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/growth/decisions/history": { moduleId: "D_BRIDGE"; method: "GET"; path: "/growth/decisions/history"; operationId: "growth_routing_history"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/growth/decisions/trends": { moduleId: "D_BRIDGE"; method: "GET"; path: "/growth/decisions/trends"; operationId: "growth_routing_trend"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/growth/review/latest": { moduleId: "D_BRIDGE"; method: "GET"; path: "/growth/review/latest"; operationId: "growth_review_latest"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/health": { moduleId: "D_BRIDGE"; method: "GET"; path: "/health"; operationId: "health"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/openapi.json": { moduleId: "D_BRIDGE"; method: "GET"; path: "/openapi.json"; operationId: "openapi"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/pc-agent/poison-packets": { moduleId: "D_BRIDGE"; method: "GET"; path: "/pc-agent/poison-packets"; operationId: "pc_agent_poison_queue_read"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/pc-agent/queue-policy": { moduleId: "D_BRIDGE"; method: "GET"; path: "/pc-agent/queue-policy"; operationId: "pc_agent_queue_policy_read"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/pc-console/approval-handoffs": { moduleId: "D_BRIDGE"; method: "GET"; path: "/pc-console/approval-handoffs"; operationId: "pc_console_handoff_read"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/rate-limit/abuse-corpus": { moduleId: "D_BRIDGE"; method: "GET"; path: "/rate-limit/abuse-corpus"; operationId: "rate_limit_abuse_corpus"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/rate-limit/status": { moduleId: "D_BRIDGE"; method: "GET"; path: "/rate-limit/status"; operationId: "rate_limit_status"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/request-nonces/clock-skew-fixtures": { moduleId: "D_BRIDGE"; method: "GET"; path: "/request-nonces/clock-skew-fixtures"; operationId: "request_nonce_clock_skew_fixtures"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/request-nonces/policy": { moduleId: "D_BRIDGE"; method: "GET"; path: "/request-nonces/policy"; operationId: "request_nonce_policy"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/results/{taskId}": { moduleId: "D_BRIDGE"; method: "GET"; path: "/results/{taskId}"; operationId: "result_read"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/server/deployment-profile": { moduleId: "D_BRIDGE"; method: "GET"; path: "/server/deployment-profile"; operationId: "server_deployment_profile"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/server/profile": { moduleId: "D_BRIDGE"; method: "GET"; path: "/server/profile"; operationId: "server_profile"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/server/reverse-proxy-lab": { moduleId: "D_BRIDGE"; method: "GET"; path: "/server/reverse-proxy-lab"; operationId: "server_reverse_proxy_lab"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/tasks": { moduleId: "D_BRIDGE"; method: "GET"; path: "/tasks"; operationId: "tasks_list"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:GET:/tasks/{taskId}": { moduleId: "D_BRIDGE"; method: "GET"; path: "/tasks/{taskId}"; operationId: "task_status"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/approvals/{approvalId}/cancel": { moduleId: "D_BRIDGE"; method: "POST"; path: "/approvals/{approvalId}/cancel"; operationId: "approval_cancel"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/approvals/{approvalId}/decision": { moduleId: "D_BRIDGE"; method: "POST"; path: "/approvals/{approvalId}/decision"; operationId: "approval_decision"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/approvals/{approvalId}/pc-handoff": { moduleId: "D_BRIDGE"; method: "POST"; path: "/approvals/{approvalId}/pc-handoff"; operationId: "approval_pc_handoff"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/approvals/{approvalId}/re-request": { moduleId: "D_BRIDGE"; method: "POST"; path: "/approvals/{approvalId}/re-request"; operationId: "approval_re_request"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/approvals/{approvalId}/renew": { moduleId: "D_BRIDGE"; method: "POST"; path: "/approvals/{approvalId}/renew"; operationId: "approval_renew"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/archive/restore-drill": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/archive/restore-drill"; operationId: "audit_archive_restore_drill"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/archive/sync": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/archive/sync"; operationId: "audit_archive_sync"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/product-gate"; operationId: "audit_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/release-dossier"; operationId: "audit_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/retention/run": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/retention/run"; operationId: "audit_retention_run"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/audit/rotate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/audit/rotate"; operationId: "audit_rotate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/cache/compact": { moduleId: "D_BRIDGE"; method: "POST"; path: "/cache/compact"; operationId: "cache_compact"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/cache/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/cache/product-gate"; operationId: "cache_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/cache/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/cache/release-dossier"; operationId: "cache_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/cache/schema-diff": { moduleId: "D_BRIDGE"; method: "POST"; path: "/cache/schema-diff"; operationId: "cache_schema_diff"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/connection/heartbeat": { moduleId: "D_BRIDGE"; method: "POST"; path: "/connection/heartbeat"; operationId: "device_heartbeat"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/devices/token/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/devices/token/release-dossier"; operationId: "device_token_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/devices/token/rotate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/devices/token/rotate"; operationId: "device_token_rotate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/devices/token/rotation-drill": { moduleId: "D_BRIDGE"; method: "POST"; path: "/devices/token/rotation-drill"; operationId: "device_token_rotation_drill"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/events/ack": { moduleId: "D_BRIDGE"; method: "POST"; path: "/events/ack"; operationId: "events_ack"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/events/chaos-drill": { moduleId: "D_BRIDGE"; method: "POST"; path: "/events/chaos-drill"; operationId: "events_chaos_drill"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/events/cursors/compact": { moduleId: "D_BRIDGE"; method: "POST"; path: "/events/cursors/compact"; operationId: "events_cursor_compact"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/events/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/events/product-gate"; operationId: "events_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/events/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/events/release-dossier"; operationId: "events_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/execution-handoffs/{handoffId}/confirm": { moduleId: "D_BRIDGE"; method: "POST"; path: "/execution-handoffs/{handoffId}/confirm"; operationId: "execution_confirm"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/feedback": { moduleId: "D_BRIDGE"; method: "POST"; path: "/feedback"; operationId: "feedback"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/growth/hygiene/decisions": { moduleId: "D_BRIDGE"; method: "POST"; path: "/growth/hygiene/decisions"; operationId: "growth_hygiene_decision"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/growth/hygiene/decisions/batch": { moduleId: "D_BRIDGE"; method: "POST"; path: "/growth/hygiene/decisions/batch"; operationId: "growth_hygiene_batch_decision"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/growth/preferences/{hypothesisId}/decision": { moduleId: "D_BRIDGE"; method: "POST"; path: "/growth/preferences/{hypothesisId}/decision"; operationId: "growth_preference_decision"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/growth/routing/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/growth/routing/release-dossier"; operationId: "growth_routing_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pairing/confirm": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pairing/confirm"; operationId: "pairing_confirm"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pairing/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pairing/release-dossier"; operationId: "pairing_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pairing/start": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pairing/start"; operationId: "pairing_start"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/ignore": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-agent/poison-packets/{queueId}/ignore"; operationId: "pc_agent_poison_packet_ignore"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/requeue": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-agent/poison-packets/{queueId}/requeue"; operationId: "pc_agent_poison_packet_requeue"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-agent/poison-packets/{queueId}/review": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-agent/poison-packets/{queueId}/review"; operationId: "pc_agent_poison_packet_review"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-agent/queue-policy": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-agent/queue-policy"; operationId: "pc_agent_queue_policy_update"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-agent/queue/drain": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-agent/queue/drain"; operationId: "pc_agent_queue_drain"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/pc-console/approval-handoffs/{handoffId}/decision": { moduleId: "D_BRIDGE"; method: "POST"; path: "/pc-console/approval-handoffs/{handoffId}/decision"; operationId: "pc_console_handoff_decision"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/rate-limit/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/rate-limit/product-gate"; operationId: "rate_limit_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/rate-limit/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/rate-limit/release-dossier"; operationId: "rate_limit_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/request-nonces/compact": { moduleId: "D_BRIDGE"; method: "POST"; path: "/request-nonces/compact"; operationId: "request_nonce_compact"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/request-nonces/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/request-nonces/product-gate"; operationId: "request_nonce_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/request-nonces/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/request-nonces/release-dossier"; operationId: "request_nonce_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/results/{taskId}/rollback": { moduleId: "D_BRIDGE"; method: "POST"; path: "/results/{taskId}/rollback"; operationId: "result_rollback"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/server/product-gate": { moduleId: "D_BRIDGE"; method: "POST"; path: "/server/product-gate"; operationId: "server_product_gate"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/task-approval-result/release-dossier": { moduleId: "D_BRIDGE"; method: "POST"; path: "/task-approval-result/release-dossier"; operationId: "task_approval_result_release_dossier"; responseCodes: ["200","400","401","429"]; };
  "D_BRIDGE:POST:/tasks": { moduleId: "D_BRIDGE"; method: "POST"; path: "/tasks"; operationId: "task_create"; responseCodes: ["200","400","401","429"]; };
  "E_POLICY_SECURITY:GET:/approval/policy/history": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/approval/policy/history"; operationId: "getApprovalPolicyHistory"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/approval/policy/workflow": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/approval/policy/workflow"; operationId: "getApprovalPolicyWorkflow"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/audit/export": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/audit/export"; operationId: "getAuditExport"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/audit/siem-export": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/audit/siem-export"; operationId: "getAuditSiemExport"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/audit/summary": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/audit/summary"; operationId: "getAuditSummary"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/autonomy/evaluations": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/autonomy/evaluations"; operationId: "getAutonomyEvaluations"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/autonomy/trend": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/autonomy/trend"; operationId: "getAutonomyTrend"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/capability/journal": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/capability/journal"; operationId: "getCapabilityJournal"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/capability/journal/export": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/capability/journal/export"; operationId: "getCapabilityJournalExport"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/capability/signing-key": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/capability/signing-key"; operationId: "getCapabilitySigningKey"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/data/external-ner-contract": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/data/external-ner-contract"; operationId: "getDataExternalNerContract"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/data/minimizer-adapter": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/data/minimizer-adapter"; operationId: "getDataMinimizerAdapter"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/health": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/health"; operationId: "getHealth"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/openapi.json": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/openapi.json"; operationId: "getOpenapiJson"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/as-code": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/as-code"; operationId: "getPolicyAsCode"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/as-code/schema": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/as-code/schema"; operationId: "getPolicyAsCodeSchema"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/bundle": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/bundle"; operationId: "getPolicyBundle"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/constitution": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/constitution"; operationId: "getPolicyConstitution"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/constitution/hash-regression": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/constitution/hash-regression"; operationId: "getPolicyConstitutionHashRegression"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/policy/constitution/workflow": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/policy/constitution/workflow"; operationId: "getPolicyConstitutionWorkflow"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/risk/calibration/corpus": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/risk/calibration/corpus"; operationId: "getRiskCalibrationCorpus"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/risk/operational-corpus": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/risk/operational-corpus"; operationId: "getRiskOperationalCorpus"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/security/prompt-injection/corpus": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/security/prompt-injection/corpus"; operationId: "getSecurityPromptInjectionCorpus"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/security/prompt-injection/production-miss-corpus": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/security/prompt-injection/production-miss-corpus"; operationId: "getSecurityPromptInjectionProductionMissCorpus"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/security/prompt-injection/semantic-adapter": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/security/prompt-injection/semantic-adapter"; operationId: "getSecurityPromptInjectionSemanticAdapter"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/security/redteam/corpus": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/security/redteam/corpus"; operationId: "getSecurityRedteamCorpus"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/security/redteam/trend": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/security/redteam/trend"; operationId: "getSecurityRedteamTrend"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/tool-output/provenance": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/tool-output/provenance"; operationId: "getToolOutputProvenance"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:GET:/tool-output/provenance/retention": { moduleId: "E_POLICY_SECURITY"; method: "GET"; path: "/tool-output/provenance/retention"; operationId: "getToolOutputProvenanceRetention"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/policy/change": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/policy/change"; operationId: "postApprovalPolicyChange"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/policy/ci-approval-artifact": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/policy/ci-approval-artifact"; operationId: "postApprovalPolicyCiApprovalArtifact"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/policy/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/policy/product-gate"; operationId: "postApprovalPolicyProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/policy/review": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/policy/review"; operationId: "postApprovalPolicyReview"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/policy/rollback-drill": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/policy/rollback-drill"; operationId: "postApprovalPolicyRollbackDrill"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/approval/validate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/approval/validate"; operationId: "postApprovalValidate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/archive/sync": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/archive/sync"; operationId: "postAuditArchiveSync"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/product-gate"; operationId: "postAuditProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/release-dossier"; operationId: "postAuditReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/retention/run": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/retention/run"; operationId: "postAuditRetentionRun"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/rotate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/rotate"; operationId: "postAuditRotate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/audit/search": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/audit/search"; operationId: "postAuditSearch"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/autonomy/evaluate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/autonomy/evaluate"; operationId: "postAutonomyEvaluate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/autonomy/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/autonomy/product-gate"; operationId: "postAutonomyProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/autonomy/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/autonomy/release-dossier"; operationId: "postAutonomyReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/autonomy/review": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/autonomy/review"; operationId: "postAutonomyReview"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/consume": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/consume"; operationId: "postCapabilityConsume"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/issue": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/issue"; operationId: "postCapabilityIssue"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/journal/import-recovery": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/journal/import-recovery"; operationId: "postCapabilityJournalImportRecovery"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/key-rotation-drill": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/key-rotation-drill"; operationId: "postCapabilityKeyRotationDrill"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/lifecycle/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/lifecycle/product-gate"; operationId: "postCapabilityLifecycleProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/lifecycle/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/lifecycle/release-dossier"; operationId: "postCapabilityLifecycleReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/revoke": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/revoke"; operationId: "postCapabilityRevoke"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/capability/validate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/capability/validate"; operationId: "postCapabilityValidate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/classify": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/classify"; operationId: "postDataClassify"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/false-positive-review": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/false-positive-review"; operationId: "postDataFalsePositiveReview"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/precision-recall-trend": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/precision-recall-trend"; operationId: "postDataPrecisionRecallTrend"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/product-gate"; operationId: "postDataProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/release-dossier"; operationId: "postDataReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/data/tuning-dashboard": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/data/tuning-dashboard"; operationId: "postDataTuningDashboard"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/as-code/ci-annotation": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/as-code/ci-annotation"; operationId: "postPolicyAsCodeCiAnnotation"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/as-code/ci-approval-artifact": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/as-code/ci-approval-artifact"; operationId: "postPolicyAsCodeCiApprovalArtifact"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/as-code/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/as-code/product-gate"; operationId: "postPolicyAsCodeProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/as-code/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/as-code/release-dossier"; operationId: "postPolicyAsCodeReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/bundle/rotate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/bundle/rotate"; operationId: "postPolicyBundleRotate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/constitution/change": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/constitution/change"; operationId: "postPolicyConstitutionChange"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/constitution/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/constitution/release-dossier"; operationId: "postPolicyConstitutionReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/constitution/review": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/constitution/review"; operationId: "postPolicyConstitutionReview"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/evaluate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/evaluate"; operationId: "postPolicyEvaluate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/policy/reload": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/policy/reload"; operationId: "postPolicyReload"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/risk/calibration/review": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/risk/calibration/review"; operationId: "postRiskCalibrationReview"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/risk/calibration/run": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/risk/calibration/run"; operationId: "postRiskCalibrationRun"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/risk/drift-trend": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/risk/drift-trend"; operationId: "postRiskDriftTrend"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/risk/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/risk/product-gate"; operationId: "postRiskProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/risk/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/risk/release-dossier"; operationId: "postRiskReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/prompt-injection/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/prompt-injection/product-gate"; operationId: "postSecurityPromptInjectionProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/prompt-injection/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/prompt-injection/release-dossier"; operationId: "postSecurityPromptInjectionReleaseDossier"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/prompt-injection/run": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/prompt-injection/run"; operationId: "postSecurityPromptInjectionRun"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/prompt-injection/semantic-trend": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/prompt-injection/semantic-trend"; operationId: "postSecurityPromptInjectionSemanticTrend"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/redteam/run": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/redteam/run"; operationId: "postSecurityRedteamRun"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/security/scan": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/security/scan"; operationId: "postSecurityScan"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/tool-output/artifact-diff": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/tool-output/artifact-diff"; operationId: "postToolOutputArtifactDiff"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/tool-output/evaluate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/tool-output/evaluate"; operationId: "postToolOutputEvaluate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/tool-output/product-gate": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/tool-output/product-gate"; operationId: "postToolOutputProductGate"; responseCodes: ["200"]; };
  "E_POLICY_SECURITY:POST:/tool-output/release-dossier": { moduleId: "E_POLICY_SECURITY"; method: "POST"; path: "/tool-output/release-dossier"; operationId: "postToolOutputReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/advanced-learning": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/advanced-learning"; operationId: "getAdvancedLearning"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/advanced-learning/skill-registry": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/advanced-learning/skill-registry"; operationId: "getAdvancedLearningSkillRegistry"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/advanced-learning/verifier": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/advanced-learning/verifier"; operationId: "getAdvancedLearningVerifier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/autonomy/candidates": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/autonomy/candidates"; operationId: "getAutonomyCandidates"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/autonomy/candidates/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/autonomy/candidates/trends"; operationId: "getAutonomyCandidatesTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures"; operationId: "getFailures"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/effectiveness-tuning": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/effectiveness-tuning"; operationId: "getFailuresEffectivenessTuning"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/guardrail-review-queue": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/guardrail-review-queue"; operationId: "getFailuresGuardrailReviewQueue"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/recurrence-dashboard": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/recurrence-dashboard"; operationId: "getFailuresRecurrenceDashboard"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/recurrence-visualization": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/recurrence-visualization"; operationId: "getFailuresRecurrenceVisualization"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/taxonomy-fixtures": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/taxonomy-fixtures"; operationId: "getFailuresTaxonomyFixtures"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/failures/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/failures/trends"; operationId: "getFailuresTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/genomes/drift-diff": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/genomes/drift-diff"; operationId: "getGenomesDriftDiff"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/genomes/threshold-alerts": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/genomes/threshold-alerts"; operationId: "getGenomesThresholdAlerts"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/genomes/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/genomes/trends"; operationId: "getGenomesTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/genomes/weight-calibration": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/genomes/weight-calibration"; operationId: "getGenomesWeightCalibration"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/growth/review/latest": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/growth/review/latest"; operationId: "getGrowthReviewLatest"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/health": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/health"; operationId: "getHealth"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score"; operationId: "getMaturityScore"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score/alerts": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score/alerts"; operationId: "getMaturityScoreAlerts"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score/dashboard": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score/dashboard"; operationId: "getMaturityScoreDashboard"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score/threshold-profile": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score/threshold-profile"; operationId: "getMaturityScoreThresholdProfile"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score/thresholds": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score/thresholds"; operationId: "getMaturityScoreThresholds"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/maturity-score/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/maturity-score/trends"; operationId: "getMaturityScoreTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/fixtures": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/fixtures"; operationId: "getMemoryEventsFixtures"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/generated-fixture-drift": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/generated-fixture-drift"; operationId: "getMemoryEventsGeneratedFixtureDrift"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/ingest-telemetry": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/ingest-telemetry"; operationId: "getMemoryEventsIngestTelemetry"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/learning-verifier-matrix": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/learning-verifier-matrix"; operationId: "getMemoryEventsLearningVerifierMatrix"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/operational-corpus": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/operational-corpus"; operationId: "getMemoryEventsOperationalCorpus"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/schema": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/schema"; operationId: "getMemoryEventsSchema"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/events/schema-bundle": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/events/schema-bundle"; operationId: "getMemoryEventsSchemaBundle"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/hygiene/decisions/history": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/hygiene/decisions/history"; operationId: "getMemoryHygieneDecisionsHistory"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/hygiene/report": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/hygiene/report"; operationId: "getMemoryHygieneReport"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/hygiene/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/hygiene/trends"; operationId: "getMemoryHygieneTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/minimize/false-positive-dashboard": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/minimize/false-positive-dashboard"; operationId: "getMemoryMinimizeFalsePositiveDashboard"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/minimize/fixtures": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/minimize/fixtures"; operationId: "getMemoryMinimizeFixtures"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/retention/calendar": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/retention/calendar"; operationId: "getMemoryRetentionCalendar"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/retention/policy-ui": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/retention/policy-ui"; operationId: "getMemoryRetentionPolicyUi"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/retention/report": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/retention/report"; operationId: "getMemoryRetentionReport"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/memory/retention/schedule": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/memory/retention/schedule"; operationId: "getMemoryRetentionSchedule"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/openapi.json": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/openapi.json"; operationId: "getOpenapiJson"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/patterns": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/patterns"; operationId: "getPatterns"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/patterns/cluster-review": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/patterns/cluster-review"; operationId: "getPatternsClusterReview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/patterns/corpus": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/patterns/corpus"; operationId: "getPatternsCorpus"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/patterns/embedding-adapters": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/patterns/embedding-adapters"; operationId: "getPatternsEmbeddingAdapters"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/patterns/trends": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/patterns/trends"; operationId: "getPatternsTrends"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/planning-context": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/planning-context"; operationId: "getPlanningContext"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/planning-guardrails": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/planning-guardrails"; operationId: "getPlanningGuardrails"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences"; operationId: "getPreferences"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences/confidence-calibration": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences/confidence-calibration"; operationId: "getPreferencesConfidenceCalibration"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences/confirmed": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences/confirmed"; operationId: "getPreferencesConfirmed"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences/confirmed/drift-trend": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences/confirmed/drift-trend"; operationId: "getPreferencesConfirmedDriftTrend"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences/conflicts": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences/conflicts"; operationId: "getPreferencesConflicts"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/preferences/tolerance-profile": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/preferences/tolerance-profile"; operationId: "getPreferencesToleranceProfile"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/storage/at-rest-encryption-policy": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/storage/at-rest-encryption-policy"; operationId: "getStorageAtRestEncryptionPolicy"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/storage/backup-location-policy": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/storage/backup-location-policy"; operationId: "getStorageBackupLocationPolicy"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/storage/backups/retention": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/storage/backups/retention"; operationId: "getStorageBackupsRetention"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/storage/encryption-key": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/storage/encryption-key"; operationId: "getStorageEncryptionKey"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/storage/status": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/storage/status"; operationId: "getStorageStatus"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:GET:/trends/archive": { moduleId: "F_GROWTH_MEMORY"; method: "GET"; path: "/trends/archive"; operationId: "getTrendsArchive"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:PATCH:/preferences/confirmed/{preferenceId}": { moduleId: "F_GROWTH_MEMORY"; method: "PATCH"; path: "/preferences/confirmed/{preferenceId}"; operationId: "patchPreferencesConfirmedPreferenceId"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/advanced-learning/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/advanced-learning/product-gate"; operationId: "postAdvancedLearningProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/advanced-learning/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/advanced-learning/release-dossier"; operationId: "postAdvancedLearningReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/advanced-learning/skill-drafts/{draftId}/review": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/advanced-learning/skill-drafts/{draftId}/review"; operationId: "postAdvancedLearningSkillDraftsDraftIdReview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/advanced-learning/skill-registry/{skillId}/usefulness": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/advanced-learning/skill-registry/{skillId}/usefulness"; operationId: "postAdvancedLearningSkillRegistrySkillIdUsefulness"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/autonomy/candidates/{candidateId}/review": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/autonomy/candidates/{candidateId}/review"; operationId: "postAutonomyCandidatesCandidateIdReview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/autonomy/candidates/{candidateId}/submit-to-policy": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/autonomy/candidates/{candidateId}/submit-to-policy"; operationId: "postAutonomyCandidatesCandidateIdSubmitToPolicy"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/autonomy/candidates/expiry/run": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/autonomy/candidates/expiry/run"; operationId: "postAutonomyCandidatesExpiryRun"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/autonomy/candidates/generate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/autonomy/candidates/generate"; operationId: "postAutonomyCandidatesGenerate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/autonomy/candidates/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/autonomy/candidates/release-dossier"; operationId: "postAutonomyCandidatesReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/events": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/events"; operationId: "postEvents"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/failures/{failureId}/guardrail": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/failures/{failureId}/guardrail"; operationId: "postFailuresFailureIdGuardrail"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/failures/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/failures/product-gate"; operationId: "postFailuresProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/failures/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/failures/release-dossier"; operationId: "postFailuresReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/feedback": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/feedback"; operationId: "postFeedback"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/genomes/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/genomes/product-gate"; operationId: "postGenomesProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/genomes/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/genomes/release-dossier"; operationId: "postGenomesReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/maturity-score/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/maturity-score/product-gate"; operationId: "postMaturityScoreProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/maturity-score/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/maturity-score/release-dossier"; operationId: "postMaturityScoreReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/maturity-score/threshold-migration-diff": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/maturity-score/threshold-migration-diff"; operationId: "postMaturityScoreThresholdMigrationDiff"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/maturity-score/thresholds/calibration": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/maturity-score/thresholds/calibration"; operationId: "postMaturityScoreThresholdsCalibration"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/events/migration-compatibility": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/events/migration-compatibility"; operationId: "postMemoryEventsMigrationCompatibility"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/events/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/events/product-gate"; operationId: "postMemoryEventsProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/events/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/events/release-dossier"; operationId: "postMemoryEventsReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/events/schema-diff": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/events/schema-diff"; operationId: "postMemoryEventsSchemaDiff"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/events/schema-diff-review": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/events/schema-diff-review"; operationId: "postMemoryEventsSchemaDiffReview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/hygiene/decisions": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/hygiene/decisions"; operationId: "postMemoryHygieneDecisions"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/hygiene/decisions/batch": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/hygiene/decisions/batch"; operationId: "postMemoryHygieneDecisionsBatch"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/hygiene/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/hygiene/product-gate"; operationId: "postMemoryHygieneProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/hygiene/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/hygiene/release-dossier"; operationId: "postMemoryHygieneReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/minimize/preview": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/minimize/preview"; operationId: "postMemoryMinimizePreview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/minimize/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/minimize/release-dossier"; operationId: "postMemoryMinimizeReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/query": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/query"; operationId: "postMemoryQuery"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/retention/apply": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/retention/apply"; operationId: "postMemoryRetentionApply"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/memory/retention/run": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/memory/retention/run"; operationId: "postMemoryRetentionRun"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/patterns/calibration": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/patterns/calibration"; operationId: "postPatternsCalibration"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/patterns/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/patterns/product-gate"; operationId: "postPatternsProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/{hypothesisId}/decision": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/{hypothesisId}/decision"; operationId: "postPreferencesHypothesisIdDecision"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/batch-decision": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/batch-decision"; operationId: "postPreferencesBatchDecision"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/{preferenceId}": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/{preferenceId}"; operationId: "postPreferencesConfirmedPreferenceId"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/{preferenceId}/revoke": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/{preferenceId}/revoke"; operationId: "postPreferencesConfirmedPreferenceIdRevoke"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/application-preview": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/application-preview"; operationId: "postPreferencesConfirmedApplicationPreview"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/conflict-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/conflict-dossier"; operationId: "postPreferencesConfirmedConflictDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/migration-review-queue": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/migration-review-queue"; operationId: "postPreferencesConfirmedMigrationReviewQueue"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/product-gate"; operationId: "postPreferencesConfirmedProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/confirmed/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/confirmed/release-dossier"; operationId: "postPreferencesConfirmedReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/migration-diff": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/migration-diff"; operationId: "postPreferencesMigrationDiff"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/product-gate"; operationId: "postPreferencesProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/preferences/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/preferences/release-dossier"; operationId: "postPreferencesReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/backup": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/backup"; operationId: "postStorageBackup"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/backups/rotate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/backups/rotate"; operationId: "postStorageBackupsRotate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/encrypted-backup": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/encrypted-backup"; operationId: "postStorageEncryptedBackup"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/large-migration-fixture": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/large-migration-fixture"; operationId: "postStorageLargeMigrationFixture"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/periodic-restore-drill": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/periodic-restore-drill"; operationId: "postStoragePeriodicRestoreDrill"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/product-gate": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/product-gate"; operationId: "postStorageProductGate"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/release-dossier": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/release-dossier"; operationId: "postStorageReleaseDossier"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/restore": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/restore"; operationId: "postStorageRestore"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/restore-drill": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/restore-drill"; operationId: "postStorageRestoreDrill"; responseCodes: ["200"]; };
  "F_GROWTH_MEMORY:POST:/storage/worm-sync": { moduleId: "F_GROWTH_MEMORY"; method: "POST"; path: "/storage/worm-sync"; operationId: "postStorageWormSync"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/baseline/approval-dashboard": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/baseline/approval-dashboard"; operationId: "getBaselineApprovalDashboard"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/baseline/ci-trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/baseline/ci-trend"; operationId: "getBaselineCiTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/baseline/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/baseline/trend"; operationId: "getBaselineTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/bridge-security/corpus": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/bridge-security/corpus"; operationId: "getBridgeSecurityCorpus"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/documents/invariants": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/documents/invariants"; operationId: "getDocumentsInvariants"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/documents/invariants/dedupe": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/documents/invariants/dedupe"; operationId: "getDocumentsInvariantsDedupe"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/documents/invariants/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/documents/invariants/trend"; operationId: "getDocumentsInvariantsTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/fixtures/matrix": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/fixtures/matrix"; operationId: "getFixturesMatrix"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/golden-traces": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/golden-traces"; operationId: "getGoldenTraces"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/golden-traces/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/golden-traces/retention"; operationId: "getGoldenTracesRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/health": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/health"; operationId: "getHealth"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/openapi.json": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/openapi.json"; operationId: "getOpenapiJson"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/redteam/corpus": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/redteam/corpus"; operationId: "getRedteamCorpus"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/redteam/quarantine": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/redteam/quarantine"; operationId: "getRedteamQuarantine"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/redteam/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/redteam/retention"; operationId: "getRedteamRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/redteam/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/redteam/trend"; operationId: "getRedteamTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/regression/dashboard": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/regression/dashboard"; operationId: "getRegressionDashboard"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/regression/external-fixtures": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/regression/external-fixtures"; operationId: "getRegressionExternalFixtures"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports"; operationId: "getReports"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports/{reportId}": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports/{reportId}"; operationId: "getReportsReportId"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports/retention"; operationId: "getReportsRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports/retention-policy-ui": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports/retention-policy-ui"; operationId: "getReportsRetentionPolicyUi"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports/trend"; operationId: "getReportsTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/reports/trend/visualization": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/reports/trend/visualization"; operationId: "getReportsTrendVisualization"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/score/dashboard": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/score/dashboard"; operationId: "getScoreDashboard"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/score/document-rubric": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/score/document-rubric"; operationId: "getScoreDocumentRubric"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/score/rubric": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/score/rubric"; operationId: "getScoreRubric"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/simulation/expanded-scenarios": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/simulation/expanded-scenarios"; operationId: "getSimulationExpandedScenarios"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/simulation/scenarios": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/simulation/scenarios"; operationId: "getSimulationScenarios"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/simulation/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/simulation/trend"; operationId: "getSimulationTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/simulation/trend/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/simulation/trend/retention"; operationId: "getSimulationTrendRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/approval-flow/device-smoke": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/approval-flow/device-smoke"; operationId: "getVerifyApprovalFlowDeviceSmoke"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/approval-flow/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/approval-flow/retention"; operationId: "getVerifyApprovalFlowRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/approval-flow/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/approval-flow/trend"; operationId: "getVerifyApprovalFlowTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/approval-flow/ux-latency-trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/approval-flow/ux-latency-trend"; operationId: "getVerifyApprovalFlowUxLatencyTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/execution/external-fixtures": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/execution/external-fixtures"; operationId: "getVerifyExecutionExternalFixtures"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/execution/quarantine": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/execution/quarantine"; operationId: "getVerifyExecutionQuarantine"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/execution/retention": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/execution/retention"; operationId: "getVerifyExecutionRetention"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/execution/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/execution/trend"; operationId: "getVerifyExecutionTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/learning/fixtures": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/learning/fixtures"; operationId: "getVerifyLearningFixtures"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/plan/fixtures": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/plan/fixtures"; operationId: "getVerifyPlanFixtures"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/plan/fixtures/trend": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/plan/fixtures/trend"; operationId: "getVerifyPlanFixturesTrend"; responseCodes: ["200"]; };
  "G_VERIFICATION:GET:/verify/plan/regression-visualization": { moduleId: "G_VERIFICATION"; method: "GET"; path: "/verify/plan/regression-visualization"; operationId: "getVerifyPlanRegressionVisualization"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/baseline/approved-update": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/baseline/approved-update"; operationId: "postBaselineApprovedUpdate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/baseline/compare": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/baseline/compare"; operationId: "postBaselineCompare"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/bridge-security/product-drill": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/bridge-security/product-drill"; operationId: "postBridgeSecurityProductDrill"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/bridge-security/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/bridge-security/release-dossier"; operationId: "postBridgeSecurityReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/documents/invariants/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/documents/invariants/run"; operationId: "postDocumentsInvariantsRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/fixtures/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/fixtures/run"; operationId: "postFixturesRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/golden-traces": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/golden-traces"; operationId: "postGoldenTraces"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/golden-traces/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/golden-traces/release-dossier"; operationId: "postGoldenTracesReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/golden-traces/rotate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/golden-traces/rotate"; operationId: "postGoldenTracesRotate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/redteam/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/redteam/product-gate"; operationId: "postRedteamProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/redteam/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/redteam/run"; operationId: "postRedteamRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/regression/artifacts/sync": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/regression/artifacts/sync"; operationId: "postRegressionArtifactsSync"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/regression/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/regression/product-gate"; operationId: "postRegressionProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/regression/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/regression/release-dossier"; operationId: "postRegressionReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/regression/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/regression/run"; operationId: "postRegressionRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/release/gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/release/gate"; operationId: "postReleaseGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/release/schedule/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/release/schedule/run"; operationId: "postReleaseScheduleRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/artifacts/sync": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/artifacts/sync"; operationId: "postReportsArtifactsSync"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/cleanup": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/cleanup"; operationId: "postReportsCleanup"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/cleanup/approval": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/cleanup/approval"; operationId: "postReportsCleanupApproval"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/diff": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/diff"; operationId: "postReportsDiff"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/product-gate"; operationId: "postReportsProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/reports/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/reports/release-dossier"; operationId: "postReportsReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/score": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/score"; operationId: "postScore"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/score/ci-annotation": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/score/ci-annotation"; operationId: "postScoreCiAnnotation"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/score/gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/score/gate"; operationId: "postScoreGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/score/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/score/product-gate"; operationId: "postScoreProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/simulate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/simulate"; operationId: "postSimulate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/simulation/chaos-schedule/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/simulation/chaos-schedule/run"; operationId: "postSimulationChaosScheduleRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/simulation/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/simulation/release-dossier"; operationId: "postSimulationReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/tool-poisoning-leak/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/tool-poisoning-leak/release-dossier"; operationId: "postToolPoisoningLeakReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/tool-poisoning-leak/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/tool-poisoning-leak/run"; operationId: "postToolPoisoningLeakRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/approval-flow": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/approval-flow"; operationId: "postVerifyApprovalFlow"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/approval-flow/corpus": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/approval-flow/corpus"; operationId: "postVerifyApprovalFlowCorpus"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/approval-flow/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/approval-flow/product-gate"; operationId: "postVerifyApprovalFlowProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/approval-flow/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/approval-flow/release-dossier"; operationId: "postVerifyApprovalFlowReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/bridge": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/bridge"; operationId: "postVerifyBridge"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/execution": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/execution"; operationId: "postVerifyExecution"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/execution/corpus": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/execution/corpus"; operationId: "postVerifyExecutionCorpus"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/execution/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/execution/product-gate"; operationId: "postVerifyExecutionProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/execution/release-dossier": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/execution/release-dossier"; operationId: "postVerifyExecutionReleaseDossier"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/execution/soak": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/execution/soak"; operationId: "postVerifyExecutionSoak"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/learning": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/learning"; operationId: "postVerifyLearning"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/learning/artifacts/sync": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/learning/artifacts/sync"; operationId: "postVerifyLearningArtifactsSync"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/learning/ci-annotation": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/learning/ci-annotation"; operationId: "postVerifyLearningCiAnnotation"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/learning/fixtures/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/learning/fixtures/run"; operationId: "postVerifyLearningFixturesRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/learning/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/learning/product-gate"; operationId: "postVerifyLearningProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan"; operationId: "postVerifyPlan"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan/artifacts/sync": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan/artifacts/sync"; operationId: "postVerifyPlanArtifactsSync"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan/ci-annotation": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan/ci-annotation"; operationId: "postVerifyPlanCiAnnotation"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan/document-diff-fixtures/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan/document-diff-fixtures/run"; operationId: "postVerifyPlanDocumentDiffFixturesRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan/fixtures/run": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan/fixtures/run"; operationId: "postVerifyPlanFixturesRun"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/plan/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/plan/product-gate"; operationId: "postVerifyPlanProductGate"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/policy": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/policy"; operationId: "postVerifyPolicy"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/policy/ci-annotation": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/policy/ci-annotation"; operationId: "postVerifyPolicyCiAnnotation"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/policy/migration-approval-artifact": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/policy/migration-approval-artifact"; operationId: "postVerifyPolicyMigrationApprovalArtifact"; responseCodes: ["200"]; };
  "G_VERIFICATION:POST:/verify/policy/product-gate": { moduleId: "G_VERIFICATION"; method: "POST"; path: "/verify/policy/product-gate"; operationId: "postVerifyPolicyProductGate"; responseCodes: ["200"]; };
}
export type FederatedOpenApiOperation<Route extends FederatedOpenApiRouteKey> = FederatedOpenApiOperationMap[Route];
export interface FederatedCoreClientContract {
  readonly clientName: "CoreClient";
  readonly bundleHash: typeof federatedOpenApiBundleHash;
  request<Route extends FederatedOpenApiRouteKey>(route: Route): Promise<unknown>;
}
