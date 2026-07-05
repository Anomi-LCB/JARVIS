# JARVIS Local Eureka Runtime

This repository now keeps two layers together:

1. `src/domain` and `src/ui`: a fast executive operations console for visual/state feedback.
2. `packages/*` and `apps/*`: a document-aligned local-first A-G runtime skeleton.

## Document-aligned runtime

The implementation has started moving from a visual prototype into the structure described by the seven source documents:

- `packages/shared`: shared A-G module ids, task/approval/action types, error envelopes, JSONL helpers, and sensitive-field masking.
- `packages/core`: A Common Core Engine with `CoreRuntime` health checks/metrics/restart/fault diagnostics, `CoreRuntimeSupervisor` watchdog heartbeats/restart policy/worker-drain ticks/service supervision plan, Core Windows service lifecycle plan/readiness/CLI/API, `CommandIntake` for CLI/mobile/voice/file/image TaskRequest normalization with attachment metadata and raw-evidence policy, approval-gated `CommandInputProviderRegistry` for local text-file extraction, voice transcript sidecars, image OCR sidecars, redacted safe previews, content hashes, and `rawContentStored=false` evidence, slot-aware `IntentParser`, local semantic intent adapter, paraphrase corpus, rule-vs-semantic comparison report, clarification/replan `AmbiguityResolver`, approval-card clarification requests, clarification chain ledger, replan preview diffs, mobile clarification response replan flow, duplicate same-millisecond task-id collision avoidance, metadata-only `ReadOnlyContextCollector`/`ContextSnapshotBuilder`, approval-gated `DesktopContextCollector` for open-app/screen OCR/OS event provider snapshots with redacted previews, `rawContentStored=false`, provider-status/latency/redaction telemetry, and admin context telemetry reports, pre/postcondition `TaskPlanner` with multi-action DAG, failure branches, and compensation plans, plan-graph runner node execution, node artifact bundles, descendant skip, and partial compensation planning, `ContractRegistry` with JSON Schema bundle/compatibility report, schema snapshot hashes, and federated A/B/D/E/F/G OpenAPI bundle generation, retry/expiry/compensation-aware `TaskStateMachine`, worker task lease table, file-backed worker lease store, file-backed worker queue/run store, expired lease recovery, `CoreWorkerDaemon` queue drain/lease recovery/watchdog loop, durable replayable `EventBus` with subscriber ack, dead-letter delivery records, pending/dead-letter redrive, topic backpressure policy, projection leases, and projection recovery, manifest-based `SkillRouter` with signed manifest verification, signed plugin bundle registry, HTTPS/local-only remote registry sync, bundle rotation drills, manifest-only sandbox worker smoke, manifest-only sandbox load plans, compatibility snapshot regression, legacy capability migration, disabled/deprecated routing policy, and a capability matrix, trace-aware `AgentOrchestratorLite`, durable `OrchestrationJournal` checkpoints, node-level compensation execution records, `CoreOrchestrationWorker` for queued E capability issue, B execution, G verification, F memory ingest, task lock/lease, retry/backoff, timeout metadata, resume context, compensation planning/replay, `CoreFacade`, A-only CLI, `CoreClient`, generated Core API TypeScript route/operation declarations, Core API contract snapshot/diff utilities, CI-style core contract gate, hash-backed role/scope admin auth, and A-only HTTP API with admin diagnostics, OpenAPI 3.1 contract, runtime supervisor status/tick endpoint, service lifecycle plan endpoint, bearer-protected worker daemon start/stop/tick endpoint, worker run endpoint, compensation replay endpoint, worker queue/drain endpoints, and worker lease status/recovery endpoints.
- `apps/pc-agent`: B Local PC Agent with capability validation, AES-GCM sealed `CapabilityTokenVault`, opt-in Windows DPAPI-backed vault key provider metadata, durable `ExecutionPacketJournal` idempotency/replay, retry/backoff `ExecutionPacketQueue` with poison quarantine/review/requeue/ignore, service daemon queue-drain supervisor and watchdog heartbeat, registry-enforced tool adapter contracts, shadow runs, filesystem create/list/move tools with overwrite conflict policy, batch move diff/conflict taxonomy, realpath symlink/junction escape guard, and restore rollback, real XLSX workbook creation with template/style/OOXML chart drawing evidence, read-only browser search evidence with GET-only network capture, sanitized DOM snapshot/hash, Playwright live read-only capture with Python Playwright/system Chrome fallback and screenshot-hash evidence, blocked-operation proofs for download/form/upload/cookie/script paths, tool-specific evidence schema validation and privacy redaction, restart-readable tamper-evident JSONL `UndoJournal`, rollback dry-run plans, rollback transaction lock/journal, digest-signed rollback archive export, bearer-token guarded Local API routes with packet schema validation, OpenAPI 3.1 contract, and rate-limit headers, Windows service install/status/start/stop/restart/update/uninstall planner with recovery restart actions, installer package generator with lifecycle PowerShell scripts, file-integrity manifest, local digest signature, verify-package, installed-service smoke verification, full install orchestrator, diagnostic log collection scripts, service readiness verifier through CLI/API, Windows Forms notification-area tray script with queue/poison review state, C# native tray source/build script, tray launcher/startup shortcut scripts, Authenticode signing/verification scripts, dev code-signing certificate helper, NSIS installer template/build script, release manifest/evidence aggregator, tray state/actions/API, sample execution packets, G verification evidence, and F memory events.
- `apps/bridge`: D Bridge runtime with local/private-network guard for IPv4, IPv6, IPv4-mapped IPv6, and forwarded-host checks, health/openapi/server-profile endpoints, random expiring pairing sessions with QR payloads and re-pair token replacement, device-token authentication, IP/token/device/action token-bucket rate limiting, request validation/sanitization/tier guard with path/header/body/query contracts, device listing/revocation, heartbeat, requestId replay blocking, task/approval/result/feedback/growth routing, JSONL-backed state cache with restart replay, categorized hash-chained audit trail with cursor summary, signed export, archive rotation APIs, sanitized recent events, `task.status.changed`/`approval.created`/`execution.completed` events, and SSE streaming with heartbeat, bounded replay, reconnect cursor, stream status, and ack cursor APIs.
- `apps/policy-security`: E Policy/Security runtime with OpenAPI 3.1 route contract, JSON policy-as-code manifest/compiler, signed HMAC policy bundles, policy hot reload, policy versioning, immutable constitution endpoint with SHA-256 hash pinning, risk classification, approval policy, mobile approval guard, approval expiry/renewal, signed capability issue/validate/consume/revoke, token hash journal, TTL/scope enforcement, multi-rule PII/ministry data classification with risk-tier hints, trust-boundary labeling, policy-driven prompt-injection rules, quoted-content non-executable quarantine, tool-output poisoning eligibility gate with durable JSONL provenance/taint lineage replay, external-content quarantine, autonomy candidate checks, and hash-chain audit summary/export/rotation APIs.
- `apps/growth-memory`: F Growth Memory runtime with OpenAPI 3.1 route contract, MemoryEvent union schema validation, source-specific safety downgrades, duplicate/do-not-remember handling, E-classifier-linked sensitive-memory minimization with hash-only redaction diffs, retention report/apply workflow, retention scheduler/status/run APIs, hygiene trend report, batch hygiene decision API, field retention metadata and safe fingerprints, workflow-signature pattern mining with positive/negative evidence, cadence/support scoring, local token-vector cosine similarity, semantic cluster merge evidence, trend history, and threshold calibration, preference hypotheses with explanations/conflict profiles and local semantic conflict classifier, confirmed/rejected/updated/revoked preference lifecycle, A planning-context preference hints, failure memories with cause taxonomy, plan links, guardrail checklists, prevented-recurrence metrics, A TaskPlanner planningGuardrail injection, recurrence trends, user guardrail review API, and taxonomy fixture coverage, weighted workflow/preference/decision/risk genomes with trend history, CloneEvidence, StyleGenome, SkillDistillation drafts with review-gated SkillDraftRegistry entries, G LearningVerifier-linked maturity scoring with trend, threshold alerts, and threshold calibration API, autonomy candidate lifecycle generation/submission/review with E policy results, memory context query, hygiene reports with keep/delete/redact/defer review decisions, SQLite-backed hygiene decision replay, audit records, storage status/backup/restore, restore drill, backup retention/rotation APIs, and growth reviews.
- `apps/growth-memory/src/db`: SQLite-backed MemoryEvent, ConfirmedPreference, GrowthReview, and HygieneDecision persistence with schema migrations, schema metadata retention, WAL/foreign-key pragmas, transaction boundaries, integrity checks, local backup/restore, read-only restore drill reports, and backup retention/rotation. Runtime reviews are also written as JSON files under the configured review directory.
- `apps/mobile`: C Mobile/Tablet app shell with typed API contracts, BridgeClient, Expo native capability contract for SecureStore/Notifications, QR/manual pairing contract with sealed token evidence, pairing/connection runtime, AES-GCM sealed token storage metadata, PIN/session-timeout lock gates, background/inactive lifecycle auto-lock for sensitive approvals, execution handoff, poison packet operations, queue drain/soak refresh, and retry policy updates, command composer validation/offline queue review, approval queue/detail action-state UI with mobile high-risk block reasons and clarification choice responses, task live polling, result file preview, rollback, feedback pending/error action-state flows, growth review confidence explanation, contradiction evidence, hygiene trend, single/batch hygiene decision client path, and decision pending/error/latency state, PC agent poison queue review/requeue/ignore/drain view-models with refresh delta and visual snapshot, retry policy settings view-models, RN action panel states, NativeRuntimeProbe UI for SecureStore/Notifications device evidence, notification permission/channel/delivery-log/receipt verification pipeline with background issue queue, mobile verification harness with native readiness checks, poison queue runtime/drain/soak evidence, retry policy update evidence, notification receipt evidence, and native runtime probe evidence, Android Platform Tools setup/report helper, Android Emulator/AVD readiness report, Android Gradle/APK/install verification report, app.json package-aligned ADB device probe, product build/install command matrix, artifact manifest, growth review decision view-models, and approval card UI components.
- `apps/wearable-hud`: C/D Wearable HUD Adapter for voice-driven AI glasses and monochrome green VR displays. It compacts bridge/task/approval state into a six-line safe HUD frame, stores only transcript hashes/redacted previews, blocks high-risk direct wearable approvals, routes Tier 3+ approval to PC confirmation, renders a black/green browser HUD preview, ships a browser-safe live HUD client with memory-only token handling and Web Speech API support, and writes product-gate/field-kit evidence through `npm run wearable:verify`.
- `apps/verification`: G Verification runtime with OpenAPI 3.1 route contract, plan/approval-flow/bridge/policy/execution/learning verification, C session lock/biometric/native approval-flow checks, policy-as-code/capability compliance checks, execution evidence profile, B adapter fixture corpus coverage, undo/rollback transaction hash-chain checks, bridge network/replay/rate-limit security corpus checks, durable request nonce/rate-limit replay checks, authenticated SSE/WebSocket-fallback policy checks, F MemoryEvent union-schema, redaction-diff, hygiene decision, hygiene trend, and retention scheduler checks, capability and evidence checks, g-simulation-scenario-pack-v2 dry-run scenario fixture file with B execution replay and trend API, plan/policy/learning fixture matrix with CI threshold/triage, prompt-injection redteam fixture pack with pass-rate threshold, tool-poisoning/sensitive-leak fixture pack with HTML diff artifact, regression suite with g-regression-dashboard-v1 and g-regression-triage-html-v1 artifacts, g-operational-release-gate-v1 product-promotion gate, approved GoldenTrace/BaselineComparator update, baseline diff HTML artifact, and trend APIs, F learning-signal emission, sanitized persisted JSON/HTML reports with index/trend/diff/retention-dashboard/cleanup APIs, and rubric-based 12D score output with rubric/gate APIs and dimension details.
- Runtime HTTP APIs are implemented for B/D/E/F/G, including local execution packets, rollback, pairing, device management, heartbeat, task creation/list/status, approval decisions/renewal, execution handoff confirmation, results, feedback, event feed/SSE, state cache snapshots, policy evaluation, capability token issue/validate/consume/revoke, memory event ingest/query/review/autonomy, growth review, verification, redteam, simulation, regression dashboard, release gate, reports, and 12D score routes.

Current note: the source documents specify TypeScript + pnpm workspaces, and several apps eventually call for Fastify, Expo, and SQLite. This repo now has the workspace-shaped runtime and tests first, while still using dependency-free Node modules so the contract can run immediately on this machine. The next implementation pass can replace the lightweight HTTP/runtime pieces with Fastify/SQLite/Expo without changing the A-G safety contracts.

## Runtime scripts

```bash
npm test
npm run build
npm run ag:smoke -- "엑셀 만들어"
npm run ag:audit
npm run ag:gap
npm run ag:product-gate
npm run core:contract-gate -- --baseline packages/core/contracts/core-openapi-snapshot.json --report dist/core-contract-gate-report.json
npm run core:generate-types
npm run core:dev -- "엑셀 만들어" --approve
npm run core:api
npm run core:service -- status
npm run core:service-runtime
npm run core:service-smoke -- --output dist/core-service-smoke-report.json
npm run core:service-soak -- --output dist/core-service-soak-report.json --task-count 4 --duration-ms 250
npm run core:service-package -- --output-dir dist/core-service-package
npm run pc-agent:dev -- "엑셀 만들어"
npm run pc-agent:packet
npm run pc-agent:api
set JARVIS_BROWSER_DRIVER=playwright
npm run pc-agent:service -- install
npm run pc-agent:service -- verify --package-dir dist/pc-agent-installer
npm run pc-agent:service -- verify --package-dir dist/pc-agent-installer --output dist/pc-agent-service-verification.json
npm run pc-agent:daemon-smoke -- --output dist/pc-agent-installer/daemon-smoke-report.json
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/build-tray-exe.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/verify-installed-service.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/install-all.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/install-verify-release.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/build-nsis-installer.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/create-dev-signing-cert.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/sign-artifacts.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/verify-signatures.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/verify-release-gate.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/pc-agent-installer/build-release-evidence.ps1
npm run bridge:dev
npm run policy:dev
npm run growth:dev
npm run growth:quality
npm run verification:dashboard
npm run wearable:verify
npm run wearable:field-kit
npm run verification:dev
npm run ops:completion-ledger
npm run ops:ci-annotations -- --no-emit
npm run ops:release-attestation
npm run ops:release-verify -- --no-emit
```

This repository implements a lightweight, dependency-free prototype that follows the seven JARVIS development-document streams:

1. **A · Common core engine** — orchestrates commands, module state, workflow progress, and dashboard composition.
2. **B · Local PC control program** — converts natural commands into executable local capability plans.
3. **C · Mobile/tablet app** — pairs to the local bridge, stores the device token through the sealed mobile token store, sends text TaskRequest payloads, reviews offline commands before manual sync, gates sensitive approval/execution/poison packet/retry policy actions behind session unlock and lifecycle auto-lock, displays task/result state, reviews PC agent poison queue items, tunes retry policy, and sends feedback into growth memory.
4. **D · PC/mobile communication bridge** — safely relays mobile commands, approvals, status, results, notifications, feedback, and growth reviews across the local PC runtime without interpreting or executing the task itself.
5. **E · Permission/approval/security system** — classifies action/data risk, blocks forbidden or injected requests, enforces approval mode and mobile approval limits, issues narrow single-use capability tokens, and rejects unsafe autonomy contracts.
6. **F · Growth memory/learning system** — stores evidence-based events, mines repeated safe workflows, keeps preferences as hypotheses until review confirms or rejects them, preserves and reviews failure guardrails, injects those guardrails into A planning, minimizes sensitive memories, and submits automation candidates to E instead of approving them itself.
7. **G · Test/validation simulation system** — verifies plans, approval cards, approval flow, bridge auth, policy/capability compliance, execution evidence, learning hygiene, red-team scenarios, regression stability, reports, and 12D evaluation scores.

The visual direction now uses a cynical, restrained operations-console language: near-black surfaces, compact information density, steel accents, clear risk colors, a circular central progress instrument, schedule/approval/nearby/connection side panels, and a bottom command dock.

## Prototype flow

- Use the command console or bottom dock to switch between meeting analysis, screen capture, voice recording, search, memo, and system inspection flows.
- The seven-module strip shows live telemetry for core orchestration, local PC planning, mobile sync, bridge routing, security, memory, and simulation.
- The **A-G 문서 진행** panel maps each source document to implementation status, current evidence, risk health, and next engineering action.
- The readiness gate converts A-G status into `GO`, `REVIEW`, or `BLOCKED`, then generates a prioritized next-action queue.
- `설정 점검` intentionally requires admin approval. In normal mode it stays on hold; toggling `관리자 승인` clears the security gate and records the elevated run in command history.
- Recent commands, audit events, learned memories, local execution plans, and validation scenario results update together so the console demonstrates the full A-G document pipeline.

## A-G implementation map

| Doc | Stream | Current implementation |
| --- | --- | --- |
| A | Common core engine | Runtime lifecycle, health checks/metrics/restart/fault diagnostics, CoreRuntimeSupervisor watchdog heartbeat/restart/service-plan evidence, Core Windows service lifecycle plan/readiness/CLI/API, CLI/mobile/voice/file/image command intake with approval-gated local text-file, voice transcript sidecar, and image OCR sidecar providers, TaskRequest with attachment metadata/raw evidence, redacted safe previews, content hashes, rawContentStored=false provider evidence, duplicate same-millisecond task-id collision avoidance, IntentCandidate with slot/entity/complexity evidence, local semantic adapter comparison, AmbiguitySet and approval-card ClarificationRequest, clarification chain ledger with preview diff, C mobile clarification choice response to A replan, ContextSnapshot with metadata-only workspace scan plus approval-gated DesktopContextCollector for open apps/screen OCR/OS events, rawContentStored=false contract, redacted previews, provider-status/latency/redaction telemetry, and admin `contextTelemetry` reports, structured TaskPlan with planGraph/failureBranches/compensationPlan, plan-graph runner, node artifact bundles, dependent-node skip, partial compensation target filtering, PolicyCheckRequest, ApprovalCard, CapabilityRequest, ExecutionPacket creation, CoreOrchestrationWorker E capability issue/B execution/G policy-plan-execution verification/F memory ingest flow, queue enqueue/drain, per-tick queue duplicate processing guard, file-backed queue/run restore, CoreWorkerDaemon watchdog/tick loop, task lock/lease, retry/backoff, timeout metadata, file-backed worker lease store with restart recovery, expired lease recovery, node-level compensation replay with rollback proof, worker trace phases and `/tasks/:taskId/run`, `/tasks/:taskId/compensation/run`, `/tasks/:taskId/queue`, `/worker/queue/drain`, bearer-protected `/worker/daemon`, `/worker/daemon/start`, `/worker/daemon/stop`, `/worker/daemon/tick`, `/worker/leases`, `/worker/leases/recover`, `/runtime/supervisor`, `/runtime/supervisor/tick`, `/runtime/service-plan` APIs, hash-backed `a-core-admin-auth-v1` role/scope auth, JSON Schema bundle/compatibility report/schema snapshot for core contracts, federated A/B/D/E/F/G OpenAPI contract bundle, CoreClient task/admin/worker/compensation calls, generated Core API route/operation TypeScript declarations, `a-core-api-contract-snapshot-v1`, `a-core-api-contract-diff-v1`, `a-core-contract-gate-v1` breaking-change approval gate, retry/expiry/compensation state transitions with lifecycle/trace events, durable replayable CoreEvent JSONL with subscriber ack/dead-letter records plus pending/dead-letter redrive, topic backpressure policy, projection leases, and projection recovery, signed/migrated/disabled-aware SkillRouter capability matrix, signed plugin bundle registry, HTTPS/local remote registry sync, bundle rotation drill, sandbox worker smoke, sandbox load plans, compatibility snapshot/regression diagnostics, durable orchestration checkpoints, node resume context, compensation planning/execution journal, A-only CLI/API routes, admin diagnostics, dummy execution |
| B | Local PC control | ExecutionPacket receiver, durable packet journal, retry/backoff queue with retry policy read/update journal/API and poison quarantine/review/requeue/ignore API, service daemon queue-drain supervisor with watchdog heartbeat/runtime API, tray queue/poison review status and notifications, idempotent replay after duplicate/restart, capability guard with AES-GCM sealed local token vault and opt-in Windows DPAPI key provider metadata, shadow run, text file creation with target-exists conflict policy, batch move diff/conflict taxonomy, realpath symlink/junction escape guard, and restore rollback, XLSX workbook creation with OOXML chart/drawing parts, file list, move preview, approved move, read-only browser search with network/DOM/block proof evidence plus Playwright live capture, Python Playwright/system Chrome fallback, and screenshot hash, tamper-evident UndoJournal rollback with chain verification API, dry-run rollback plan API, transaction lock/journal API, digest-signed rollback archive export API, tool-specific ExecutionEvidence schema validation/privacy redaction, ExecutionMemoryEvent, bearer-token guarded Local API with packet schema validation, OpenAPI 3.1 contract, and rate-limit headers, Windows service command plan with recovery restart actions, installer package scripts/manifest, file-integrity digest verification, start/stop/restart/update scripts, installed-service smoke verifier, install-all orchestrator, diagnostic log collector, service readiness verifier, Windows Forms tray script, C# native tray source/build script, tray startup shortcut scripts, Authenticode signing scripts, dev code-signing certificate helper, NSIS installer template/build script, release manifest/evidence aggregator, service status API, tray state/action API |
| C | Mobile/tablet app | Expo shell, BridgeClient, native SecureStore/Notifications capability contract, QR/manual PairingQrPanel state, Pairing/Command/Approval/TaskStatus/Result/Settings/GrowthReview/PoisonQueue view-models, TaskStatus live polling with latency/error/changed metadata, ResultScreen rollback action, output file preview contract, feedback pending/error submission state, GrowthReviewDecisionPanel confirm/reject flow with confidence explanation, supporting/contradicting evidence summary, conflict acknowledgement, hygiene review explanation/trend, single/batch hygiene decision client path, and decision pending/error/latency state, PoisonQueueActionPanel JS/TSX review/requeue/ignore/drain state with loading/error/empty, refresh delta, visual snapshot, queue soak, and retry/backoff summary, RetryPolicySettingsPanel JS/TSX validation/save state, NativeRuntimeProbe TSX for SecureStore/Notifications UI dump evidence, CommandComposerPanel validation/offline queue state, ApprovalActionPanel with high-risk PC confirmation block state, ResultFeedbackPanel validation/growth-review action state, AES-GCM sealed token store metadata, PIN/session-timeout lock plus background/inactive lifecycle auto-lock for approval, execution confirmation, rollback, poison queue operations, queue drain, and retry policy updates, offline queue with no auto-send, notification permission prompt state, local/Expo delivery adapter, channel routing, foreground/background delivery receipts, retryable notification issue queue, Settings receipt verification, native readiness mobile verification report with poison queue drain/soak, retry policy, notification receipts, and native runtime probe evidence, Android Platform Tools setup/install report, Android Emulator/AVD readiness and start/wait plan, Android Gradle/APK/install verification with timeout evidence, app.json package-aligned ADB probe, product build/install matrix, artifact manifest, task/result/feedback/growth/poison/runtime policy runtime |
| D | PC/mobile bridge | Local-only HTTP bridge with health/openapi/server-profile, IPv4/IPv6/forwarded-host guard, random expiring pairing sessions, QR payloads, re-pair token replacement, deviceToken auth, IP/token/device/action token-bucket rate limiter including poison queue and retry policy operations, request validator, payload sanitizer, bridge tier guard, path/header/body/query contract validation, device list/revoke, heartbeat, requestId replay guard, task/approval/result/feedback/growth APIs, single/batch growth hygiene decision routing, PC agent poison queue review/requeue/ignore APIs, retry policy read/update APIs, JSONL-backed state cache with restart rebuild, hash-chained audit summary/export/rotation, sanitized event relay, SSE heartbeat/replay cursor/ack/status |
| E | Permission/security | JSON policy-as-code manifest/compiler, risk/data classifier for PII/ministry finance/pastoral care/minor data with matched-rule evidence, immutable safety constitution with hash pinning, approval policy, mobile Tier guard, capability token issue/validate/consume/revoke, TTL/scope checks, trust boundary labeling, policy-driven prompt-injection scan with source-boundary and quoted-content non-executable rules, tool-output poisoning gate with durable provenance graph/restart replay and taint lineage, autonomy evaluator, hash-chain audit summary/export/rotation API |
| F | Growth memory | MemoryEvent union schema catalog/validation, source-specific safety flag downgrade, SQLite persistence with migrations/transactions/schema metadata/hygiene decision replay/backup/restore/restore-drill/backup-rotation, duplicate/doNotRemember guard, E-classifier-linked sensitive minimizer with hash-only redaction diff, retention report/apply workflow, retention scheduler/status/run APIs, hygiene trend report, field retention metadata and safe fingerprints, workflow-signature pattern/preference/failure mining with local cosine similarity, semantic cluster merge evidence, pattern trend history, threshold calibration, preference semantic conflict classifier with severity/rationale/resolution options, failure recurrence guardrails, A TaskPlanner planningGuardrail injection, failure trend/report APIs, user guardrail review API, taxonomy fixture coverage, ConfirmedPreference confirm/reject/update/revoke and conflict API, A planning-context preference hints, weighted genome/trend/risk calibration, CloneEvidence/StyleGenome/SkillDistillation advanced-learning API with review-gated SkillDraftRegistry, G LearningVerifier-linked maturity score with trend/alert/threshold calibration APIs and C review card state, memory context query, GrowthReview, hygiene report plus single/batch keep/delete/redact/defer decision API with soft-delete/redaction/defer effects and audit logging, autonomy candidate lifecycle generation/E-policy submission/user review |
| G | Test/simulation | Plan/policy/execution/learning/approval-flow/bridge verifiers, C session PIN/lock readiness, biometric unlock, lifecycle auto-lock, sealed token storage and native approval contract checks, policy-as-code/capability compliance checks, execution evidence profile, B adapter fixture corpus coverage, undo journal and rollback transaction hash-chain/step/skip accounting checks, bridge network/replay/rate-limit security corpus checks, durable request nonce/rate-limit replay checks, authenticated SSE and WebSocket fallback policy checks, F MemoryEvent union-schema/redaction-diff, hygiene decision, hygiene trend, retention scheduler, and sensitive-memory/evidence hygiene checks, g-simulation-scenario-pack-v2 dry-run fixture file with B execution replay and simulation trend, module verifier evidence, coverage and expected-outcome checks, plan/policy/learning fixture matrix with failBelow threshold and triage, g-redteam-fixture-pack-v2 with obfuscation/mutation coverage and 95% threshold, g-tool-leak-fixture-pack-v2 with HTML diff artifact, regression suite with dashboard/trend history and failure triage HTML artifact, operational release gate with 12D score gate checks, approved GoldenTrace/BaselineComparator update plus baseline diff HTML and trend APIs, sanitized JSON/HTML report index/trend/diff/retention dashboard/cleanup APIs, 12D rubric fixture plus score/gate regression APIs with dimensionDetails/strengths/weaknesses, F learning-signal emission |

## Next-action planning

The dashboard and readiness report rank work in this order:

1. `critical` blockers from blocked A-G documents or uncleared approvals
2. `high` security/local-control watch items
3. `medium` build and verification follow-ups

This keeps the next step visible instead of leaving the A-G document map as passive status.

## LLM intent brain (Claude adapter)

The A core can consult a real LLM for intent classification through the policy-gated
semantic adapter chain. It is off by default and never bypasses the E policy gates.

```bash
set JARVIS_LLM_INTENT=1
npm run core:dev -- "요즘 로키드 글래스 신형 나왔는지 궁금하네"
```

- Backend: `claude -p` CLI (`packages/core/src/intent/claude-cli-intent-adapter.js`), so it reuses
  the local Claude Code subscription. No API key is stored in this repo.
- Flow: `LocalSemanticIntentAdapter` parses first; the LLM is consulted only when local
  confidence falls below `JARVIS_LLM_INTENT_MIN_LOCAL_CONFIDENCE` (default 0.72).
- Safety: the model only selects an `actionType`. Risk tier, category, and label come from a
  fixed table inside the adapter, so model output cannot downgrade risk. Confidence is clamped
  to 0.93. CLI failure/timeout/garbage output falls back to the local parser.
- Evidence: `intent.semantic` records `externalService: anthropic-claude-cli`,
  `rawCommandSharedWithModel: true`, model, latency, and a prompt hash.
- Tuning: `JARVIS_LLM_INTENT_MODEL` (default `haiku`), `JARVIS_LLM_INTENT_TIMEOUT_MS`
  (default 45000), `JARVIS_LLM_INTENT_COMMAND` (default `claude`).
- Known limit: the installed `JARVISCoreRuntime` Windows service runs as `LocalSystem`, which has
  no Claude CLI credentials, so the service path silently falls back to the local parser. Run the
  runtime in a user context (or move the service to a user account) to get LLM intent there.

## Local execution safety

Local PC control is deny-by-default:

- Allowed capabilities are planned through an allowlist.
- `capture`, `record`, and `inspect` require user confirmation metadata.
- `inspect` stays in `dry-run` mode.
- Destructive terms such as delete, format, shutdown, or reset are blocked before execution and become B-document readiness blockers.

## Approval lifecycle

Security approvals now carry an expiry timestamp. Expired approvals are marked in the audit log, fail `canExecute`, and must be renewed before sensitive commands can continue. Renewal increments `renewalCount` so the console/report can expose repeated approval loops.

## Run

```bash
npm start
```

Open <http://localhost:4173>.

## Build

```bash
npm run build
```

The static app is copied to `dist/`.

## Test

```bash
npm test
```

## Readiness report

```bash
npm run readiness
npm run readiness -- --command "설정 점검" --elevated
```

The report is printed to the terminal and written to `dist/readiness-report-*.md`.

## A-G smoke run

```bash
npm run ag:smoke -- "엑셀 만들어"
```

This runs pairing, mobile command submission, approval, PC execution, result lookup, feedback, growth review, approval-flow verification, bridge verification, and the core regression suite. It writes `dist/ag-smoke-report.json`.

## Product readiness gate

```bash
npm run ag:product-gate
```

This runs the strict A-G gap audit and writes `dist/ag-product-readiness-gate.json`, `.md`, and `.csv`. Unlike the implementation audit, this gate is intentionally product-facing: it compares the current product-readiness score against 95%, groups remaining work into execution lanes, checks expected evidence artifacts, and emits exact commands for Windows service validation, mobile device validation, browser soak, growth-quality review, security redteam expansion, and G dashboard evidence.

The gate is expected to stay `blocked` until physical Windows service runs, mobile device runs, long soaks, and larger quality/redteam corpora have been collected. That blocked state is useful: it keeps the remaining real-world work visible instead of letting document-shaped code look finished too early.

## Final ledger and CI annotations

```bash
npm run ops:completion-ledger
npm run ops:ci-annotations -- --no-emit
npm run ops:release-attestation
npm run ops:release-verify -- --no-emit
```

The completion ledger consolidates A-G readiness, final release gate, signoff, field validation, and WORM evidence into `dist/product-completion-ledger.*`. The CI annotation reporter reads that ledger plus final gate/signoff reports, writes `dist/ci-verification-annotations.*`, appends a GitHub step summary when `GITHUB_STEP_SUMMARY` is available, and emits PR annotations for blocking or warning evidence.

The release attestation writes `dist/final-release-attestation.json`, `.md`, and `.sha256`. It fixes the final gate, signoff, CI annotation status, WORM bundle hash, and production-signing posture into one release note. It treats the current package as a local/field release when all blocking checks pass, while separately naming the production certificate and managed object-lock storage work required before wider public distribution.

The release verification bundle runs the ledger, CI annotations, and release attestation in one Node process, then writes `dist/final-release-verification-bundle.*`. This is the preferred CI entrypoint because it preserves all final reports and returns one clear final status.

## Verification dashboard dossier

```bash
npm run verification:dashboard
```

This runs the G verification dashboard dossier and writes `dist/verification-dashboard-dossier.json`, `.md`, and `.csv`. It consolidates plan verifier evidence, fixture matrix threshold, prompt-injection redteam, tool-poisoning/leak diff, A-G simulation pack, regression dashboard, operational release gate, report retention, 12D score gate, and golden-trace baseline approval into one release evidence bundle.

## Growth quality corpus

```bash
npm run growth:quality
```

This seeds a curated F-memory quality corpus and writes `dist/growth-quality-corpus-report.json`, `.md`, and `.csv`. It verifies repeated workflow mining, negative evidence, confirmed preference promotion, semantic preference conflicts, failure guardrails, hygiene safety, genome trend snapshots, skill draft review, autonomy candidate lifecycle, and G-linked maturity thresholds.

## Core service smoke

```bash
npm run core:service-runtime
```

This starts the actual service entry used by the A Core Windows service plan: `scripts/core-service-runtime.mjs`. Unlike the lighter `core:api` developer server, this entry composes the full A-G runtime with CoreFacade, PolicySecurityRuntime, PcAgentRuntime, VerificationRuntime, GrowthRuntime, CoreOrchestrationWorker, persistent worker queue/lease stores, admin auth, and CoreWorkerDaemon autostart.

```bash
npm run core:service-smoke -- --output dist/core-service-smoke-report.json
```

This starts the A Core API, admin auth, worker queue, persistent lease/queue stores, and CoreWorkerDaemon in a local user process, then verifies health, OpenAPI, admin diagnostics, service lifecycle planning, task creation, queue enqueue, daemon tick, A-E-B-G-F completion, learning ingest, and durable runtime artifacts. It does not install a Windows service; the final Administrator service install/start/stop smoke remains a product-readiness step.

```bash
npm run core:service-soak -- --output dist/core-service-soak-report.json --task-count 4 --duration-ms 250
```

This runs the same Core API and worker daemon as a local interval loop, enqueues multiple tasks, waits for repeated daemon ticks, verifies watchdog health, confirms every task reaches execution verification and F learning ingest, and writes tick/watchdog/artifact counts to `dist/core-service-soak-report.json`.

```bash
npm run core:service-package -- --output-dir dist/core-service-package
```

This writes a Windows service package for the A Core runtime with `install-service.ps1`, `update-service.ps1`, start/stop/restart/status/uninstall scripts, `verify-package.ps1`, `verify-installed-core-service.ps1`, installed-service smoke/soak scripts, `collect-core-logs.ps1`, `install-all.ps1`, `package-manifest.json`, and `README-install.md`. The package points the Windows service at `scripts/core-service-runtime.mjs`, so the installed process uses the same full A-G runtime entry as the local smoke/soak harness.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/verify-package.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/install-service.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/verify-installed-core-service.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN
powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/run-installed-service-smoke.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN
powershell -NoProfile -ExecutionPolicy Bypass -File dist/core-service-package/run-installed-service-soak.ps1 -AdminToken $env:JARVIS_CORE_ADMIN_TOKEN -TaskCount 4
```

The package generation step is safe and does not install the service by itself. The install/update/start/stop/restart/uninstall/install-all PowerShell scripts require an Administrator shell.

## Mobile verification

```bash
npm run mobile:verify
```

This verifies the Expo mobile project structure, screen/view-model runtime scenario, sealed token status, secure-store native adapter readiness, screen testID/accessibility contract, push token registry, session lifecycle lock, notification permission/delivery fallback log, Android Platform Tools setup status, Android Emulator/AVD readiness, Android release APK/install readiness, app.json package-aligned ADB device smoke probe, and product build/install command matrix. It writes `dist/mobile-verification-report.json`, `dist/mobile-verification-report.md`, `dist/mobile-verification-report.html`, `dist/mobile-product-verification-manifest.json`, `dist/mobile-android-setup-report.*`, `dist/mobile-android-emulator-report.*`, `dist/mobile-android-install-report.*`, and `dist/mobile-device-smoke-report.*`. If no Android device or emulator is connected, the report records that product-readiness gap instead of pretending device validation passed.

```bash
npm run mobile:setup-android
npm run mobile:setup-android -- --install
```

The first command records the current ADB/Android Platform Tools status without changing the machine. The second command downloads Google Android SDK Platform Tools into the local JARVIS tools cache and writes `dist/mobile-android-setup-report.json`, `.md`, and `.html`. Custom SDK locations can use `JARVIS_ADB_PATH`, `JARVIS_ANDROID_TOOLS_HOME`, `ANDROID_HOME`, or `ANDROID_SDK_ROOT`.

```bash
npm run mobile:emulator
npm run mobile:emulator -- --start --wait
```

The first command records Android SDK Emulator, AVD, Java, ADB, and running-device readiness. The second command starts the selected AVD, waits for boot completion, and writes `dist/mobile-android-emulator-report.json`, `.md`, and `.html`. Use `--avd <name>` to select a specific virtual device and `--headless` for no-window startup.

```bash
npm run mobile:android-install
npm run mobile:android-install -- --build --install
npm run mobile:android-install -- --build --install --variant debug
```

The first command records native Android project, Gradle, APK, ADB, and package-install status. The second command builds the default product variant, `release`, installs `app-release.apk` with ADB, and writes `dist/mobile-android-install-report.json`, `.md`, and `.html` plus Gradle log tails. Use `--variant debug` only when you intentionally want a Metro/dev-server build. If Gradle hits Kotlin DSL/project-accessor timeout during first build, the report marks `build-blocked` and points to `dist/mobile-android-gradle-build.*.log`.

```bash
npm run mobile:device
```

This runs the Android device smoke probe directly. It resolves `adb` from `JARVIS_ADB_PATH`, `ADB`, `JARVIS_ANDROID_TOOLS_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, the JARVIS local tools cache, or PATH. When ADB has a ready device and `local.eureka.jarvis` is installed, it launches `MainActivity`, waits for the React Native screen to render, captures a PNG screenshot into `dist/mobile-device/`, dumps `jarvis-window.xml`, and checks the UI dump for the JARVIS mobile screen contract plus SecureStore/Notifications native runtime probe labels. Blocked runs still write `dist/mobile-device-smoke-report.json`, `.md`, and `.html` with next actions.

## Wearable HUD verification

```bash
npm run wearable:verify
npm run wearable:field-kit
```

This verifies the C/D Wearable HUD Adapter for AI smart glasses: wake-word voice intent parsing, redacted transcript previews, high-risk approval blocking, PC confirmation handoff, bridge sync endpoints, green monochrome frame limits, Korean-first HUD labels, browser-safe live client contracts, and safe HTML preview rendering. It writes `dist/wearable-hud-verification-report.json`, `dist/wearable-hud-verification-report.md`, `dist/wearable-hud-preview.html`, and a launchable field kit under `dist/wearable-hud-field-kit/`.

To serve the glasses-facing HUD on the local network:

```bash
node dist/wearable-hud-field-kit/field-server.mjs --host 0.0.0.0 --port 4176
```

Open `http://<this-pc-ip>:4176/` on the glasses browser or mirrored display. The device token remains memory-only in the page.

## A-G implementation audit

```bash
npm run ag:audit
```

This checks that each A-G document stream has concrete code evidence such as runtime files, API routes, guards, screens, scripts, and verification classes. It writes `dist/ag-implementation-audit.json` and `dist/ag-implementation-audit.md`.

## A-G strict gap audit

```bash
npm run ag:gap
```

This is the honest document-gap audit. Unlike `ag:audit`, it does not treat file presence as completion. It scores each A-G requirement as complete, substantial, partial, stub, or missing, then separates implementation depth from product readiness. It writes `dist/ag-strict-gap-audit.json`, `dist/ag-strict-gap-audit.md`, and `dist/ag-strict-gap-audit.csv`.

## Verified

- `npm test`
- `npm run build`
- `npm run readiness`
- `npm run ag:smoke`
- `npm run mobile:verify`
- `npm run wearable:verify`
- `npm run wearable:field-kit`
- `npm run mobile:setup-android`
- `npm run mobile:emulator`
- `npm run mobile:android-install`
- `npm run mobile:device` (passes when the installed release APK exposes JARVIS Mobile, route text, and native runtime probe labels on an ADB device/emulator)
- `npm run ag:audit`
- `npm run ag:gap`
- Browser smoke test at 1280x720, including normal-mode approval hold and elevated-mode approval clear
- Responsive smoke test at 390x844
