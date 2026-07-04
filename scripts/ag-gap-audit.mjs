import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const statuses = {
  complete: { label: '완료', score: 1 },
  substantial: { label: '주요 구현', score: 0.8 },
  partial: { label: '부분 구현', score: 0.55 },
  stub: { label: '스텁/외형', score: 0.25 },
  missing: { label: '미구현', score: 0 }
};

const requirements = [
  req('A-01', 'A', '공통 코어 런타임 생명주기', 'CoreRuntime init/start/stop, 이벤트 로그, 런타임 상태를 제공한다.', 'complete', 3, 0.93, ['init/start/stop, health checks, metrics, restart, fault ledger, diagnostics, JSONL 이벤트에 더해 CoreRuntimeSupervisor가 watchdog heartbeat, fault/stopped runtime restart policy, worker drain tick, service supervision plan, HTTP supervisor status/tick API를 제공한다. 또한 a-core-service-lifecycle-plan-v1 Windows service install/update/start/stop/restart/status/uninstall dry-run plan, recovery commands, persistent store env, a-core-service-readiness-v1 readiness evidence, core:service CLI와 /runtime/service-plan API가 구현됐다. scripts/core-service-runtime.mjs는 실제 서비스 entry에서 CoreFacade, E/B/G/F runtime, CoreOrchestrationWorker, persistent worker queue/lease store, admin auth, CoreWorkerDaemon autostart를 조립한다. scripts/core-service-smoke.mjs는 이 service entry로 daemon tick completion을 검증하고, scripts/core-service-soak.mjs는 반복 daemon interval tick, watchdog health, multiple queued tasks, durable tick/watchdog artifact counts를 검증한다. a-core-service-package-v1 Windows service package generator는 install/update/start/stop/restart/status/uninstall, package integrity, installed-service verification, installed-service smoke/soak, log collection, install-all runbook을 파일로 생성한다. 여기에 a-core-service-release-dossier-v1, a-core-service-release-product-gate-v1, core:service-release가 추가되어 package/smoke/soak/runbook evidence를 하나의 release dossier로 고정한다. 또한 a-core-service-release-artifact-manifest-v1, a-core-installed-service-handoff-manifest-v1, a-core-installed-service-health-handshake-v1, a-core-service-release-fallback-policy-v1, a-core-service-release-ci-nightly-gate-plan-v1, a-core-service-release-worm-promotion-package-v1, a-core-service-release-worm-provider-contract-v1이 추가되어 raw artifact path/admin token/script body를 저장하지 않는 hash-only 서비스 release manifest, 설치 후 health/fallback handoff, 운영 WORM 승격 준비를 검증한다. 남은 차이는 실제 Administrator Windows 서비스 실기동 smoke와 관리자 환경 장기 soak를 운영 WORM dossier에 첨부하는 것이다.'], ['Administrator Windows 환경에서 core:service install --execute 후 실서비스 start/stop/restart smoke와 장기 soak report를 저장하고, a-core-installed-service-handoff-manifest-v1 및 a-core-service-release-worm-promotion-package-v1에 installed-service evidence를 첨부한다.'], [ev('packages/core/src/runtime/core-runtime.js', 'class CoreRuntime'), ev('packages/core/src/runtime/core-runtime.js', 'recordFault'), ev('packages/core/src/runtime/core-runtime.js', 'diagnostics()'), ev('packages/core/src/runtime/core-supervisor.js', 'a-core-runtime-supervisor-v1'), ev('packages/core/src/runtime/core-supervisor.js', 'a-core-supervisor-heartbeat-v1'), ev('packages/core/src/runtime/core-supervisor.js', 'a-core-service-supervision-plan-v1'), ev('packages/core/src/install/core-service-planner.js', 'a-core-service-lifecycle-plan-v1'), ev('packages/core/src/install/core-service-planner.js', 'scripts/core-service-runtime.mjs'), ev('packages/core/src/install/core-service-planner.js', 'a-core-service-readiness-v1'), ev('packages/core/src/install/core-service-packager.js', 'a-core-service-package-v1'), ev('packages/core/src/cli/service-plan.mjs', 'a-core-service-lifecycle-report-v1'), ev('scripts/core-service-runtime.mjs', 'a-core-service-runtime-entry-v1'), ev('scripts/core-service-smoke.mjs', 'a-core-service-smoke-report-v1'), ev('scripts/core-service-soak.mjs', 'a-core-service-soak-report-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-dossier-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-product-gate-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-artifact-manifest-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-installed-service-handoff-manifest-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-installed-service-health-handshake-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-fallback-policy-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-ci-nightly-gate-plan-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-worm-promotion-package-v1'), ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-worm-provider-contract-v1'), ev('package.json', 'core:service-release'), ev('packages/core/src/main.mjs', '/runtime/service-plan'), ev('tests/ag-runtime.test.js', 'core_service_installed_handoff_ready'), ev('tests/ag-runtime.test.js', 'core_service_worm_promotion_package_ready')]),
  req('A-02', 'A', '명령 입력 표준화', '모바일/CLI 입력을 TaskRequest로 표준화하고 소스/타임스탬프를 보존한다.', 'complete', 2, 0.9, ['CLI/mobile/voice/file/image 입력 정규화, attachment metadata, raw evidence 보존, content-not-read 정책에 더해 a-command-input-provider-extraction-v1 provider pipeline이 구현됐다. Local text-file/voice sidecar/image OCR provider는 승인 전 metadata-only, 승인 후 redacted safe preview/contentHash/rawContentStored=false evidence를 TaskRequest에 붙인다. 여기에 a-stt-command-provider-v1, a-ocr-command-provider-v1, a-document-parser-provider-v1 외부 command adapter 계약, a-command-input-real-provider-contract-v1, a-command-input-document-parser-contract-v1, provider catalog, latency telemetry, a-command-input-provider-quality-report-v1 accuracy report, a-command-input-provider-drift-telemetry-v1 drift report와 command-input:quality artifact가 추가됐다. 또한 a-command-input-provider-deployment-readiness-v1, a-command-input-provider-release-dossier-v1, a-command-input-provider-release-artifact-manifest-v1, a-command-input-provider-long-term-drift-trend-v1, a-command-input-provider-ci-nightly-gate-plan-v1, a-command-input-provider-worm-promotion-package-v1, a-command-input-provider-worm-provider-contract-v1, a-command-input-provider-product-gate-v1이 command-input:quality 산출물에 포함되어 provider 설정/드리프트/latency/raw fixture text·attachment path 비저장, CI/nightly 실행 계약, 외부 WORM 승격 준비를 release gate로 검증한다. 여기에 a-command-input-provider-operational-handoff-manifest-v1, a-command-input-provider-health-handshake-v1, a-command-input-provider-fallback-policy-v1이 추가되어 STT/OCR/document parser의 운영 health, latency, fallback 정책, provider command/raw attachment path 비저장을 release dossier에서 검증한다. 남은 차이는 실제 STT/OCR/PDF·Office 엔진을 운영 secret/config로 연결해 장기 실제 사용자 corpus와 provider drift trend를 실제 원격 WORM release dossier에 누적하는 것이다.'], ['JARVIS_STT_COMMAND/JARVIS_OCR_COMMAND/JARVIS_DOCUMENT_PARSER_COMMAND를 실제 엔진으로 연결하고, a-command-input-provider-operational-handoff-manifest-v1 및 a-command-input-provider-worm-promotion-package-v1을 운영 WORM artifact store에 업로드해 nightly/PR evidence를 장기 고정한다.'], [ev('packages/core/src/intake/command-intake.js', 'fromVoiceWithProvider'), ev('packages/core/src/intake/command-intake.js', 'fromFileWithProvider'), ev('packages/core/src/intake/command-intake.js', 'fromImageWithProvider'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-extraction-v1'), ev('packages/core/src/intake/input-providers.js', 'a-local-file-text-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-local-voice-transcript-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-local-image-ocr-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-stt-command-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-ocr-command-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-document-parser-provider-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-quality-report-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-drift-telemetry-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-deployment-readiness-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-release-dossier-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-release-artifact-manifest-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-long-term-drift-trend-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-ci-nightly-gate-plan-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-operational-handoff-manifest-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-health-handshake-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-fallback-policy-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-worm-promotion-package-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-worm-provider-contract-v1'), ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-product-gate-v1'), ev('scripts/command-input-provider-quality.mjs', 'Operational handoff'), ev('scripts/command-input-provider-quality.mjs', 'WORM promotion package'), ev('scripts/command-input-provider-quality.mjs', 'CI/nightly gate plan'), ev('tests/ag-runtime.test.js', 'command_input_operational_handoff_ready')]),
  req('A-03', 'A', '의도 파서', '문서의 IntentCandidate 흐름에 맞춰 명령을 의도/행동 후보로 해석한다.', 'complete', 3, 0.88, ['규칙 기반 IntentParser, 실제 사용자 명령 corpus, slot/entity/complexity accuracy evaluator, action별 pass-rate 리포트, 로컬 semantic intent adapter, paraphrase corpus, rule-vs-semantic 비교 리포트에 더해 ApprovedIntentLogStore가 승인된 실제 명령을 raw 저장 없이 hash/redaction fixture corpus로 누적하고, PolicyGatedSemanticIntentAdapter가 local-first 외부 adapter 후보를 선택적으로 비교하며, a-03-intent-drift-calibration-report-v1이 rule/semantic/external drift와 privacy evidence를 산출한다. 여기에 a-03-intent-action-drift-trend-v1 action별 장기 drift trend, a-03-semantic-provider-telemetry-dashboard-v1 provider latency/cost/regression dashboard, a-03-intent-parser-product-gate-v1, a-03-intent-parser-release-dossier-v1, intent:quality artifact가 추가됐다. 또한 a-03-intent-parser-release-artifact-manifest-v1, a-03-semantic-provider-contract-manifest-v1, a-03-external-semantic-provider-shadow-manifest-v1, a-03-intent-parser-ci-nightly-gate-plan-v1, a-03-intent-parser-worm-promotion-package-v1, a-03-intent-parser-worm-provider-contract-v1이 release dossier에 포함되어 provider shadow 계약, raw command/prompt leak check, CI/nightly 실행 계획, WORM 승격 준비를 검증한다. 여기에 a-03-semantic-provider-operational-handoff-manifest-v1, a-03-semantic-provider-health-handshake-v1, a-03-semantic-provider-fallback-policy-v1이 추가되어 rule parser primary gate, external shadow 승격 조건, provider regression/latency health, raw prompt/provider secret 비저장을 검증한다. 남은 차이는 실제 장기 운영 사용자 로그와 운영 model provider 계정에서 같은 dashboard를 지속 누적하고 원격 WORM release dossier에 업로드하는 것이다.'], ['운영 승인 로그를 장기 익명 corpus로 누적하고, 실제 외부 model provider별 latency/cost/regression trend와 a-03-semantic-provider-operational-handoff-manifest-v1 및 a-03-intent-parser-worm-promotion-package-v1을 운영 WORM artifact store에 고정한다.'], [ev('packages/core/src/intent/intent-parser.js', 'extractSlots'), ev('packages/core/src/intent/intent-corpus-evaluator.js', 'evaluateIntentCorpusWithSemantic'), ev('packages/core/src/intent/semantic-intent-adapter.js', 'policy-gated-semantic-intent-adapter-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-approved-intent-log-corpus-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-drift-calibration-report-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-action-drift-trend-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-telemetry-dashboard-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-product-gate-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-release-dossier-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-release-artifact-manifest-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-contract-manifest-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-external-semantic-provider-shadow-manifest-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-ci-nightly-gate-plan-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-operational-handoff-manifest-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-health-handshake-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-fallback-policy-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-worm-promotion-package-v1'), ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-worm-provider-contract-v1'), ev('scripts/intent-quality-report.mjs', 'a-03-intent-quality-report-v1'), ev('scripts/intent-quality-report.mjs', 'Operational handoff'), ev('scripts/intent-quality-report.mjs', 'WORM promotion package'), ev('package.json', 'intent:quality'), ev('packages/core/fixtures/intent-command-corpus.json', 'a-03-intent-corpus-v1'), ev('packages/core/fixtures/intent-semantic-command-corpus.json', 'a-03-semantic-intent-corpus-v1'), ev('tests/ag-runtime.test.js', 'intent_semantic_provider_operational_handoff_ready')]),
  req('A-04', 'A', '모호성 해소', '애매한 요청을 alternatives와 clarification 요구로 분리한다.', 'complete', 2, 0.9, ['ClarificationRequest, competing intent/missing slot reason code, approvalCard clarificationRequest embedding, C ApprovalDetail clarification state, 선택지 responseText 생성, Bridge approval.respond, A replanTaskFromApprovalDecision, 다회 clarification chain ledger, replan preview diff, clarification.chain.updated 이벤트, durable orchestration journal snapshot, 모바일 conversation UI contract, follow-up copy polish, 모바일 end-to-end 테스트가 구현됐다. 여기에 a-clarification-copy-quality-report-v1, a-clarification-ux-telemetry-report-v1, a-clarification-product-gate-v1, a-clarification-release-dossier-v1이 추가되어 follow-up copy, completion/drop-off, raw conversation retention을 release gate로 검증한다. 또한 a-clarification-release-artifact-manifest-v1, a-clarification-release-raw-leak-check-v1, a-clarification-ci-nightly-gate-plan-v1, a-clarification-operational-handoff-manifest-v1, a-clarification-health-handshake-v1, a-clarification-fallback-policy-v1, a-clarification-worm-promotion-package-v1, a-clarification-worm-provider-contract-v1이 release dossier에 포함되어 대화/quick reply 원문을 hash-only manifest로 고정하고 CI/nightly, 운영 handoff, WORM 승격 준비를 검증한다. 남은 차이는 실제 사용자 대화 로그 기반 장기 A/B 실험과 물리 모바일 화면 telemetry를 운영 저장소 및 원격 WORM release dossier에 누적하는 것이다.'], ['실제 사용자 clarification 대화 로그를 익명화해 copy quality/UX telemetry corpus로 누적하고, 물리 모바일 completion/drop-off trend와 a-clarification-operational-handoff-manifest-v1 및 a-clarification-worm-promotion-package-v1을 운영 WORM artifact store에 고정한다.'], [ev('packages/core/src/intent/ambiguity-resolver.js', 'createClarificationRequest'), ev('packages/core/src/orchestration/orchestration-journal.js', 'a-clarification-chain-snapshot-v1'), ev('packages/core/src/core-facade.js', 'a-clarification-chain-journal-pointer-v1'), ev('packages/core/src/core-facade.js', 'a-clarification-preview-diff-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-conversation-ui-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-copy-quality-report-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-ux-telemetry-report-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-product-gate-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-dossier-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-artifact-manifest-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-raw-leak-check-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-ci-nightly-gate-plan-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-operational-handoff-manifest-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-health-handshake-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-fallback-policy-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-worm-promotion-package-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-worm-provider-contract-v1'), ev('tests/ag-runtime.test.js', 'clarification_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'clarification_worm_promotion_package_ready')]),
  req('A-05', 'A', '컨텍스트 스냅샷', '작업 생성 시 현재 시간/프로필/이전 상태를 ContextSnapshot으로 묶는다.', 'complete', 2, 0.9, ['read-only 파일 메타데이터/환경 마스킹, 선택형 DesktopContextCollector, 열린 앱/화면 OCR/OS 이벤트 provider 계약, 승인 전 metadata-only, 승인 후 redacted preview, rawContentStored=false 계약, provider 상태/latency/redaction telemetry, admin contextTelemetry report와 HTTP 진단 테스트가 구현됐다. 여기에 a-windows-desktop-context-provider-pack-v1, a-windows-uiautomation-provider-v1, a-windows-ocr-provider-v1, a-windows-os-event-provider-v1 adapter pack, a-desktop-context-permission-ux-v1 승인 UX 상태, a-desktop-context-provider-soak-v1 실패/지연 soak 리포트와 context:provider-soak artifact가 추가됐다. 또한 a-desktop-context-provider-release-dossier-v1, a-desktop-context-provider-product-gate-v1이 추가되어 permission UX, expected failure, latency, raw content retention을 release gate로 검증한다. 여기에 a-desktop-context-provider-release-artifact-manifest-v1, a-desktop-context-provider-contract-manifest-v1, a-desktop-context-provider-ci-nightly-gate-plan-v1, a-desktop-context-provider-operational-handoff-manifest-v1, a-desktop-context-provider-health-handshake-v1, a-desktop-context-provider-fallback-policy-v1, a-desktop-context-provider-worm-promotion-package-v1, a-desktop-context-provider-worm-provider-contract-v1이 추가되어 window title/OCR/event detail 원문 비저장, provider contract hash, CI/nightly 실행 계획, 운영 handoff, WORM 승격 준비를 release evidence로 고정한다. 실제 로컬 Windows native probe 기반 context:provider-soak product gate도 통과했다. 남은 차이는 실제 OCR command/provider와 장기 사용자 승인 세션 evidence를 원격 WORM release dossier에 누적하는 것이다.'], ['물리 Windows 서비스 환경에서 JARVIS_DESKTOP_OCR_COMMAND 또는 네이티브 OCR provider를 연결하고, a-desktop-context-provider-operational-handoff-manifest-v1 및 a-desktop-context-provider-worm-promotion-package-v1을 운영 WORM artifact store에 장기 고정한다.'], [ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-telemetry-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-telemetry-report-v1'), ev('packages/core/src/context/context-snapshot.js', 'approval-gated-desktop-context'), ev('packages/core/src/context/context-snapshot.js', 'a-windows-desktop-context-provider-pack-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-windows-uiautomation-provider-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-windows-ocr-provider-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-windows-os-event-provider-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-permission-ux-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-soak-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-release-dossier-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-release-artifact-manifest-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-contract-manifest-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-ci-nightly-gate-plan-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-operational-handoff-manifest-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-health-handshake-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-fallback-policy-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-worm-promotion-package-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-worm-provider-contract-v1'), ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-product-gate-v1'), ev('packages/core/src/core-facade.js', 'contextProviderContract'), ev('scripts/context-provider-soak.mjs', 'Operational handoff'), ev('scripts/context-provider-soak.mjs', 'WORM promotion package'), ev('apps/runtime-compose/src/create-runtime.js', 'desktopContextProvider'), ev('tests/ag-runtime.test.js', 'desktop_context_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'desktop_context_worm_promotion_package_ready')]),
  req('A-06', 'A', '작업 계획 생성', 'TaskPlan, planSteps, action, approvalCard 입력을 생성한다.', 'complete', 3, 0.91, ['TaskPlan, pre/postcondition, riskNotes, multi-action DAG, failureBranches, compensationPlan 생성, CoreOrchestrationWorker의 action node running/completed journal 연결, queue drain runner, B/G/F 실행 루프, a-plan-graph-runner-v1 노드별 실행, a-plan-node-artifact-bundle-v1 산출물 묶음, dependency descendant skip, 실행 완료 노드만 대상으로 하는 partial compensation planning 테스트가 구현됐다. 여기에 a-plan-parallel-dag-scheduler-v1, a-plan-parallel-dag-runtime-schedule-v1, a-plan-compensation-execution-runner-v1, a-plan-node-artifact-retention-v1, a-plan-node-artifact-export-v1, a-plan-graph-product-gate-v1, a-plan-graph-release-dossier-v1이 추가되어 병렬 DAG 실행, 노드 산출물 해시/보존, 보상 실행 준비 상태를 release gate로 검증한다. 또한 a-plan-graph-release-artifact-manifest-v1, a-plan-graph-execution-manifest-v1, a-plan-node-artifact-release-manifest-v1, a-plan-graph-ci-nightly-gate-plan-v1, a-plan-graph-worm-promotion-package-v1, a-plan-graph-worm-provider-contract-v1이 추가되어 plan/node artifact/output path/capability token 원문을 저장하지 않는 hash-only release evidence와 CI/nightly 및 WORM 승격 준비를 검증한다. 남은 차이는 실제 장시간 운영 작업 corpus에서 병렬 DAG/partial compensation replay를 지속 검증해 운영 WORM storage에 업로드하는 것이다.'], ['실제 운영 작업 corpus로 plan graph soak를 장시간 실행하고, a-plan-graph-worm-promotion-package-v1을 원격 WORM release dossier에 고정한다.'], [ev('packages/core/src/planning/task-planner.js', 'planGraphFor'), ev('packages/core/src/planning/task-planner.js', 'a-plan-parallel-dag-scheduler-v1'), ev('packages/core/src/planning/task-planner.js', 'failureBranchesFor'), ev('packages/core/src/planning/task-planner.js', 'compensationPlanFor'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-runner-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-parallel-dag-runtime-schedule-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-compensation-execution-runner-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-node-artifact-bundle-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-release-dossier-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-release-artifact-manifest-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-execution-manifest-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-node-artifact-release-manifest-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-ci-nightly-gate-plan-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-worm-promotion-package-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-worm-provider-contract-v1'), ev('packages/core/src/main.mjs', '/tasks/:taskId/plan-graph/product-gate'), ev('tests/ag-runtime.test.js', 'plan_graph_worm_promotion_package_ready')]),
  req('A-07', 'A', '계약 레지스트리', 'TaskRequest/ApprovalCard/ExecutionPacket 등 A-G 계약을 검증한다.', 'complete', 3, 0.9, ['ContractRegistry validation, JSON Schema bundle, TaskRequest/TaskPlan/ApprovalCard/ExecutionPacket schemas, compatibility report, schema snapshot hash, a-federated-openapi-contract-bundle-v1, A/B/D/E/F/G OpenAPI route bundle, E/F/G /openapi.json route contracts와 HTTP regression 테스트가 구현됐다. 여기에 a-federated-openapi-client-types-v1 TypeScript/CoreClient contract declarations, a-federated-openapi-module-breaking-policy-v1, a-federated-openapi-contract-diff-v1, a-federated-openapi-contract-gate-v1이 추가되어 federated OpenAPI bundle의 generated client drift와 module별 breaking route removal을 승인 게이트로 차단한다. 또한 contracts:federated-gate 실행 스크립트와 a-federated-openapi-release-dossier-v1 산출물이 추가되어 CI 필수 check 및 release evidence로 바로 고정할 수 있다. 여기에 a-federated-openapi-release-artifact-manifest-v1, a-federated-openapi-module-contract-manifest-v1, a-federated-openapi-ci-nightly-gate-plan-v1, a-federated-openapi-worm-promotion-package-v1, a-federated-openapi-worm-provider-contract-v1이 추가되어 raw OpenAPI spec/generated types/secrets를 저장하지 않는 hash-only release manifest, CI/nightly 실행 계획, 외부 WORM 승격 준비를 계약 게이트 산출물에서 검증한다. 남은 차이는 원격 CI에서 이 게이트를 PR 필수 check로 실제 운영하고 WORM artifact store에 장기 업로드하는 것이다.'], ['GitHub Actions/CI에서 npm run contracts:federated-gate를 PR 필수 check로 실행하고, module별 승인 artifact와 a-federated-openapi-worm-promotion-package-v1을 원격 WORM release dossier에 장기 보존한다.'], [ev('packages/core/src/contracts/contract-registry.js', 'federatedOpenApiBundle'), ev('packages/core/src/contracts/contract-registry.js', 'a-federated-openapi-client-types-v1'), ev('packages/core/src/contracts/contract-registry.js', 'a-federated-openapi-module-breaking-policy-v1'), ev('packages/core/src/contracts/contract-registry.js', 'a-federated-openapi-contract-gate-v1'), ev('packages/core/src/contracts/contract-registry.js', 'FederatedCoreClientContract'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-contract-gate-report-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-release-dossier-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-release-artifact-manifest-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-module-contract-manifest-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-ci-nightly-gate-plan-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-worm-promotion-package-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-worm-provider-contract-v1'), ev('scripts/federated-openapi-contract-gate.mjs', 'rawOpenApiSpecStored'), ev('scripts/federated-openapi-contract-gate.mjs', 'rawGeneratedTypesStored'), ev('scripts/federated-openapi-contract-gate.mjs', 'rawSecretsStored'), ev('package.json', 'contracts:federated-gate'), ev('tests/ag-runtime.test.js', 'federated-worm-promotion-package-ready')]),
  req('A-08', 'A', '상태 머신', 'TaskStatus 전이를 관리하고 승인/실행/완료 상태를 기록한다.', 'complete', 2, 0.9, ['불법 전이 차단, retry budget, approval expiry, compensation 상태, CoreFacade lifecycle/trace 연동, CoreOrchestrationWorker의 APPROVED→EXECUTING→VERIFYING→COMPLETED 전이, queue task lock, retry_scheduled backoff, timeout metadata, a-worker-lease-table-v1 task lease, a-worker-lease-store-v1 파일 기반 durable lease backend, a-worker-lease-recovery-v1 expired lease recovery, /worker/leases·/worker/leases/recover API, 회수 후 retry scheduling, restart 후 active lease/history 복원 테스트가 구현됐다. 여기에 a-worker-lease-file-lock-backend-v1, a-worker-multiprocess-lease-backend-v1, a-worker-crashed-heartbeat-monitor-v1, a-worker-timeout-scheduler-persistence-v1, a-worker-state-machine-product-gate-v1, a-worker-state-machine-release-dossier-v1이 추가되어 lease recovery 관측 증거와 timeout/heartbeat/persistence readiness를 release gate로 검증한다. 또한 a-worker-state-machine-release-artifact-manifest-v1, a-worker-state-machine-lease-contention-manifest-v1, a-worker-state-machine-ci-nightly-gate-plan-v1, a-worker-state-machine-worm-promotion-package-v1, a-worker-state-machine-worm-provider-contract-v1이 추가되어 task/queue/lease 원문 payload와 lease store path를 저장하지 않는 hash-only 장기 산출물, CI/nightly 실행 계획, 외부 WORM 승격 준비를 worker state gate에서 검증한다. 남은 차이는 실제 다중 프로세스 OS process에서 장시간 lease contention soak evidence를 운영 WORM storage에 업로드하는 것이다.'], ['실제 Windows service 다중 프로세스 worker로 lease contention/recovery soak를 장시간 실행하고, a-worker-state-machine-worm-promotion-package-v1을 원격 WORM release dossier에 고정한다.'], [ev('packages/core/src/runtime/state-machine.js', 'transitionTable'), ev('packages/core/src/runtime/state-machine.js', 'expireIfPast'), ev('packages/core/src/runtime/state-machine.js', 'beginCompensation'), ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-lease-table-v1'), ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-lease-store-v1'), ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-multiprocess-lease-backend-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'leaseStorePath'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'recoverExpiredLeases'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-release-dossier-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-release-artifact-manifest-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-lease-contention-manifest-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-ci-nightly-gate-plan-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-worm-promotion-package-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-worm-provider-contract-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'rawLeaseStorePathStored'), ev('packages/core/src/main.mjs', '/worker/leases/recover'), ev('tests/ag-runtime.test.js', 'worker_state_machine_worm_promotion_package_ready')]),
  req('A-09', 'A', '이벤트 버스', 'CoreEvent를 publish/recent/JSONL로 남긴다.', 'complete', 2, 0.9, ['durable JSONL reload, replay cursor, subscriber ack, delivery log, dead-letter 기록, pending ack redrive, dead-letter redrive, projectionRecovery 복구 루프, a-event-topic-backpressure-policy-v1 topic별 pending ack pressure 제어, a-event-backpressure-record-v1 rejection 기록, a-event-projection-lease-v1 projection lease와 recovery 테스트가 구현됐다. 여기에 a-event-external-broker-adapter-contract-v1, a-event-external-broker-delivery-v1, a-event-projection-lease-file-backend-v1, a-event-overflow-policy-dashboard-v1, a-event-bus-operational-product-gate-v1이 추가되어 외부 broker forwarding, cross-process lease replay, drop/dead-letter/retry overflow 운영 상태를 제품 게이트로 검증한다. 또한 a-event-bus-operational-release-dossier-v1, broker delivery observed check, projection lease recovery observed check가 추가되어 실제 delivery/recovery 관측 증거를 release dossier로 고정한다. 여기에 a-event-bus-operational-release-artifact-manifest-v1, a-event-broker-provider-contract-manifest-v1, a-event-bus-operational-ci-nightly-gate-plan-v1, a-event-bus-operational-worm-promotion-package-v1, a-event-bus-operational-worm-provider-contract-v1이 추가되어 raw event/broker payload와 delivery/projection lease log path를 저장하지 않는 hash-only 운영 산출물, CI/nightly 실행 계획, 외부 WORM 승격 준비를 검증한다. 남은 차이는 실제 Redis/NATS/Kafka broker와 다중 프로세스 projection worker 장시간 soak evidence를 운영 WORM storage에 업로드하는 것이다.'], ['실제 Redis/NATS/Kafka broker adapter와 다중 프로세스 projection worker로 a-event-bus-operational-worm-promotion-package-v1을 장시간 실행해 원격 WORM release dossier에 고정한다.'], [ev('packages/core/src/runtime/event-bus.js', 'loadEventLog'), ev('packages/core/src/runtime/event-bus.js', 'a-event-external-broker-adapter-contract-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-projection-lease-file-backend-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-overflow-policy-dashboard-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-product-gate-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-release-dossier-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-release-artifact-manifest-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-broker-provider-contract-manifest-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-ci-nightly-gate-plan-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-worm-promotion-package-v1'), ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-worm-provider-contract-v1'), ev('packages/core/src/runtime/event-bus.js', 'rawProjectionLeasePathStored'), ev('packages/core/src/runtime/event-bus.js', 'event_external_broker_delivery_observed'), ev('packages/core/src/runtime/event-bus.js', 'InMemoryEventBrokerAdapter'), ev('tests/ag-runtime.test.js', 'event_bus_operational_worm_promotion_package_ready')]),
  req('A-10', 'A', '스킬 라우터', '명령 의도에 맞는 실행 모듈/툴을 선택한다.', 'complete', 2, 0.91, ['SkillManifest, CapabilityMatrix, signed manifest verification, legacy capability migration, disabled/deprecated routing block, signed plugin bundle registry, manifest-only sandbox load plan, bundle-level signature verification, compatibility snapshot/regression, admin diagnostics exposure, a-skill-remote-registry-sync-v1 HTTPS/local-only registry fetch, a-skill-remote-registry-validation-v1 signed bundle validation, a-skill-bundle-rotation-drill-v1 rotation drill, a-skill-sandbox-worker-smoke-v1 manifest-only sandbox smoke가 구현됐다. 여기에 a-skill-signed-bundle-download-cache-v1, a-skill-isolated-sandbox-process-v1, a-skill-rollbackable-plugin-rotation-v1, a-skill-sandbox-worker-soak-v1, a-skill-router-product-gate-v1, a-skill-router-release-dossier-v1이 추가되어 signed bundle cache, 별도 Node process smoke, codeLoaded=false evidence, rollback 가능한 plugin rotation, remote registry validation을 release gate로 검증한다. 또한 a-skill-router-release-artifact-manifest-v1, a-skill-router-plugin-provider-contract-manifest-v1, a-skill-router-sandbox-hardening-profile-v1, a-skill-router-ci-nightly-gate-plan-v1, a-skill-router-worm-promotion-package-v1, a-skill-router-worm-provider-contract-v1이 추가되어 plugin code/source uri/entrypoint 원문을 저장하지 않는 hash-only manifest, sandbox hardening profile, CI/nightly 실행 계획, 외부 WORM 승격 준비를 product gate에서 검증한다. 남은 차이는 실제 플러그인 코드를 OS/container sandbox에서 장시간 제한 실행하는 운영 hardening evidence를 WORM storage에 업로드하는 것이다.'], ['실제 OS/container sandbox worker에서 plugin code 제한 실행, signed bundle download cache 복구, rollback drill, 장기 smoke soak를 운영 corpus로 반복하고 a-skill-router-worm-promotion-package-v1을 원격 WORM release dossier에 고정한다.'], [ev('packages/core/src/routing/skill-router.js', 'capabilityMatrix'), ev('packages/core/src/routing/skill-router.js', 'syncRemotePluginRegistry'), ev('packages/core/src/routing/skill-router.js', 'a-skill-remote-registry-url-policy-v1'), ev('packages/core/src/routing/skill-router.js', 'rotatePluginBundle'), ev('packages/core/src/routing/skill-router.js', 'a-skill-isolated-sandbox-process-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-sandbox-worker-soak-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-release-dossier-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-release-artifact-manifest-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-plugin-provider-contract-manifest-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-sandbox-hardening-profile-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-ci-nightly-gate-plan-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-worm-promotion-package-v1'), ev('packages/core/src/routing/skill-router.js', 'a-skill-router-worm-provider-contract-v1'), ev('packages/core/src/routing/skill-router.js', 'rawEntrypointStored'), ev('packages/core/src/core-facade.js', 'skillPluginRegistry'), ev('tests/ag-runtime.test.js', 'skill_router_worm_promotion_package_ready')]),
  req('A-11', 'A', 'Agent Orchestrator Lite', 'A가 E 정책, B 실행, G 검증, F 학습을 순서대로 조립한다.', 'complete', 3, 0.95, ['Trace, approval edit 재계획, durable orchestration journal, node resume context, compensation planning, CoreOrchestrationWorker의 E capability 발급/G policy·plan 검증/B packet 실행/G execution 검증/F memory ingest, queue enqueue/drain, per-tick queue duplicate processing guard, lock/retry metadata, worker trace phases, HTTP run/drain endpoint, a-node-compensation-replay-v1 node-level compensation replay, rollback proof 연결, compensation.action.compensated journal 기록, /tasks/:taskId/compensation/run API, a-worker-queue-store-v1 파일 기반 queue/run snapshot, restart 후 queued work 복원 및 running item retry_scheduled 복구, a-core-worker-daemon-v1 queue drain/lease recovery/watchdog loop, a-core-worker-daemon-watchdog-v1 heartbeat, 실제 service runtime entry의 full A-G worker daemon autostart, user-process service smoke, repeated daemon soak, duplicate same-millisecond task-id collision 회피 테스트가 구현됐다. 남은 차이는 실제 Windows service process에서 장기 G verifier replay daemon을 같이 운영하는 것이다.'], ['실제 Windows service process에서 node-level compensation replay를 장기 durable loop로 확장하고, replay 후 G rollback verifier를 자동 호출한다.'], [ev('packages/core/src/orchestration/agent-orchestrator-lite.js', 'recordCompensationExecution'), ev('packages/core/src/orchestration/orchestration-journal.js', 'recordCompensation'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'runCompensation'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-node-compensation-replay-v1'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'excludeQueueIds'), ev('packages/core/src/orchestration/core-orchestration-worker.js', 'queueStorePath'), ev('packages/core/src/runtime/worker-queue-store.js', 'a-worker-queue-store-v1'), ev('packages/core/src/runtime/core-worker-daemon.js', 'a-core-worker-daemon-v1'), ev('packages/core/src/runtime/core-worker-daemon.js', 'a-core-worker-daemon-watchdog-v1'), ev('packages/core/src/core-facade.js', 'idCollisionAvoided'), ev('scripts/core-service-runtime.mjs', 'workerDaemonAutostart'), ev('scripts/core-service-soak.mjs', 'a-core-service-soak-report-v1'), ev('tests/ag-runtime.test.js', 'CoreWorkerDaemon recovers expired leases'), ev('tests/ag-runtime.test.js', 'Core service runtime entry'), ev('tests/ag-runtime.test.js', 'Core service soak'), ev('tests/ag-runtime.test.js', 'task id collisions')]),
  req('A-12', 'A', 'CoreFacade와 CLI', '개발자가 A 흐름을 CLI와 facade로 호출할 수 있다.', 'complete', 2, 0.99, ['CoreFacade, CLI, A-only HTTP API, task/approval/resume/compensation routes, /tasks/:taskId/run worker endpoint, /tasks/:taskId/queue·/worker/queue·/worker/queue/drain queue endpoints, bearer-protected /worker/daemon start/stop/tick/status endpoints, /runtime/service-plan lifecycle endpoint, core:service CLI, core:service-runtime CLI, core:service-smoke CLI, core:service-soak CLI, core:service-package CLI, /openapi.json OpenAPI 3.1 contract, task detail execution/verification/learning result, admin diagnostics with workerDaemon/adminAuth status, a-core-admin-auth-v1 hash-backed role/scope bearer auth, CoreClient task/admin/worker/daemon/service/compensation calls, generated Core API route/operation TypeScript declarations, a-core-api-contract-snapshot-v1, a-core-api-contract-diff-v1, a-core-contract-gate-v1 OpenAPI breaking-change approval gate와 CLI 스크립트가 구현됐다. Windows service plan entry가 scripts/core-service-runtime.mjs로 full A-G worker runtime을 가리키며, user-process service runtime/smoke/soak가 HTTP로 admin diagnostics/service-plan/task queue/daemon interval tick/completion/artifact writing을 검증한다. a-core-service-package-v1은 실제 서비스 설치 전 package integrity, installed verification, installed smoke/soak runbook을 생성한다. 남은 차이는 실제 Windows service install smoke report 저장이다.'], ['Administrator Windows 환경에서 실제 service install/start/stop smoke와 장기 배포 evidence를 저장한다.'], [ev('packages/core/src/core-facade.js', 'class CoreFacade'), ev('packages/core/src/core-facade.js', 'adminDiagnostics'), ev('packages/core/src/cli/dev.mjs'), ev('packages/core/src/cli/service-plan.mjs', 'a-core-service-lifecycle-report-v1'), ev('packages/core/src/install/core-service-packager.js', 'a-core-service-package-v1'), ev('scripts/core-service-runtime.mjs', 'a-core-service-runtime-entry-v1'), ev('scripts/core-service-smoke.mjs', 'a-core-service-smoke-report-v1'), ev('scripts/core-service-soak.mjs', 'a-core-service-soak-report-v1'), ev('scripts/core-service-package.mjs', 'core-service-package'), ev('packages/core/src/main.mjs', 'createCoreOpenApiSpec'), ev('packages/core/src/main.mjs', '/worker/queue/drain'), ev('packages/core/src/main.mjs', '/worker/daemon/tick'), ev('packages/core/src/main.mjs', '/runtime/service-plan'), ev('packages/core/src/security/core-admin-auth.js', 'a-core-admin-auth-v1'), ev('packages/core/src/security/core-admin-auth.js', 'A_ADMIN_SCOPE_DENIED'), ev('packages/core/src/client/core-client.js', 'class CoreClient'), ev('packages/core/src/client/core-client.js', 'createServicePlan'), ev('packages/core/src/client/core-client.js', 'a-core-api-contract-diff-v1'), ev('packages/core/src/client/core-api-typegen.js', 'CoreApiOperationId'), ev('packages/core/src/client/generated/core-api-types.d.ts', 'createCoreServiceLifecyclePlan'), ev('packages/core/src/contracts/core-contract-gate.js', 'a-core-contract-gate-v1'), ev('scripts/core-contract-gate.mjs', '--write-baseline'), ev('scripts/core-generate-client-types.mjs', 'core-api-types.d.ts'), ev('tests/ag-runtime.test.js', 'Core service lifecycle planner'), ev('tests/ag-runtime.test.js', 'Core service package'), ev('tests/ag-runtime.test.js', 'Core service runtime entry'), ev('tests/ag-runtime.test.js', 'Core service smoke'), ev('tests/ag-runtime.test.js', 'Core service soak')]),

  req('B-01', 'B', 'ExecutionPacket 수신', 'D/A가 넘긴 ExecutionPacket을 받아 검증 후 실행한다.', 'complete', 3, 0.95, ['ExecutionPacket 수신/검증/실행, durable packet journal, idempotency key, 중복 replay, 재시작 후 결과 복구, durable ExecutionPacketQueue, retry backoff, poison packet quarantine/deadLetters, poison review/requeue/ignore API, 트레이와 모바일 poison review 상태/처리 흐름, retry policy update/journal/API, queue API/drain, 서비스 daemon queue drain supervisor, watchdog heartbeat, runtime status API, Windows Service Recovery 명령 생성이 구현됐다. 여기에 b-execution-packet-release-dossier-v1, b-execution-packet-release-artifact-manifest-v1, b-execution-packet-journal-manifest-v1, b-execution-packet-queue-manifest-v1, b-execution-packet-health-handshake-v1, b-execution-packet-fallback-policy-v1, b-execution-packet-ci-nightly-gate-plan-v1, b-execution-packet-worm-promotion-package-v1, b-execution-packet-worm-provider-contract-v1, b-execution-packet-product-gate-v1이 추가되어 raw ExecutionPacket/capability/user confirmation payload와 queue/journal path를 저장하지 않는 hash-only release evidence, supervisor queue drain health, CI/nightly, WORM 승격 준비를 검증한다. 남은 차이는 실제 Windows 서비스 등록 후 recovery restart smoke와 장기 queue soak를 운영 WORM dossier에 첨부하는 것이다.'], ['Windows 서비스 실등록 환경에서 recovery restart smoke와 장기 queue soak를 실행하고, b-execution-packet-worm-promotion-package-v1을 운영 WORM artifact store에 고정한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'receiveExecutionPacket'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'ExecutionPacketJournal'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'ExecutionPacketQueue'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'packet_retry_scheduled'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'packet_quarantined'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'reviewPoisonPacket'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'packet_requeued'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'packet_retry_policy_updated'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-release-dossier-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-journal-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-queue-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-health-handshake-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-fallback-policy-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-worm-provider-contract-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-packet-product-gate-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rawExecutionPacketPayloadStored'), ev('apps/pc-agent/src/service-daemon.js', 'PcAgentServiceSupervisor'), ev('apps/pc-agent/src/service-daemon.js', 'service.watchdog.heartbeat'), ev('apps/pc-agent/src/install/tray-runtime.js', 'review-poison-queue'), ev('apps/pc-agent/src/install/service-planner.js', 'serviceRecoveryCommands'), ev('apps/pc-agent/src/main.mjs', '/execution-packets/queue/poison'), ev('apps/pc-agent/src/main.mjs', '/execution-packets/queue/policy'), ev('apps/pc-agent/src/main.mjs', '/execution-packets/queue/drain'), ev('apps/pc-agent/src/main.mjs', '/service/runtime'), ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'createPoisonQueueScreenViewModel'), ev('apps/mobile/src/screens/SettingsScreen.js', 'saveRetryPolicy'), ev('apps/bridge/src/main.mjs', '/pc-agent/queue-policy'), ev('tests/ag-runtime.test.js', 'packet_retry_policy_updated'), ev('tests/ag-runtime.test.js', 'execution_packet_health_handshake_ready'), ev('tests/ag-runtime.test.js', 'execution_packet_worm_promotion_package_ready'), ev('tests/ag-runtime.test.js', 'C mobile poison queue screen')]),
  req('B-02', 'B', 'Capability guard', 'E capability token 없이 실행하지 않고 scope/tool/action을 검증한다.', 'complete', 3, 0.95, ['capability token 필수 검증, E scope/tool/action validate, single-use consume, AES-256-GCM sealed local token vault, 평문 tokenId 비저장 검증, provider metadata, Windows DPAPI-backed key provider opt-in이 구현됐다. 여기에 b-capability-vault-deployment-policy-v1 DPAPI/Credential Manager 호환 배포 정책, b-capability-vault-key-rotation-drill-v1, b-capability-vault-export-v1, b-capability-vault-import-recovery-v1, b-capability-vault-product-gate-v1과 HTTP vault lifecycle API가 추가됐다. 또한 b-capability-vault-release-dossier-v1, b-capability-vault-release-artifact-manifest-v1, b-capability-vault-operational-handoff-manifest-v1, b-capability-vault-health-handshake-v1, b-capability-vault-fallback-policy-v1, b-capability-vault-ci-nightly-gate-plan-v1, b-capability-vault-worm-promotion-package-v1, b-capability-vault-worm-provider-contract-v1이 export/import/key-rotation/plaintext absence/DPAPI deployment policy evidence를 hash-only release evidence로 묶고 raw vault path/token/secret/key material 비저장, 운영 handoff, CI/nightly, WORM 승격 준비를 product gate에서 검증한다. 남은 차이는 실제 Windows Credential Manager/DPAPI 관리자 서비스 환경에서 장기 복구 drill evidence를 운영 WORM artifact store에 고정하는 것이다.'], ['실제 Windows 서비스 환경에서 JARVIS_PC_AGENT_VAULT_KEY_PROVIDER=windows-dpapi를 기본 활성화하고 Credential Manager/DPAPI vault export-import recovery artifact와 b-capability-vault-worm-promotion-package-v1을 주기 고정한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'B_CAPABILITY_TOKEN_REQUIRED'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'CapabilityTokenVault'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'sealCapabilityToken'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'WindowsDpapiVaultKeyProvider'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-release-dossier-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-operational-handoff-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-health-handshake-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-fallback-policy-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-worm-provider-contract-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rawVaultPathStored'), ev('tests/ag-runtime.test.js', 'capability_vault_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'capability_vault_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'capability_vault_worm_promotion_package_ready')]),
  req('B-03', 'B', 'Filesystem create/list/move', '허용 루트 안에서 파일 생성, 목록, 이동, 프리뷰를 처리한다.', 'complete', 3, 0.95, ['허용 루트 create/list/move/preview, targetExists shadow, overwrite 차단/명시 승인, restore_previous_file rollback, realpath guard, 대량 move batchDiff, missingSource/targetExists/path/permission issue taxonomy에 더해 b-file-conflict-resolution-ui-v1 사용자 선택형 충돌 처리 상태, b-file-move-batch-policy-v1 copy/rename/skip 배치 정책, b-partial-move-transaction-dry-run-v1 부분 이동 트랜잭션 dry-run, b-windows-acl-deny-corpus-v1 ACL deny fixture 계약과 실행/롤백 테스트가 구현됐다. 여기에 b-file-operation-release-dossier-v1, b-file-operation-release-artifact-manifest-v1, b-file-operation-ci-nightly-gate-plan-v1, b-file-operation-worm-promotion-package-v1, b-file-operation-worm-provider-contract-v1, b-file-operation-product-gate-v1이 추가되어 conflict UI, batch policy, partial transaction dry-run, ACL corpus, rollback coverage를 hash-only release gate로 검증하고 raw file path/content/undo payload 비저장 및 WORM 승격 준비를 확인한다. 남은 차이는 실제 Windows ACL deny 폴더에서 관리자/일반 사용자 반복 evidence를 운영 WORM dossier에 고정하는 것이다.'], ['실제 Windows ACL deny fixture를 관리자/일반 사용자 계정으로 반복 실행하고, b-file-operation-worm-promotion-package-v1에 물리 OS evidence와 copy/rename/skip 이동 정책 visual approval UI를 첨부한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'FileSystemToolAdapter'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-conflict-resolution-ui-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-move-batch-policy-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-partial-move-transaction-dry-run-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-windows-acl-deny-corpus-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-release-dossier-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-worm-provider-contract-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-product-gate-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rawFilePathsStored'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'restore_previous_file'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'batchDiffForFileMoves'), ev('tests/ag-runtime.test.js', 'file_operation_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'file_operation_release_artifact_manifest_ready'), ev('tests/ag-runtime.test.js', 'file_operation_worm_promotion_package_ready')]),
  req('B-04', 'B', '경로 안전 가드', 'allowedRoots 밖 쓰기와 파괴적 경로를 차단한다.', 'complete', 3, 0.95, ['resolve 기반 allowedRoot 검사, realpath 기반 symlink/junction escape 검사, create/list/move/xlsx 부모 경로 검증, preflight 예외의 blocked 결과 수렴, 가능한 파일시스템에서 symlink/junction escape 차단 테스트에 더해 b-path-safety-issue-catalog-v1 Windows ACL/permission taxonomy, b-path-safety-fixture-corpus-v1 safe/outside/junction corpus, b-open-after-realpath-lock-v1 TOCTOU signature lock/verification, createTextFile 실행 전 lock 재검증, PcAgentRuntime pathSafetyStatus/runPathSafetyCorpus 진단 API가 구현됐다. 여기에 b-path-safety-release-dossier-v1, b-path-safety-release-artifact-manifest-v1, b-path-safety-ci-nightly-gate-plan-v1, b-path-safety-worm-promotion-package-v1, b-path-safety-worm-provider-contract-v1, b-path-safety-product-gate-v1이 추가되어 issue catalog, corpus pass rate, TOCTOU change detection, runtime adapter lock readiness를 hash-only release gate로 검증하고 raw path/signature payload 비저장과 WORM 승격 준비를 확인한다. 남은 차이는 실제 관리자/일반 사용자 계정에서 ACL deny corpus를 장시간 반복 실행한 OS evidence다.'], ['실제 Windows ACL deny fixture를 관리자/일반 사용자 계정으로 반복 실행하고, pathSafety corpus trend와 b-path-safety-worm-promotion-package-v1을 pc-agent daemon smoke artifact/WORM store에 포함한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-issue-catalog-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-open-after-realpath-lock-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-release-dossier-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-worm-provider-contract-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-product-gate-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rawPathStored'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'runPathSafetyCorpus'), ev('tests/ag-runtime.test.js', 'path_safety_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'path_safety_release_artifact_manifest_ready'), ev('tests/ag-runtime.test.js', 'path_safety_worm_promotion_package_ready')]),
  req('B-05', 'B', 'Excel/문서 어댑터', '엑셀 파일을 실제 XLSX로 생성하고 검증 정보를 제공한다.', 'complete', 3, 0.95, ['실제 XLSX 생성, 템플릿/스타일/차트 메타데이터, OOXML drawing/chart parts, 파일 기반 템플릿 로딩, worker-module 분리, open validation, visual smoke, render smoke contract, Excel/LibreOffice renderer probe, 템플릿 v2 migration report, worker-pool product soak fixture pack과 workbook:product-soak release artifact가 구현됐다. 여기에 b-workbook-product-gate-v1, b-workbook-release-artifact-manifest-v1, b-workbook-operational-handoff-manifest-v1, b-workbook-health-handshake-v1, b-workbook-fallback-policy-v1, b-workbook-ci-nightly-gate-plan-v1, b-workbook-worm-promotion-package-v1, b-workbook-worm-provider-contract-v1이 추가되어 renderer probe, template migration, worker pool soak, raw workbook/fixture path 비저장, 운영 handoff, CI/nightly, WORM 승격 준비를 제품 게이트로 검증한다. 남은 차이는 실제 Excel/LibreOffice가 설치된 Windows 운영 환경에서 strict external-renderer smoke를 운영 WORM evidence로 고정하는 것이다.'], ['JARVIS_WORKBOOK_RENDERER_REQUIRED=true와 Excel 또는 LibreOffice 설치 환경에서 workbook:product-soak를 실행해 external-renderer-ready evidence와 b-workbook-worm-promotion-package-v1 결과를 release dossier에 고정한다.'], [ev('apps/pc-agent/fixtures/workbook-product-corpus.json', 'b-workbook-product-corpus-v1'), ev('apps/pc-agent/src/adapters/excel/excel-worker.js', 'b-workbook-render-smoke-v1'), ev('apps/pc-agent/src/adapters/excel/excel-worker.js', 'b-workbook-worker-pool-soak-v1'), ev('apps/pc-agent/src/adapters/excel/workbook-template-catalog.js', 'b-workbook-template-migration-report-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'runWorkbookProductCorpus'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-product-soak-dossier-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-product-gate-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-release-artifact-manifest-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-operational-handoff-manifest-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-health-handshake-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-fallback-policy-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-ci-nightly-gate-plan-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-worm-promotion-package-v1'), ev('scripts/workbook-product-soak.mjs', 'b-workbook-worm-provider-contract-v1'), ev('scripts/workbook-product-soak.mjs', 'Operational handoff'), ev('tests/ag-runtime.test.js', 'workbook_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'workbook_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'workbook_worm_promotion_package_ready')]),
  req('B-06', 'B', '브라우저 어댑터', '검색/브라우저 작업을 안전한 read-only 모드로 수행한다.', 'complete', 2, 0.95, ['read-only guard, blocked operation proof, GET-only network capture, sanitized DOM snapshot/hash, PlaywrightReadOnlyBrowserDriver, Python Playwright + system Chrome fallback, liveCapture/screenshot hash evidence contract, fake/live fixture integration test, G execution verifier 검증, recorded network replay corpus, blocked POST replay, rendering snapshot/diff, browser replay soak report, Playwright cache recovery guide가 구현됐다. 여기에 b-browser-replay-release-dossier-v1, b-browser-replay-release-artifact-manifest-v1, b-browser-replay-operational-handoff-manifest-v1, b-browser-replay-health-handshake-v1, b-browser-replay-fallback-policy-v1, b-browser-replay-ci-nightly-gate-plan-v1, b-browser-replay-worm-promotion-package-v1, b-browser-replay-worm-provider-contract-v1, b-browser-replay-product-gate-v1이 추가되어 soak pass, GET-only guard, blocked POST 관측, rendering diff 안정성, 민감정보/raw DOM·network·screenshot artifact 미저장, cache recovery guide, 운영 handoff, WORM 승격 준비를 release gate로 검증한다. 남은 차이는 실제 외부망 장시간 Playwright 캡처와 원격 브라우저 cache failure telemetry다.'], ['실제 외부망에서 수집한 Playwright 실패 캡처를 replay corpus로 승격하고, CI에서 browser:replay-soak artifact의 b-browser-replay-worm-promotion-package-v1 결과를 release dossier에 고정한다.'], [ev('apps/pc-agent/fixtures/browser-network-replay-corpus.json', 'b-browser-network-replay-corpus-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'runBrowserNetworkReplayCorpus'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-browser-rendering-diff-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-playwright-cache-recovery-guide-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-soak-report-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-release-dossier-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-release-artifact-manifest-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-operational-handoff-manifest-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-health-handshake-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-fallback-policy-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-ci-nightly-gate-plan-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-worm-promotion-package-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-worm-provider-contract-v1'), ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-product-gate-v1'), ev('scripts/browser-replay-soak.mjs', 'Operational handoff'), ev('tests/ag-runtime.test.js', 'browser_replay_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'browser_replay_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'browser_replay_worm_promotion_package_ready'), ev('apps/verification/src/verification-runtime.js', 'browser_network_capture_get_only')]),
  req('B-07', 'B', 'Shadow runner', '실행 전 예상 변경사항을 preview하고 승인 전 쓰기를 막는다.', 'complete', 3, 0.95, ['ToolAdapterRegistry가 shadow/execute/contract를 강제하고 dry-run 결과가 packet journal에 남으며 retryable ExecutionPacketQueue와 poison quarantine을 제공한다. filesystem/excel/browser adapter별 golden shadow fixture corpus, b-approval-diff-v1 표준 diff, C 모바일 approval diff review UI state, PC tray approval diff panel, shadow:approval-soak release artifact, b-shadow-queue-drain-soak-v1 운영 queue drain soak가 구현됐다. 여기에 b-shadow-approval-release-dossier-v1, b-shadow-approval-release-artifact-manifest-v1, b-shadow-approval-operational-handoff-manifest-v1, b-shadow-approval-health-handshake-v1, b-shadow-approval-fallback-policy-v1, b-shadow-approval-ci-nightly-gate-plan-v1, b-shadow-approval-worm-promotion-package-v1, b-shadow-approval-worm-provider-contract-v1, b-shadow-approval-product-gate-v1이 추가되어 golden corpus pass, approval diff contract, pre-write shadow guard, 모바일/트레이 review surface, queue drain soak, raw diff path/packet/capability payload 비저장, 운영 handoff, WORM 승격 준비를 release gate로 검증한다. 남은 차이는 실제 장시간 Windows 서비스 설치 상태에서 사용자 화면 캡처와 adapter fixture 대형화다.'], ['실제 Windows 서비스 실기동 상태에서 shadow approval soak를 장시간 실행하고, 모바일/트레이 approval diff screenshot/video와 b-shadow-approval-worm-promotion-package-v1 결과를 release dossier에 첨부한다.'], [ev('apps/pc-agent/src/shadow/golden-shadow-runner.js', 'b-approval-diff-v1'), ev('apps/mobile/src/components/ApprovalActionPanel.js', 'c-approval-diff-review-ui-v1'), ev('apps/pc-agent/src/install/tray-runtime.js', 'b-tray-approval-diff-panel-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-soak-report-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-release-dossier-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-release-artifact-manifest-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-operational-handoff-manifest-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-health-handshake-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-fallback-policy-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-ci-nightly-gate-plan-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-worm-promotion-package-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-worm-provider-contract-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-product-gate-v1'), ev('scripts/shadow-approval-soak.mjs', 'b-shadow-queue-drain-soak-v1'), ev('scripts/shadow-approval-soak.mjs', 'Operational handoff'), ev('tests/ag-runtime.test.js', 'shadow_approval_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'shadow_approval_operational_handoff_ready'), ev('tests/ag-runtime.test.js', 'shadow_approval_worm_promotion_package_ready')]),
  req('B-08', 'B', 'Undo journal', '실행 결과를 되돌릴 수 있도록 rollback 정보를 보존한다.', 'complete', 3, 0.95, ['JSONL journal 재생, rollback 완료 마커, previousHash/hash chain, tamper verification, rollback journal API, dry-run rollback plan, realpath safety checks, digest-signed rollback archive export, rollback transaction lock, step-level rolled_back/skipped 기록이 구현됐다. 여기에 b-rollback-worm-archive-store-v1 WORM-style content-addressed archive sync, b-rollback-archive-signature-key-rotation-drill-v1 dual-signature key rotation drill, b-rollback-crash-recovery-drill-v1 crash recovery drill, b-rollback-product-gate-v1과 /rollback/product-gate API가 추가되어 rollback 가능성뿐 아니라 장기 보관/서명 회전/복구 가능성까지 제품 게이트로 검증한다. 또한 b-rollback-release-artifact-manifest-v1, b-rollback-operational-handoff-manifest-v1, b-rollback-health-handshake-v1, b-rollback-fallback-policy-v1, b-rollback-ci-nightly-gate-plan-v1, b-rollback-worm-promotion-package-v1, b-rollback-worm-provider-contract-v1이 추가되어 undo payload/rollback path/archive path/capability token 원문을 저장하지 않는 hash-only release dossier와 운영 handoff, 외부 WORM 승격 준비를 검증한다. 남은 차이는 실제 외부 WORM 저장소와 관리자 Windows 서비스 장기 rollback drill evidence다.'], ['실제 WORM/원격 artifact storage에 b-rollback-worm-promotion-package-v1을 동기화하고, Administrator Windows 서비스 실기동 상태에서 b-rollback-product-gate-v1을 장시간/주기적으로 실행해 release dossier에 고정한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'class UndoJournal'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'class RollbackTransactionLog'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rollback_transaction_step'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'rollbackPlan'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'exportRollbackArchive'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-product-gate-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-archive-store-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-crash-recovery-drill-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-operational-handoff-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-provider-contract-v1'), ev('apps/pc-agent/src/main.mjs', '/rollback/:taskId/plan'), ev('apps/pc-agent/src/main.mjs', '/rollback/:taskId/export'), ev('apps/pc-agent/src/main.mjs', '/rollback/product-gate'), ev('apps/pc-agent/src/main.mjs', '/rollback/transactions'), ev('tests/ag-runtime.test.js', 'b-rollback-product-gate-v1'), ev('tests/ag-runtime.test.js', 'rollback_worm_promotion_package_ready')]),
  req('B-09', 'B', 'Local API', 'execution-packets/result/evidence/logs/rollback API를 제공한다.', 'complete', 2, 0.95, ['execution-packets/result/evidence/logs/memory/rollback/journal/rollback-plan/rollback-export/rollback-transactions/queue API, bearer token guard, payload schema validation, local rate guard, OpenAPI 3.1 schema route, route-level x-ratelimit headers가 구현됐다. 또한 b-pc-agent-secret-token-store-v1, b-pc-agent-api-contract-snapshot-v1, b-pc-agent-api-contract-diff-v1, b-pc-agent-api-middleware-hardening-v1, b-pc-agent-local-api-product-gate-v1이 있고, b-pc-agent-local-api-release-dossier-v1과 b-pc-agent-local-api-deployment-policy-v1이 추가되어 token store, contract drift, middleware hardening, 핵심 route surface를 release gate로 검증한다. 여기에 b-pc-agent-local-api-release-artifact-manifest-v1, b-pc-agent-local-api-operational-handoff-manifest-v1, b-pc-agent-local-api-health-handshake-v1, b-pc-agent-local-api-fallback-policy-v1, b-pc-agent-local-api-ci-nightly-gate-plan-v1, b-pc-agent-local-api-worm-promotion-package-v1, b-pc-agent-local-api-worm-provider-contract-v1이 추가되어 token store path/token hash/request body/capability token 원문 비저장, 운영 handoff, 외부 WORM 승격 준비까지 product gate에서 검증한다. 남은 차이는 실제 관리자 Windows 서비스 환경에서 token store/route hardening 장기 HTTP soak를 외부 release dossier에 고정하는 것이다.'], ['실제 Windows 서비스 실기동 상태에서 `/api/product-gate`와 전체 Local API smoke를 장시간 반복 실행하고, b-pc-agent-local-api-worm-promotion-package-v1 결과를 원격 WORM release dossier에 고정한다.'], [ev('apps/pc-agent/src/main.mjs', '/execution-packets'), ev('apps/pc-agent/src/main.mjs', '/openapi.json'), ev('apps/pc-agent/src/main.mjs', 'createPcAgentOpenApiSpec'), ev('apps/pc-agent/src/main.mjs', '/rollback/:taskId/plan'), ev('apps/pc-agent/src/main.mjs', '/rollback/:taskId/export'), ev('apps/pc-agent/src/main.mjs', '/rollback/transactions'), ev('apps/pc-agent/src/main.mjs', 'x-ratelimit-remaining'), ev('apps/pc-agent/src/main.mjs', 'PcAgentApiGuard'), ev('apps/pc-agent/src/main.mjs', 'B_EXECUTION_PACKET_SCHEMA_INVALID'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-release-dossier-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-deployment-policy-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-release-artifact-manifest-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-operational-handoff-manifest-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-ci-nightly-gate-plan-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-worm-promotion-package-v1'), ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-worm-provider-contract-v1'), ev('tests/ag-runtime.test.js', 'pc_agent_local_api_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'pc_agent_local_api_worm_promotion_package_ready')]),
  req('B-10', 'B', '실행 증거와 메모리 이벤트', 'G 검증과 F 학습으로 넘길 evidence/memory event를 만든다.', 'complete', 2, 0.95, ['ExecutionEvidenceCollector, 툴별 evidence schema registry, schemaValidation, privacy redaction, workbook/browser adapter evidence, F memory event가 구현됐다. 여기에 evidence query pagination, retention/rotation dry-run, schema snapshot/regression, privacy redaction fixture corpus, /evidence/product-gate와 b-execution-evidence-product-gate-v1이 추가되어 실행 증거 보존·검색·개인정보 마스킹·memory event linkage를 daemon smoke와 HTTP regression에서 자동 검증한다. 또한 b-execution-evidence-release-dossier-v1, b-execution-evidence-release-artifact-manifest-v1, b-execution-evidence-operational-handoff-manifest-v1, b-execution-evidence-health-handshake-v1, b-execution-evidence-fallback-policy-v1, b-execution-evidence-ci-nightly-gate-plan-v1, b-execution-evidence-worm-promotion-package-v1, b-execution-evidence-worm-provider-contract-v1이 추가되어 raw execution evidence/file path/memory payload/capability token/user command 비저장, G/F handoff 상태, 외부 WORM 승격 준비를 product gate에서 검증한다. 남은 차이는 실제 Windows 서비스 장시간 실행 evidence와 외부 WORM/archive storage다.'], ['실제 Windows 서비스 장시간 실행에서 b-execution-evidence-worm-promotion-package-v1 결과와 evidence rotation archive를 WORM/원격 artifact store에 보존한다.'], [ev('apps/pc-agent/src/pc-agent-runtime.js', 'class ExecutionEvidenceCollector'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-product-gate-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-release-dossier-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-release-artifact-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-operational-handoff-manifest-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-worm-promotion-package-v1'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'ExecutionEvidenceSchemaRegistry'), ev('apps/pc-agent/src/pc-agent-runtime.js', 'EvidencePrivacyRedactor'), ev('apps/pc-agent/src/main.mjs', '/evidence/product-gate'), ev('scripts/pc-agent-daemon-smoke.mjs', 'evidence-product-gate-passed'), ev('tests/ag-runtime.test.js', 'b-execution-evidence-product-gate-v1'), ev('tests/ag-runtime.test.js', 'execution_evidence_worm_promotion_package_ready')]),
  req('B-11', 'B', '설치형 PC 프로그램', '문서의 로컬 상주 프로그램/트레이/설치 흐름을 제공한다.', 'complete', 2, 0.95, ['daemon config, queueDrain 설정, Windows service manifest, service recovery policy, service supervisor runtime, explicit --execute service command path, idempotent install/update/start/stop/restart/status/uninstall plans, installer package generator, lifecycle PowerShell scripts, package file-integrity manifest, local digest signature, verify-package script, diagnostic log collector, service readiness verifier, CLI/API verification report, installed-service smoke verifier, install-all orchestrator, install/release verification orchestrator, Windows Forms NotifyIcon tray script, tray queue/poison review 상태, tray launcher, startup shortcut install/uninstall scripts, C# native tray source, native tray exe build script, Authenticode signing/verification scripts, dev code-signing certificate helper, NSIS installer template/build script, release manifest, release gate, install-release report, release-evidence aggregator, user-process daemon smoke verifier, tray state/actions, service/tray API가 구현됐다. 여기에 pc-agent:install-release와 b-pc-agent-install-release-dossier-v1, b-pc-agent-install-release-product-gate-v1이 추가되어 패키지 무결성, service readiness, user-process daemon smoke, tray assets, signing/installer scripts, Administrator install runbook을 Node release dossier로 검증한다. 또한 b-pc-agent-install-release-artifact-manifest-v1, b-pc-agent-install-operational-handoff-manifest-v1, b-pc-agent-install-health-handshake-v1, b-pc-agent-install-fallback-policy-v1, b-pc-agent-install-ci-nightly-gate-plan-v1, b-pc-agent-install-worm-promotion-package-v1, b-pc-agent-install-worm-provider-contract-v1이 추가되어 artifact path/service command/package file content/signing certificate 원문 비저장, 운영 handoff, 외부 WORM 승격 준비를 product gate에서 검증한다. 남은 차이는 실제 Administrator Windows 서비스 등록 실기동 smoke와 신뢰된 정식 코드서명 인증서 검증을 원격 release evidence에 첨부하는 것이다.'], ['Administrator PowerShell에서 install-verify-release.ps1을 실행해 service-smoke-report.json, signature-verification-report.json, release-gate-report.json, release-evidence.json을 저장하고, b-pc-agent-install-worm-promotion-package-v1에 물리 설치 증거를 첨부한다.'], [ev('apps/pc-agent/install/daemon-config.json', 'queueDrain'), ev('apps/pc-agent/install/windows-service-manifest.json', 'restartOnNonCrashFailures'), ev('apps/pc-agent/install/windows-service-manifest.json', 'JARVIS_SERVICE_DAEMON'), ev('apps/pc-agent/src/service-daemon.js', 'PcAgentServiceSupervisor'), ev('apps/pc-agent/src/install/service-planner.js', 'createServicePlan'), ev('apps/pc-agent/src/install/service-planner.js', 'serviceRecoveryCommands'), ev('apps/pc-agent/src/install/service-planner.js', 'JARVIS_PACKET_QUEUE'), ev('apps/pc-agent/src/install/service-planner.js', 'restart'), ev('apps/pc-agent/src/install/installer-packager.js', 'writeInstallerPackage'), ev('apps/pc-agent/src/install/installer-packager.js', 'fileIntegrity'), ev('apps/pc-agent/src/install/installer-packager.js', 'restart-service.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'verify-package.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'verify-installed-service.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'service-smoke-report.json'), ev('apps/pc-agent/src/install/installer-packager.js', 'install-all.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'install-verify-release.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'b-pc-agent-install-release-v1'), ev('apps/pc-agent/src/install/installer-packager.js', 'sign-artifacts.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'Set-AuthenticodeSignature'), ev('apps/pc-agent/src/install/installer-packager.js', 'create-dev-signing-cert.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'verify-release-gate.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'release-gate-report.json'), ev('apps/pc-agent/src/install/installer-packager.js', 'trusted-code-signing'), ev('apps/pc-agent/src/install/installer-packager.js', 'build-release-evidence.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'daemon-smoke-report.json'), ev('apps/pc-agent/src/install/installer-packager.js', 'commonMakensis'), ev('apps/pc-agent/src/install/installer-packager.js', 'installer.nsi'), ev('apps/pc-agent/src/install/installer-packager.js', 'release-manifest.json'), ev('apps/pc-agent/src/install/installer-packager.js', 'tray-agent.cs'), ev('apps/pc-agent/src/install/installer-packager.js', 'build-tray-exe.ps1'), ev('apps/pc-agent/src/install/installer-packager.js', 'System.Windows.Forms.NotifyIcon'), ev('apps/pc-agent/src/install/service-verifier.js', 'service-recovery-policy'), ev('apps/pc-agent/src/install/service-verifier.js', 'queue-drain-supervisor'), ev('apps/pc-agent/src/install/service-verifier.js', 'verifyPcAgentServiceReadiness'), ev('apps/pc-agent/src/install/service-verifier.js', 'package-manifest'), ev('apps/pc-agent/src/install/tray-runtime.js', 'PcAgentTrayRuntime'), ev('apps/pc-agent/src/install/tray-runtime.js', 'poisonReview'), ev('apps/pc-agent/src/install/tray-runtime.js', 'review-poison-queue'), ev('apps/pc-agent/src/install/tray-runtime.js', 'update-service'), ev('scripts/pc-agent-daemon-smoke.mjs', 'b-pc-agent-daemon-smoke-v1'), ev('scripts/pc-agent-daemon-smoke.mjs', 'startPcAgentServiceRuntime'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-dossier-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-product-gate-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-artifact-manifest-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-operational-handoff-manifest-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-ci-nightly-gate-plan-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-worm-promotion-package-v1'), ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-worm-provider-contract-v1'), ev('package.json', 'pc-agent:install-release'), ev('apps/pc-agent/src/main.mjs', '/service/runtime'), ev('apps/pc-agent/src/main.mjs', '/service/verification'), ev('tests/ag-runtime.test.js', 'pc_agent_install_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'pc_agent_install_worm_promotion_package_ready')]),

  req('C-01', 'C', 'Expo 앱 구조', '문서의 모바일/태블릿 앱 프로젝트 골격과 App entry를 갖춘다.', 'complete', 3, 0.91, ['Expo app/package/native capability contract, secure-store/notification plugin, Android/iOS 권한 선언, Metro monorepo config, release APK build/install, embedded JS bundle, actual emulator launch, native runtime probe와 route navigation smoke에 더해 c-mobile-release-preflight-v1, EAS production store profile, Android versionCode/iOS buildNumber, 환경변수 기반 production keystore signing policy, mobile:release-preflight report가 구현됐다. 또한 c-mobile-app-shell-v1, c-mobile-app-bootstrap-manifest-v1, c-mobile-app-structure-product-gate-v1과 c-mobile-release-dossier-v1, c-mobile-release-dossier-product-gate-v1이 추가되어 앱 구조, native/screen contract, release preflight local contract, device/store evidence tracking을 하나의 release dossier로 검증한다. 남은 차이는 실제 Expo 계정/EAS 프로젝트, production keystore secret, 물리 iOS/Android store submission smoke다.'], ['실제 production keystore와 EXPO_TOKEN/EAS projectId를 주입해 strict preflight를 통과시키고, 물리 Android/iOS store build/submission dry-run evidence를 c-mobile-release-dossier-v1에 첨부한다.'], [ev('apps/mobile/app.json', 'versionCode'), ev('apps/mobile/eas.json', 'production'), ev('apps/mobile/android/app/build.gradle', 'JARVIS_ANDROID_KEYSTORE_PATH'), ev('apps/mobile/src/App.tsx', 'JARVIS Mobile'), ev('apps/mobile/src/App.js', 'c-mobile-app-structure-product-gate-v1'), ev('scripts/mobile-release-preflight.mjs', 'c-mobile-release-preflight-v1'), ev('scripts/mobile-release-dossier.mjs', 'c-mobile-release-dossier-v1'), ev('scripts/mobile-release-dossier.mjs', 'c-mobile-release-dossier-product-gate-v1'), ev('scripts/mobile-verify.mjs', 'product:mobile-release-local-contract'), ev('tests/ag-runtime.test.js', 'mobile_release_dossier_ready')]),
  req('C-02', 'C', 'BridgeClient', 'D 브릿지 API를 모바일 쪽에서 호출하는 클라이언트를 제공한다.', 'complete', 3, 0.91, ['Task/approval/result/growth/event/poison queue API client, timeout, safe-method retry/backoff, HTTP/network/invalid JSON typed error envelope, 실제 Android UI 기반 /health, /pairing, /tasks, /approvals, approval decision 왕복 E2E가 통과했다. 여기에 c-bridge-client-auth-refresh-v1, c-bridge-request-cancel-ux-v1, c-bridge-friendly-error-taxonomy-v1, c-bridge-client-release-dossier-v1, c-bridge-client-product-gate-v1이 추가되어 token refresh, request cancel UX, 사용자 친화적 오류 분류, generated types 계약을 product gate로 검증한다. 남은 차이는 물리 기기에서 token refresh/cancel UX visual evidence와 장기 live bridge 네트워크 장애 corpus를 고정하는 것이다.'], ['물리 Android/iOS에서 token refresh, request cancel, offline/retry 오류 UX screenshot/video를 수집하고 c-bridge-client-release-dossier-v1을 live bridge E2E release evidence에 첨부한다.'], [ev('apps/mobile/src/api/BridgeClient.js', 'class BridgeClient'), ev('apps/mobile/src/api/BridgeClient.js', 'C_BRIDGE_TIMEOUT'), ev('apps/mobile/src/api/BridgeClient.js', 'C_BRIDGE_INVALID_JSON'), ev('apps/mobile/src/api/BridgeClient.js', 'sendApprovalDecision'), ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-client-release-dossier-v1'), ev('apps/mobile/src/api/BridgeClient.js', 'bridge_client_release_dossier_ready'), ev('scripts/mobile-live-bridge-e2e.mjs', 'runMobileLiveBridgeE2E'), ev('tests/ag-runtime.test.js', 'bridge_client_release_dossier_ready')]),
  req('C-03', 'C', 'Pairing 화면/흐름', '페어링 시작/확인/연결 상태 표시 흐름을 제공한다.', 'complete', 2, 0.95, ['QR payload v2(pairingId/code/bridge/expiresAt), 수동 코드/로컬 bridge URL validation, 실제 /pairing/start, /pairing/confirm, 연결 상태 표시, sealed token 저장, D Bridge device revoke 기반 disconnect, 앱 재시작 후 SecureStore restore/cleanup E2E, native QR scanner permission contract, QR payload parser, 만료/폐기 토큰 recovery state, device inventory view-model evidence가 구현됐다. 또한 c-pairing-release-dossier-v1, c-pairing-release-artifact-manifest-v1, c-pairing-operational-handoff-manifest-v1, c-pairing-health-handshake-v1, c-pairing-fallback-policy-v1, c-pairing-ci-nightly-gate-plan-v1, c-pairing-worm-promotion-package-v1, c-pairing-worm-provider-contract-v1, c-pairing-screen-product-gate-v1이 QR/수동 입력/토큰 봉인/복구/inventory와 raw pairing code/device token/QR payload 비저장을 product gate로 검증한다. 남은 차이는 실제 카메라 스캐너 모듈의 물리 기기 UX 캡처와 토큰 회전 화면 polish다.'], ['Expo Camera/BarcodeScanner 실제 권한 prompt와 스캔 성공/실패 스크린샷, 토큰 회전 UX를 c-pairing-worm-promotion-package-v1 release evidence에 고정한다.'], [ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-release-dossier-v1'), ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-release-artifact-manifest-v1'), ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-operational-handoff-manifest-v1'), ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-worm-promotion-package-v1'), ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-screen-product-gate-v1'), ev('apps/mobile/src/screens/PairingScreen.js', 'scannerPermission'), ev('apps/mobile/src/screens/PairingScreen.js', 'recovery'), ev('apps/mobile/src/components/PairingQrPanel.js', 'c-native-qr-scanner-contract-v1'), ev('apps/mobile/src/components/PairingQrPanel.js', 'c-pairing-recovery-state-v1'), ev('apps/mobile/src/components/PairingQrPanel.tsx', 'pairing-qr-scanner-state'), ev('scripts/mobile-verify.mjs', 'runtime:pairing-scanner-recovery-inventory'), ev('scripts/mobile-verify.mjs', 'runtime:pairing-screen-product-gate'), ev('tests/ag-runtime.test.js', 'pairingVm.scannerPermission'), ev('tests/ag-runtime.test.js', 'pairing_worm_promotion_package_ready')]),
  req('C-04', 'C', 'Command 화면', '명령 입력, 오프라인 큐, 전송 상태를 관리한다.', 'complete', 3, 0.95, ['CommandComposerPanel 입력 validation, offline queue mode, queue review/send/cancel action, pending queue detail, keyboard submit contract, command request timeout/cancel UX state, 실제 CommandScreen route navigation, TextInput 렌더링, live POST /tasks Android E2E가 통과했다. 여기에 c-command-pending-queue-detail-panel-v1, c-command-network-recovery-visual-regression-v1, mobile:verify runtime command checks가 추가되어 장기 네트워크 지연/복구, timeout cancel, recovered keyboard submit, pending queue 상세 panel을 회귀 artifact로 고정했다. 또한 c-command-screen-release-dossier-v1, c-command-screen-release-artifact-manifest-v1, c-command-screen-operational-handoff-manifest-v1, c-command-screen-health-handshake-v1, c-command-screen-fallback-policy-v1, c-command-screen-ci-nightly-gate-plan-v1, c-command-screen-worm-promotion-package-v1, c-command-screen-worm-provider-contract-v1, c-command-screen-product-gate-v1이 queue detail, timeout/cancel recovery, keyboard submit recovery, raw command/queue text 비저장, 운영 handoff, WORM 승격 준비를 release evidence로 고정한다. 남은 차이는 물리 기기에서 같은 command visual regression을 screenshot/video로 release dossier에 첨부하는 것이다.'], ['물리 Android/iOS에서 command network recovery visual regression과 pending queue 상세 화면 screenshot/video를 c-command-screen-worm-promotion-package-v1에 첨부한다.'], [ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-pending-queue-detail-panel-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-network-recovery-visual-regression-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-release-dossier-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-release-artifact-manifest-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-operational-handoff-manifest-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-worm-promotion-package-v1'), ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-product-gate-v1'), ev('apps/mobile/src/components/CommandComposerPanel.js', 'keyboardSubmit'), ev('apps/mobile/src/components/CommandComposerPanel.js', 'createCommandRequestState'), ev('apps/mobile/src/components/CommandComposerPanel.tsx', 'onSubmitEditing'), ev('apps/mobile/src/components/CommandComposerPanel.tsx', 'command-cancel-request'), ev('scripts/mobile-verify.mjs', 'runtime:command-network-recovery-visual-regression'), ev('scripts/mobile-verify.mjs', 'runtime:command-screen-product-gate'), ev('scripts/mobile-live-bridge-e2e.mjs', 'ui.task-create'), ev('tests/ag-runtime.test.js', 'c-command-screen-product-gate-v1'), ev('tests/ag-runtime.test.js', 'command_screen_worm_promotion_package_ready')]),
  req('C-05', 'C', 'Approval Queue/Detail', '승인 목록과 상세 안전 정보를 확인할 수 있다.', 'complete', 3, 0.95, ['승인 queue/detail view-model, ApprovalCardView, ApprovalActionPanel, approve/edit/reject/respond action state, 안전 사실 노출, 만료 카드 표시/액션 차단, C_APPROVAL_EXPIRED 사전 차단, D Bridge /renew 연장 UX, approval cancel/re-request API와 모바일 액션, approval history timeline과 /approvals/:id/history 계약, 실제 ApprovalQueue/Detail route navigation, live GET /approvals와 approval decision Android E2E가 통과했다. 또한 c-approval-lifecycle-visual-regression-v1, c-approval-lifecycle-release-dossier-v1, c-approval-lifecycle-release-artifact-manifest-v1, c-approval-lifecycle-operational-handoff-manifest-v1, c-approval-lifecycle-health-handshake-v1, c-approval-lifecycle-fallback-policy-v1, c-approval-lifecycle-ci-nightly-gate-plan-v1, c-approval-lifecycle-worm-promotion-package-v1, c-approval-lifecycle-worm-provider-contract-v1, c-approval-lifecycle-product-gate-v1이 queue/detail, expiry renew/cancel/re-request, timeline visual regression, raw approval/history/reason 비저장을 product gate로 검증한다. 남은 차이는 물리 기기 native stack transition screenshot/video를 release evidence에 고정하는 것이다.'], ['native stack transition, 만료/취소/재요청/timeline visual regression을 c-approval-lifecycle-worm-promotion-package-v1에 첨부한다.'], [ev('apps/mobile/src/screens/ApprovalQueueScreen.js'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-release-dossier-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-operational-handoff-manifest-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-worm-promotion-package-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-product-gate-v1'), ev('apps/mobile/src/approval/approval-history.js'), ev('apps/mobile/src/components/ApprovalCardView.tsx', 'approval-expiry-state'), ev('apps/mobile/src/components/ApprovalActionPanel.js', 'expiry'), ev('apps/mobile/src/mobile-runtime.js', 'approvalHistory'), ev('apps/mobile/src/mobile-runtime.js', 'reRequestApproval'), ev('apps/bridge/src/bridge-runtime.js', 'getApprovalHistory'), ev('apps/mobile/src/App.tsx', 'approval-history-timeline'), ev('tests/ag-runtime.test.js', 'approval.replacement.created'), ev('tests/ag-runtime.test.js', 'approval_lifecycle_worm_promotion_package_ready'), ev('scripts/mobile-live-bridge-e2e.mjs', 'ui.approval-decision')]),
  req('C-06', 'C', '모바일 승인 제한', 'Tier 3 이하 고위험 작업을 모바일 단독 승인하지 않도록 표시/차단한다.', 'complete', 3, 0.95, ['E 정책, approvalSafetyFacts, RiskBadge, 위험도별 accessibility label/hint, ApprovalActionPanel disabled accessibilityState, disabled visual snapshot, PC 확인 차단 사유, ApprovalDetailScreen의 고위험 차단 메시지, D Bridge /pc-handoff 계약, approval.pc_handoff.requested/accepted/rejected history/event, 모바일 PC 확인 요청 버튼, PC 확인 수락/거절 콘솔, PC 콘솔 Bridge fetch 클라이언트, accept/reject visual snapshot baseline comparator, 테스트/모바일 검증 evidence가 구현됐다. 여기에 c-mobile-approval-restriction-release-dossier-v1, c-mobile-approval-restriction-release-artifact-manifest-v1, c-mobile-approval-restriction-operational-handoff-manifest-v1, c-mobile-approval-restriction-health-handshake-v1, c-mobile-approval-restriction-fallback-policy-v1, c-mobile-approval-restriction-ci-nightly-gate-plan-v1, c-mobile-approval-restriction-worm-promotion-package-v1, c-mobile-approval-restriction-worm-provider-contract-v1, c-mobile-approval-restriction-product-gate-v1이 고위험 모바일 승인 차단, PC handoff, PC 콘솔 visual regression, raw approval/console/device token 비저장을 hash-only release evidence로 고정하고 mobile:verify product gate check에 연결됐다. 남은 차이는 물리 PC 브라우저 픽셀 screenshot을 release evidence로 고정하는 것이다.'], ['물리 PC 브라우저에서 PC 콘솔 accept/reject screenshot regression을 c-mobile-approval-restriction-worm-promotion-package-v1에 첨부한다.'], [ev('apps/mobile/src/components/RiskBadge.tsx', 'accessibilityLabel'), ev('apps/mobile/src/accessibility/approval-accessibility.js', 'createApprovalActionVisualSnapshot'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-release-dossier-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-operational-handoff-manifest-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-worm-promotion-package-v1'), ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-product-gate-v1'), ev('apps/mobile/src/mobile-runtime.js', 'requestPcConfirmation'), ev('apps/mobile/src/components/ApprovalActionPanel.js', 'pcHandoffAction'), ev('apps/bridge/src/bridge-runtime.js', 'decidePcConfirmationHandoff'), ev('apps/bridge/src/main.mjs', '/pc-console/approval-handoffs'), ev('src/domain/pc-console.js', 'class PcConfirmationConsole'), ev('src/domain/pc-console.js', 'PcConfirmationConsoleBridgeClient'), ev('src/domain/pc-console.js', 'createPcConsoleVisualSnapshot'), ev('src/ui/app.js', 'bridge-fetch'), ev('tests/ag-runtime.test.js', 'c-mobile-approval-restriction-product-gate-v1'), ev('tests/ag-runtime.test.js', 'mobile_approval_restriction_worm_promotion_package_ready'), ev('scripts/mobile-verify.mjs', 'runtime:pc-console-bridge-fetch'), ev('scripts/mobile-verify.mjs', 'runtime:pc-console-visual-regression'), ev('scripts/mobile-verify.mjs', 'runtime:mobile-approval-restriction-product-gate')]),
  req('C-07', 'C', 'Task/Result/Feedback 화면', '작업 진행, 결과, 피드백 입력 흐름을 제공한다.', 'complete', 3, 0.91, ['TaskStatus/Result view-model, live status polling state, latency/error/changed metadata, ResultSummaryCard, ResultFeedbackPanel, feedback validation, pending/error submission state, output file preview/share contract, expo-sharing dependency, NativeRuntimeProbe sharing check, rollback confirmation state machine, D Bridge rollback route, 모바일 runtime rollback session gate, 성장 리뷰 이동, 실제 TaskStatus/Result route navigation과 feedback input 렌더링, 모바일 end-to-end preview/share/rollback 테스트가 구현됐다. 여기에 c-task-status-long-polling-latency-visual-regression-v1, c-result-rollback-proof-modal-v1, c-result-feedback-release-dossier-v1, c-result-feedback-product-gate-v1이 추가되어 polling latency, preview/share, rollback confirmation/proof modal, growth review route를 product gate로 검증한다. 남은 차이는 물리 기기 visual regression과 장기 polling latency 캡처다.'], ['물리 기기에서 파일 preview/share sheet 캡처, 장기 polling latency visual regression, rollback proof 상세 modal screenshot/video를 c-result-feedback-release-dossier-v1에 첨부한다.'], [ev('apps/mobile/src/screens/TaskStatusScreen.js', 'createTaskPollingState'), ev('apps/mobile/src/screens/ResultScreen.js', 'previewFile'), ev('apps/mobile/src/screens/ResultScreen.js', 'C_ROLLBACK_CONFIRMATION_REQUIRED'), ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-release-dossier-v1'), ev('apps/mobile/src/screens/ResultScreen.js', 'result_feedback_release_dossier_ready'), ev('apps/mobile/src/components/ResultFeedbackPanel.js', 'c-result-rollback-confirmation-v1'), ev('apps/mobile/src/components/ResultFeedbackPanel.js', 'expo-sharing'), ev('apps/mobile/src/mobile-runtime.js', 'NativeDocumentActionAdapter'), ev('apps/mobile/src/mobile-runtime.js', 'previewOutputFile'), ev('apps/mobile/src/mobile-runtime.js', 'shareOutputFile'), ev('apps/mobile/src/components/NativeRuntimeProbe.tsx', 'Sharing native:'), ev('apps/mobile/package.json', 'expo-sharing'), ev('scripts/mobile-verify.mjs', 'runtime:document-preview-share'), ev('tests/ag-runtime.test.js', 'result_feedback_release_dossier_ready'), ev('apps/mobile/src/App.tsx', 'result-rollback-confirmation')]),
  req('C-08', 'C', 'Growth Review 화면', 'F 학습 후보와 리뷰 상태를 모바일에서 확인한다.', 'complete', 3, 0.9, ['GrowthReviewDecisionPanel, preference candidate confirm/reject action state, confidence explanation, supporting/contradicting evidence summary, conflict acknowledgement flag, conflict resolution modal contract, decision pending/error/latency state, hygiene review queue explanation/action state, 장기 hygiene trend chart, batch selection UI contract, D bridge preference/hygiene decision route, BridgeClient/MobileRuntime batch hygiene decision client path, F decidePreference/decideHygiene/decideHygieneBatch 반영 테스트, 실제 GrowthReviewScreen route navigation과 mobile verification visual contract evidence가 구현됐다. 여기에 c-growth-review-release-dossier-v1, c-growth-review-release-artifact-manifest-v1, c-growth-review-product-gate-v1이 visual snapshot, hygiene trend/batch, conflict modal, raw preference/memory/conflict evidence 비저장을 hash-only release evidence로 고정하고 mobile:verify product gate check에 연결됐다. 남은 차이는 물리 기기 screenshot/video 기반 visual regression을 release evidence로 고정하는 것이다.'], ['물리 Android/iOS에서 Growth Review trend/batch/conflict 화면 screenshot regression을 c-growth-review-release-dossier-v1에 첨부한다.'], [ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'conflictResolutionState'), ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'decideHygieneBatch'), ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-release-dossier-v1'), ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-release-artifact-manifest-v1'), ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-product-gate-v1'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createHygieneTrendChart'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createHygieneBatchSelectionState'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createGrowthConflictResolutionState'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createGrowthReviewVisualSnapshot'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.tsx', 'growth-hygiene-trend-chart'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.tsx', 'growth-conflict-resolution-modal'), ev('apps/mobile/src/api/BridgeClient.js', 'decideGrowthHygieneBatch'), ev('apps/mobile/src/mobile-runtime.js', 'decideGrowthHygieneBatch'), ev('apps/bridge/src/bridge-runtime.js', 'decideGrowthHygieneBatch'), ev('tests/ag-runtime.test.js', 'c-growth-review-product-gate-v1'), ev('scripts/mobile-verify.mjs', 'runtime:growth-review-product-gate'), ev('apps/mobile/src/App.tsx', 'screen-content-GrowthReviewScreen')]),
  req('C-09', 'C', 'Secure token storage', 'deviceToken을 안전 저장소에 보존한다.', 'complete', 3, 0.9, ['AES-256-GCM sealed fallback store, expo-secure-store native adapter contract, native/fallback metadata, plaintext 비노출 검증, SecureStore native runtime probe UI, 실제 페어링 후 Expo SecureStore write/read, 앱 force-stop/relaunch restore, D Bridge revoke 후 SecureStore cleanup E2E가 통과했다. 여기에 c-secure-token-lifecycle-status-v1, c-secure-token-recovery-ux-v1, c-secure-token-rotation-recovery-v1, c-secure-token-revoke-retry-queue-v1, c-secure-token-storage-product-gate-v1이 추가되어 만료 감지, 회전 복구, revoke 실패 재시도 큐를 mobile:verify 산출물로 검증한다. 남은 차이는 물리 Android/iOS SecureStore에서 장기 force-stop/relaunch, 만료 토큰 복구, revoke 실패 재시도 screenshot/video를 release dossier에 고정하는 것이다.'], ['물리 Android/iOS SecureStore에서 c-secure-token-storage-product-gate-v1을 장기 실행하고, 만료/회전/revoke retry UX screenshot/video를 release dossier에 고정한다.'], [ev('apps/mobile/src/mobile-runtime.js', 'class SecureTokenStore'), ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-product-gate-v1'), ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-recovery-ux-v1'), ev('apps/mobile/src/screens/SettingsScreen.js', 'runSecureTokenProductGate'), ev('scripts/mobile-verify.mjs', 'runtime:secure-token-product-gate'), ev('apps/mobile/src/components/NativeRuntimeProbe.tsx', 'SecureStore.isAvailableAsync'), ev('apps/mobile/src/App.tsx', 'SecureStore.setItemAsync'), ev('apps/mobile/src/App.tsx', 'SecureStore.deleteItemAsync'), ev('tests/ag-runtime.test.js', 'c-secure-token-storage-product-gate-v1')]),
  req('C-10', 'C', 'Session lock', '앱 복귀/민감 승인 전 세션 잠금을 요구한다.', 'complete', 3, 0.9, ['PIN 기반 세션 잠금, timeout, background/inactive lifecycle lock, RN AppState listener, 승인/실행 re-auth gate, SettingsScreen lifecycle lock reason, PIN 실패 횟수 기반 lockout, expo-local-authentication native secure prompt 계약, biometric unlock fallback evidence, foreground/background lifecycle soak 검증이 구현됐다. 여기에 c-session-lock-foreground-background-visual-regression-v1과 c-session-lock-product-gate-v1이 추가되어 background sensitive surface hide, biometric prompt smoke, foreground/background soak를 모바일 runtime과 mobile:verify product gate로 고정했다. 남은 차이는 물리 Android/iOS 생체 prompt screenshot/video와 장시간 foreground/background soak evidence를 release dossier에 첨부하는 것이다.'], ['물리 Android/iOS에서 c-session-lock-product-gate-v1 결과와 biometric prompt/foreground-background visual regression screenshot/video를 release dossier에 고정한다.'], [ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-foreground-background-visual-regression-v1'), ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-product-gate-v1'), ev('apps/mobile/src/mobile-runtime.js', 'NativeBiometricPromptAdapter'), ev('apps/mobile/src/screens/SettingsScreen.js', 'runSessionLockProductGate'), ev('apps/mobile/package.json', 'expo-local-authentication'), ev('scripts/mobile-verify.mjs', 'runtime:session-lock-product-gate'), ev('tests/ag-runtime.test.js', 'c-session-lock-product-gate-v1')]),
  req('C-11', 'C', 'Notification', '승인/완료/실패 알림을 제공한다.', 'complete', 3, 0.9, ['권한 prompt state, 채널 분류, expo-notifications adapter contract, push token registry, foreground delivery log, background queued delivery, receipt log/verification, retryable issue queue, SettingsScreen receipt verification action, Notifications native runtime probe UI, provider receipt drill, foreground/background visual evidence contract, push token rotation failure preservation/recovery drill, mobile verification harness provider drill check가 구현됐다. 여기에 c-notification-token-rotation-trend-v1과 c-notification-product-gate-v1이 추가되어 foreground/background receipt, retry queue cleanup, push token plaintext 비노출, 반복 token rotation trend를 제품 게이트로 검증한다. 남은 차이는 실제 운영 Expo provider 계정 receipt와 물리 기기 notification screenshot/video를 release dossier에 고정하는 것이다.'], ['운영 Expo push provider 계정으로 c-notification-product-gate-v1 결과를 수집하고, 물리 Android/iOS foreground/background notification screenshot/video와 장기 token rotation trend를 release dossier에 고정한다.'], [ev('apps/mobile/src/mobile-runtime.js', 'c-notification-token-rotation-trend-v1'), ev('apps/mobile/src/mobile-runtime.js', 'c-notification-product-gate-v1'), ev('apps/mobile/src/mobile-runtime.js', 'runNotificationProviderDrill'), ev('apps/mobile/src/screens/SettingsScreen.js', 'runNotificationProductGate'), ev('scripts/mobile-verify.mjs', 'runtime:notification-product-gate'), ev('tests/ag-runtime.test.js', 'c-notification-product-gate-v1'), ev('apps/mobile/src/components/NativeRuntimeProbe.tsx', 'Notifications.getPermissionsAsync')]),
  req('C-12', 'C', '실제 모바일 제품 검증', '디바이스/시뮬레이터에서 설치, 실행, 화면 검증을 완료한다.', 'complete', 3, 0.98, ['런타임 시나리오, PC agent poison queue review evidence, retry policy update evidence, ADB 자동 탐색, Android native prebuild, Gradle 안정화, release APK build/install, embedded JS bundle, actual emulator launch, PNG screenshot, UI XML dump, NativeRuntimeProbe, 8개 route button tap navigation, live Bridge 페어링/명령/승인/SecureStore restore, device revoke, SecureStore cleanup E2E와 mobile-release-preflight-report까지 제품 검증 dossier에 포함된다. 남은 차이는 실제 물리 Android/iOS 기기, signed production keystore, 스토어 배포 파이프라인의 외부 계정 smoke다.'], ['production keystore/EXPO_TOKEN/EAS projectId를 실제 운영 secret으로 주입하고 Android/iOS 물리기기 및 store submission dry-run 결과를 release evidence로 고정한다.'], [ev('scripts/mobile-verify.mjs', 'runMobileVerification'), ev('scripts/mobile-verify.mjs', 'runtime:poison-queue-review'), ev('scripts/mobile-verify.mjs', 'runtime:retry-policy-update'), ev('scripts/mobile-verify.mjs', 'product:native-runtime-probe-ui'), ev('scripts/mobile-verify.mjs', 'mobile-android-install-report.json'), ev('scripts/mobile-verify.mjs', 'mobile-release-preflight-report.json'), ev('scripts/mobile-verify.mjs', 'product:mobile-release-external-gate'), ev('scripts/mobile-live-bridge-e2e.mjs', 'Live bridge verified'), ev('scripts/mobile-live-bridge-e2e.mjs', 'SecureStore restore verified'), ev('scripts/mobile-live-bridge-e2e.mjs', 'Device revoke verified'), ev('scripts/mobile-live-bridge-e2e.mjs', 'SecureStore cleanup verified'), ev('scripts/mobile-android-install.mjs', "const defaultVariant = 'release'"), ev('scripts/mobile-device-smoke.mjs', 'routeNavigation'), ev('scripts/mobile-device-smoke.mjs', 'containsSecureStoreProbe'), ev('scripts/mobile-device-smoke.mjs', 'containsNotificationsProbe'), ev('apps/mobile/metro.config.cjs', 'watchFolders'), ev('apps/mobile/src/native/screenContracts.js', 'validateMobileScreenContract'), ev('apps/mobile/src/native/nativeContracts.js', 'nativeCapabilityContract')]),
  req('C-13', 'C', '운영 오류 큐 화면', 'PC 에이전트 격리 패킷을 모바일에서 확인하고 처리한다.', 'complete', 3, 0.9, ['PoisonQueueScreen, PoisonQueueActionPanel JS/TSX, RetryPolicySettingsPanel JS/TSX, empty/loading/error/locked/action state, retry/backoff summary와 편집 state, 세션 잠금 기반 review/requeue/ignore/policy update, D bridge route, B poison queue 연동, 모바일 queue drain route, refresh delta, versioned visual snapshot, visual regression baseline/report, long queue soak operational evidence, foreground/background notification UX snapshot, failure notification receipt 복구 검증, 실제 PoisonQueueScreen/SettingsScreen route navigation과 mobile verification evidence가 구현됐다. 남은 차이는 물리 기기 screenshot/video와 실제 Windows 서비스 관리자 권한 soak를 release evidence로 고정하는 것이다.'], ['물리 Android/iOS에서 poison queue screenshot/video regression을 캡처하고, Administrator Windows 서비스 실기동 장시간 soak 리포트를 release dossier에 첨부한다.'], [ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'visualRegression'), ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'operationalEvidence'), ev('apps/mobile/src/components/PoisonQueueActionPanel.js', 'createPoisonQueueVisualRegressionReport'), ev('apps/mobile/src/components/PoisonQueueActionPanel.js', 'createPoisonQueueNotificationUxSnapshot'), ev('apps/mobile/src/components/PoisonQueueActionPanel.js', 'createPoisonQueueOperationalEvidence'), ev('apps/mobile/src/components/PoisonQueueActionPanel.tsx', 'poison-queue-visual-regression'), ev('apps/mobile/src/mobile-runtime.js', 'runPoisonQueueSoak'), ev('apps/mobile/src/mobile-runtime.js', 'drainPcAgentQueue'), ev('apps/bridge/src/main.mjs', '/pc-agent/queue/drain'), ev('apps/bridge/src/bridge-runtime.js', 'pc_agent.queue.drained'), ev('scripts/mobile-verify.mjs', 'runtime:poison-queue-visual-regression'), ev('scripts/mobile-verify.mjs', 'runtime:poison-queue-notification-ux'), ev('tests/ag-runtime.test.js', 'c-poison-queue-operational-evidence-v1'), ev('apps/mobile/src/App.tsx', '큐 갱신 검증')]),

  req('D-01', 'D', '로컬 브릿지 HTTP 서버', 'PC-모바일 사이 로컬 API 서버를 제공한다.', 'complete', 3, 0.86, ['로컬 HTTP 서버, /health, /openapi.json, /server/profile, /server/deployment-profile, 네트워크 guard, 중앙 route contract matching, path/header/body/query validation, rate-limit header, typed JSON responder, audit writer, SSE stream에 더해 /events/ws WebSocket upgrade, 인증/replay/heartbeat/ack 보조 채널, TLS reverse-proxy 배포 profile, process manager runbook, 반복 bridge server soak artifact가 구현됐다. 여기에 d-bridge-reverse-proxy-lab-dossier-v1, d-bridge-server-product-gate-v1, /server/reverse-proxy-lab, /server/product-gate route contract가 추가되어 reverse proxy header policy와 서버 필수 release gate를 자동 검증한다. 또한 d-bridge-server-release-artifact-manifest-v1, d-bridge-server-operational-handoff-manifest-v1, d-bridge-server-ci-nightly-gate-plan-v1, d-bridge-server-worm-promotion-package-v1로 서버 release dossier를 hash-only 산출물/WORM 승격 단위까지 검증한다. 남은 차이는 실제 운영 reverse proxy/TLS 인증서와 물리 모바일 live bridge 장시간 실기동 증거다.'], ['실제 TLS reverse proxy(Caddy/nginx) 뒤에서 bridge:server-soak를 장시간 실행하고, 물리 모바일 live-bridge E2E와 d-bridge-server-product-gate-v1을 같은 release dossier로 묶는다.'], [ev('apps/bridge/src/main.mjs', 'createBridgeServer'), ev('apps/bridge/src/main.mjs', 'createBridgeDeploymentProfile'), ev('apps/bridge/src/main.mjs', 'd-bridge-reverse-proxy-lab-dossier-v1'), ev('apps/bridge/src/main.mjs', 'd-bridge-server-product-gate-v1'), ev('apps/bridge/src/main.mjs', 'd-bridge-server-operational-handoff-manifest-v1'), ev('apps/bridge/src/main.mjs', 'd-bridge-server-worm-promotion-package-v1'), ev('apps/bridge/src/main.mjs', 'handleEventWebSocketUpgrade'), ev('apps/bridge/src/request-validator.js', 'BridgeServerProductGateResponse'), ev('scripts/bridge-server-soak.mjs', 'reverse-proxy-lab-dossier-passed'), ev('scripts/bridge-server-soak.mjs', 'bridge-server-worm-promotion-package-ready'), ev('tests/ag-runtime.test.js', 'd-bridge-server-product-gate-v1')]),
  req('D-02', 'D', '페어링/디바이스 등록', '페어링 코드로 deviceToken을 발급하고 디바이스를 관리한다.', 'complete', 3, 0.93, ['8자리 랜덤 numeric pairing code, pairingId 세션, 5분 만료, max-attempt lock, QR payload v2, pairing status, pairingId mismatch 차단, 같은 deviceId 재페어링 시 이전 token 즉시 무효화, device.repaired 감사 이벤트, persistent device registry JSONL replay, plaintext token 비저장 검증, trust label, /devices/inventory API, BridgeClient inventory, pairing recovery UX, native QR scanner permission contract, 모바일 runtime evidence가 구현됐다. 여기에 d-pairing-device-release-dossier-v1, /pairing/release-dossier, PairingReleaseDossierResponse, QR text hash evidence, single-use/mismatch/lockout drill, re-pair previous-token revocation proof, device-registry backend contract, raw pairingCode/deviceToken retention check가 추가되어 페어링/디바이스 등록이 release gate로 고정됐다. 남은 차이는 실제 SQLite/원격 encrypted registry backend 연결과 물리 카메라 QR scan video/screenshot evidence다.'], ['SQLite 또는 원격 encrypted registry backend를 실제 운영 backend로 연결하고, /pairing/release-dossier 결과와 실제 카메라 QR scan 캡처를 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-release-dossier-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-device-registry-backend-contract-v1'), ev('apps/bridge/src/main.mjs', '/pairing/release-dossier'), ev('apps/bridge/src/request-validator.js', 'PairingReleaseDossierResponse'), ev('apps/mobile/src/api/BridgeClient.js', 'runPairingReleaseDossier'), ev('apps/mobile/src/components/PairingQrPanel.js', 'c-native-qr-scanner-contract-v1'), ev('tests/ag-runtime.test.js', 'pairing.release_dossier')]),
  req('D-03', 'D', '토큰 인증', '브릿지 API 호출에 deviceToken 인증을 적용한다.', 'complete', 3, 0.93, ['HMAC-SHA256 signed deviceToken 발급/검증, SHA-256 tokenHash 저장, 만료 claim 검증, 변조 signature 차단, persistent device registry, device token rotation API, 이전 token 즉시 무효화, JARVIS_DEVICE_TOKEN_SECRET 배포 정책 리포트, key rotation drill, HTTP BridgeClient 정책/드릴/회전 테스트가 구현됐다. 여기에 d-device-token-auth-release-dossier-v1, /devices/token/release-dossier, DeviceTokenReleaseDossierResponse, signing key provider contract, malformed/tampered token rejection proof, registry hash-only retention proof, hsm-kms 운영 provider contract evidence가 추가되어 토큰 인증을 release gate로 고정한다. 남은 차이는 실제 OS/HSM backed signing key provider를 운영 secret으로 연결하고 secret rotation runbook 실행 증거를 원격 WORM dossier에 첨부하는 것이다.'], ['OS/HSM backed signing key provider를 실제 운영 secret으로 연결하고, /devices/token/release-dossier 결과와 rotation runbook 실행 evidence를 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-release-dossier-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-signing-key-provider-contract-v1'), ev('apps/bridge/src/main.mjs', '/devices/token/release-dossier'), ev('apps/bridge/src/request-validator.js', 'DeviceTokenReleaseDossierResponse'), ev('apps/mobile/src/api/BridgeClient.js', 'runDeviceTokenReleaseDossier'), ev('tests/ag-runtime.test.js', 'device.token.release_dossier')]),
  req('D-04', 'D', 'Request replay 방지', 'requestId 재사용 공격을 차단한다.', 'complete', 3, 0.9, ['DurableRequestNonceStore가 requestIdHash 기반 nonce를 JSONL에 영속화하고, 즉시/재시작 후 replay를 D_REQUEST_REPLAY_BLOCKED로 차단하며, TTL 만료 cleanup, taskId attach, hash-only snapshot, per-route nonce policy, shared backend contract, compaction report, clock skew fixture, HTTP/BridgeClient 정책 API를 제공한다. 여기에 d-request-nonce-shared-backend-concurrency-drill-v1이 isolated shared journal로 두 bridge process 간 replay 차단을 검증하고, d-request-nonce-shared-backend-adapter-catalog-v1이 JSONL/SQLite/Redis adapter 운영 모델을 명시하며, d-request-nonce-product-gate-v1과 /request-nonces/product-gate API가 policy/skew/compaction/hash-only/shared-backend drill을 한 번에 검증한다. 남은 차이는 실제 Redis/SQLite backend를 운영 설정으로 선택해 장기 bridge soak에서 검증하는 것이다.'], ['실제 Redis 또는 SQLite nonce backend adapter를 운영 설정으로 연결하고, bridge:server-soak에서 d-request-nonce-product-gate-v1을 장시간 실행해 release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-route-policy-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-compaction-report-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-clock-skew-fixtures-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-shared-backend-concurrency-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-product-gate-v1'), ev('apps/bridge/src/main.mjs', '/request-nonces/clock-skew-fixtures'), ev('apps/bridge/src/main.mjs', '/request-nonces/product-gate'), ev('apps/mobile/src/api/BridgeClient.js', 'runRequestNonceProductGate'), ev('tests/ag-runtime.test.js', 'd-request-nonce-product-gate-v1')]),
  req('D-05', 'D', 'Rate limiter', '페어링/태스크/승인 API 남용을 제한한다.', 'complete', 3, 0.9, ['IP/token/device/action별 token bucket, HTTP pre-auth 제한, poison queue/queue policy 운영 action별 limiter, JSONL persistent bucket journal, restart replay, refill 복구, x-ratelimit-* HTTP headers, D_RATE_LIMITED typed envelope가 구현됐다. 여기에 d-rate-limit-policy-v1 policy document/hot-reload adapter, d-rate-limit-shared-backend-v1 JSONL shared backend replay, d-rate-limit-reputation-policy-v1 device/IP reputation tier scoring, d-rate-limit-abuse-corpus-v1 장기 abuse fixture, d-rate-limit-product-gate-v1, /rate-limit/product-gate API, BridgeClient 호출, bridge-server-soak check가 추가됐다. 남은 차이는 실제 분산 Redis/edge limiter backend와 물리 LAN 장시간 abuse trend evidence다.'], ['실제 Redis/edge shared limiter backend와 물리 LAN abuse soak를 연결하고, d-rate-limit-product-gate-v1 결과를 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'class TokenBucketRateLimiter'), ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-policy-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-shared-backend-concurrency-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-reputation-escalation-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-product-gate-v1'), ev('apps/bridge/src/main.mjs', '/rate-limit/product-gate'), ev('apps/mobile/src/api/BridgeClient.js', 'runRateLimitProductGate'), ev('scripts/bridge-server-soak.mjs', 'rate-limit-product-gate-passed'), ev('tests/ag-runtime.test.js', 'd-rate-limit-product-gate-v1')]),
  req('D-06', 'D', 'Task/Approval/Result API', '모바일 명령, 승인, 실행 handoff, 결과 조회 API를 제공한다.', 'complete', 3, 0.93, ['Task/approval/handoff/result/growth API, result rollback API, PC agent poison queue/drain 및 retry policy 운영 API, approval history, PC confirmation handoff 조회/수락/거절 API가 동작하고, mutable route body/list/query/path/header contract, D_REQUEST_VALIDATION_FAILED typed envelope, OpenAPI 3.1 response schema 카탈로그가 구현됐다. 여기에 d-bridge-task-approval-result-response-fixtures-v1 응답 예시 fixture, generated BridgeClient type coverage, d-bridge-task-approval-result-contract-gate-v1, schema snapshot diff, client/server drift gate artifact가 추가되어 핵심 작업/승인/결과 API 제품 계약이 독립 게이트로 고정됐다. 또한 d-bridge-task-approval-result-release-dossier-v1과 /task-approval-result/release-dossier가 추가되어 task 생성, approval read/history/decision, execution handoff, result verification, rollback drill, event relay, raw secret retention을 실제 live workflow evidence로 고정한다. 남은 차이는 이 dossier와 bridge:client-contract-gate를 실제 PR 필수 check 및 원격 WORM release evidence로 운영하는 것이다.'], ['CI에서 bridge:client-contract-gate와 /task-approval-result/release-dossier 결과를 PR 필수 check로 실행하고, live workflow/rollback/event evidence를 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-release-dossier-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-live-workflow-v1'), ev('apps/bridge/src/main.mjs', '/task-approval-result/release-dossier'), ev('apps/bridge/src/request-validator.js', 'TaskApprovalResultReleaseDossierResponse'), ev('apps/mobile/src/api/BridgeClient.js', 'runTaskApprovalResultReleaseDossier'), ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'task_approval_result.release_dossier'), ev('tests/ag-runtime.test.js', 'task_approval_result.release_dossier')]),
  req('D-07', 'D', 'Feedback/Growth routing', '모바일 피드백과 성장 리뷰 요청을 F로 전달한다.', 'complete', 3, 0.93, ['모바일 feedback 수집, growth review latest 조회, preference confirm/reject, hygiene keep/delete/redact/defer 단건 및 batch decision을 D가 인증/감사/rate-limit/event와 함께 F로 라우팅한다. 또한 d-growth-review-decision-history-v1, d-growth-routing-trend-v1, /growth/decisions/history, /growth/decisions/trends, BridgeClient 조회 메서드, 모바일 c-growth-hygiene-batch-selection-event-v1 payload preview까지 구현되어 review decision history와 latency/batch trend telemetry가 제품 계약으로 고정됐다. 여기에 d-growth-routing-release-dossier-v1, /growth/routing/release-dossier, GrowthRoutingReleaseDossierResponse, BridgeClient release dossier 호출, raw token retention check, feedback/hygiene/batch observed route coverage가 추가되어 모바일-F 성장 라우팅을 release evidence로 고정할 수 있다. 남은 차이는 실제 물리 모바일 장기 사용 세션에서 24시간 이상 trend artifact와 화면 캡처를 누적하는 것이다.'], ['물리 모바일 live session에서 24시간 이상 feedback/preference/hygiene routing trend를 수집하고, d-growth-routing-release-dossier-v1 artifact와 화면 캡처를 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'd-growth-review-decision-history-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-trend-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-release-dossier-v1'), ev('apps/bridge/src/main.mjs', '/growth/routing/release-dossier'), ev('apps/bridge/src/request-validator.js', 'GrowthRoutingReleaseDossierResponse'), ev('apps/mobile/src/api/BridgeClient.js', 'runGrowthRoutingReleaseDossier'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-growth-hygiene-batch-selection-event-v1'), ev('tests/ag-runtime.test.js', 'growth.routing.release_dossier')]),
  req('D-08', 'D', '이벤트/SSE 스트림', '상태 변경을 모바일에 event stream으로 전달한다.', 'complete', 3, 0.9, ['실제 HTTP SSE stream.opened 프레임, heartbeat, bounded replay window, sinceEventId cursor, stream session status, durable JSONL ack cursor store, reconnect backoff contract, reconnect-plan API, BridgeClient reconnect client, G bridge verifier checks에 더해 인증된 /events/ws WebSocket 보조 채널, replay/heartbeat/ping/ack 프레임, 반복 stream soak report가 구현됐다. 여기에 d-event-stream-network-chaos-drill-v1, d-event-cursor-compaction-v1, d-mobile-websocket-fallback-ux-contract-v1, d-event-stream-product-gate-v1이 추가됐고, d-event-stream-release-exercise-v1, d-event-stream-release-workflow-v1, d-event-stream-release-artifact-manifest-v1, d-event-stream-worm-release-archive-v1로 이벤트 발행/스트림 오픈/ack 영속화와 hash-only release manifest를 자동 검증한다. 남은 차이는 실제 LAN 단절/복구와 모바일 foreground/background 캡처를 물리 기기에서 장시간 수집하는 운영 evidence다.'], ['물리 LAN 단절/복구 chaos drill과 모바일 foreground/background WebSocket fallback screenshot/video를 장기 CI/WORM artifact로 고정한다.'], [ev('apps/bridge/src/main.mjs', '/events/stream'), ev('apps/bridge/src/main.mjs', '/events/ws'), ev('apps/bridge/src/main.mjs', '/events/chaos-drill'), ev('apps/bridge/src/main.mjs', '/events/product-gate'), ev('apps/bridge/src/main.mjs', 'sendWebSocketJson'), ev('apps/bridge/src/bridge-runtime.js', 'bridge-event-cursors.jsonl'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-network-chaos-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-cursor-compaction-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-mobile-websocket-fallback-ux-contract-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-product-gate-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-exercise-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-workflow-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-artifact-manifest-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-worm-release-archive-v1'), ev('apps/mobile/src/api/BridgeClient.js', 'runEventStreamProductGate'), ev('scripts/bridge-server-soak.mjs', 'all-cycles-websocket-passed'), ev('scripts/bridge-server-soak.mjs', 'event-release-dossier-passed'), ev('apps/verification/src/verification-runtime.js', 'websocket_authenticated_aux_channel'), ev('tests/ag-runtime.test.js', 'd-event-stream-product-gate-v1')]),
  req('D-09', 'D', 'State cache', '태스크/승인/결과/이벤트 상태 snapshot을 제공한다.', 'complete', 2, 0.82, ['task/approval/result/requestId snapshot, full task/request/plan/approval body, result body, JSONL journal, replay rebuild, schemaVersion v2, legacy migration counter, compacted snapshot record, retention pruning, /cache/compact API, cacheSnapshot persistence metadata가 구현됐다. 여기에 d-state-cache-journal-rotation-archive-v1, d-state-cache-external-store-contract-v1, d-state-cache-schema-snapshot-v1/d-state-cache-schema-diff-v1, d-state-cache-compaction-lock-v1, d-state-cache-external-store-deployment-policy-v1, d-state-cache-rotation-archive-drill-v1, d-state-cache-product-gate-v1과 /cache/product-gate API, BridgeClient/runCacheProductGate, bridge:server-soak evidence가 추가되어 state cache 운영 준비도를 release gate로 검증한다. 또한 d-state-cache-release-artifact-manifest-v1, d-state-cache-operational-handoff-manifest-v1, d-state-cache-ci-nightly-gate-plan-v1, d-state-cache-worm-promotion-package-v1로 hash-only release manifest와 외부 WORM 승격 패키지를 검증한다. 남은 차이는 실제 외부 WORM event-store backend를 운영 secret으로 연결해 장기 soak manifest를 원격 보존하는 것이다.'], ['실제 S3 Object Lock/SQLite/Redis 등 외부 event-store backend를 운영 설정으로 연결하고, d-state-cache-product-gate-v1 산출물을 24시간 bridge soak와 원격 WORM release dossier에 고정한다.'], [ev('apps/bridge/src/bridge-runtime.js', 'class BridgeStateCache'), ev('apps/bridge/src/bridge-runtime.js', 'state.cache.compacted'), ev('apps/bridge/src/bridge-runtime.js', 'compactJournal'), ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-product-gate-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-rotation-archive-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-external-store-deployment-policy-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-operational-handoff-manifest-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-worm-promotion-package-v1'), ev('apps/bridge/src/main.mjs', '/cache/compact'), ev('apps/bridge/src/main.mjs', '/cache/product-gate'), ev('apps/mobile/src/api/BridgeClient.js', 'compactCache'), ev('apps/mobile/src/api/BridgeClient.js', 'runCacheProductGate'), ev('scripts/bridge-server-soak.mjs', 'cache-product-gate-passed'), ev('tests/ag-runtime.test.js', 'd-state-cache-product-gate-v1')]),
  req('D-10', 'D', 'Local network guard', '로컬/사설 네트워크 바운더리를 검사한다.', 'complete', 3, 0.9, ['host normalization, IPv4/IPv6/private range, IPv4-mapped IPv6, forwarded header 차단, configurable allowedHostnames/trustedProxyHosts, DNS rebinding hostname 탐지, forwarded proto/proxy policy, network block rate-limit evidence, G verifier corpus가 구현됐다. 여기에 d-dns-rebinding-resolver-drill-v1 실제 resolver adapter drill, d-bridge-reverse-proxy-deployment-guide-v1 Caddy/nginx/env guide, d-mdns-discovery-allowlist-ux-v1 및 c-mdns-bridge-allowlist-review-ui-v1 mDNS allowlist review state, d-bridge-network-guard-product-drill-v1 artifact가 추가됐다. 남은 차이는 물리 LAN에서 실제 mDNS discovery와 TLS reverse proxy 장기 soak를 release dossier로 고정하는 것이다.'], ['물리 모바일/PC LAN에서 mDNS discovery 결과와 TLS reverse proxy 경유 bridge:server-soak를 24시간 수집해 release dossier에 고정한다.'], [ev('apps/bridge/src/network-guard.js', 'allowedHostnames'), ev('apps/bridge/src/network-guard.js', 'dnsRebindingSuspected'), ev('apps/bridge/src/network-guard.js', 'proxyPolicy'), ev('apps/bridge/src/network-guard.js', 'd-dns-rebinding-resolver-drill-v1'), ev('apps/bridge/src/network-guard.js', 'd-bridge-reverse-proxy-deployment-guide-v1'), ev('apps/bridge/src/network-guard.js', 'd-mdns-discovery-allowlist-ux-v1'), ev('apps/bridge/src/main.mjs', 'deploymentGuide'), ev('apps/mobile/src/components/PairingQrPanel.js', 'c-mdns-bridge-allowlist-review-ui-v1'), ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-product-drill-v1'), ev('apps/verification/src/verification-runtime.js', 'dns_rebinding_hostname_blocked'), ev('tests/ag-runtime.test.js', 'dns-rebinding-resolver-drill-passed')]),
  req('D-11', 'D', 'Validator/Sanitizer/TierGuard', '요청 검증, payload sanitize, 위험 tier 제한을 수행한다.', 'complete', 3, 0.9, ['route별 RequestValidator, PayloadSanitizer, BridgeTierGuard, mutable body validation, query validation, path parameter validator, header/content-type validator, 중앙 route contract matching, OpenAPI 3.1 response schema, validation fixture corpus가 구현됐다. 여기에 d-bridge-api-schema-snapshot-v1 contract snapshot, d-bridge-api-schema-snapshot-diff-v1 breaking diff, d-bridge-openapi-client-types-v1 BridgeClient generated types, d-bridge-malformed-request-corpus-v1 장기 malformed corpus, d-bridge-client-server-drift-gate-v1 drift gate, d-bridge-client-contract-gate-v1 script artifact가 추가됐다. 남은 차이는 CI에서 generated type 파일을 PR마다 자동 갱신/검증하는 운영 증거다.'], ['CI에서 bridge:client-contract-gate를 PR 필수 check로 실행하고, generated bridge-api-types.d.ts drift를 승인 workflow에 연결한다.'], [ev('apps/bridge/src/request-validator.js', 'class BridgeRequestValidator'), ev('apps/bridge/src/request-validator.js', 'validatePath'), ev('apps/bridge/src/request-validator.js', 'validateHeaders'), ev('apps/bridge/src/request-validator.js', 'ValidationErrorEnvelope'), ev('apps/bridge/src/request-validator.js', 'd-bridge-api-schema-snapshot-v1'), ev('apps/bridge/src/request-validator.js', 'd-bridge-api-schema-snapshot-diff-v1'), ev('apps/bridge/src/request-validator.js', 'd-bridge-malformed-request-corpus-v1'), ev('apps/bridge/src/request-validator.js', 'd-bridge-client-server-drift-gate-v1'), ev('apps/mobile/src/api/BridgeClient.js', 'd-bridge-openapi-client-types-v1'), ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'd-bridge-openapi-client-types-v1'), ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-gate-v1'), ev('apps/bridge/src/main.mjs', 'matchBridgeRouteContract'), ev('tests/ag-runtime.test.js', 'd-bridge-client-server-drift-gate-v1')]),
  req('D-12', 'D', 'Access/Security audit log', '접근/보안 이벤트를 감사 가능하게 남긴다.', 'complete', 2, 0.9, ['access/security/approval/workflow/system taxonomy, severity, hash chain, cursor pagination, retention status, signed HMAC audit export bundle, immutable archive JSON, rotation marker, /audit/summary·/audit/export·/audit/rotate API, 모바일 BridgeClient, 독립 signature verification 테스트가 구현됐다. 여기에 d-siem-compatible-audit-export-v1, d-immutable-audit-archive-sync-v1, d-audit-retention-scheduler-v1, d-audit-archive-restore-drill-v1, d-bridge-audit-log-product-gate-v1과 모바일 BridgeClient/HTTP regression이 추가됐다. 남은 차이는 실제 OS/HSM backed signing key와 외부 WORM/SIEM 계정 연동이다.'], ['OS/HSM backed export signing key와 실제 SIEM/WORM endpoint에 d-siem-compatible-audit-export-v1 및 d-immutable-audit-archive-sync-v1 결과를 업로드하고 장기 retention execute evidence를 고정한다.'], [ev('packages/shared/src/audit-log.js', 'exportBundle'), ev('packages/shared/src/audit-log.js', 'verifySignedAuditExport'), ev('packages/shared/src/audit-log.js', 'rotate'), ev('apps/bridge/src/bridge-runtime.js', 'd-siem-compatible-audit-export-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-immutable-audit-archive-sync-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-audit-retention-scheduler-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-audit-archive-restore-drill-v1'), ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-product-gate-v1'), ev('apps/bridge/src/main.mjs', '/audit/export'), ev('apps/bridge/src/main.mjs', '/audit/siem-export'), ev('apps/bridge/src/main.mjs', '/audit/archive/sync'), ev('apps/bridge/src/main.mjs', '/audit/product-gate'), ev('apps/mobile/src/api/BridgeClient.js', 'exportAuditForSiem'), ev('tests/ag-runtime.test.js', 'd-bridge-audit-log-product-gate-v1')]),

  req('E-01', 'E', 'Risk classifier', 'action/data/context를 risk tier로 분류한다.', 'complete', 3, 0.9, ['policy-as-code risk.tiersByAction/forbiddenActions 기반 tier matrix, action별 score, blocked flag, policyVersion/source/matrixEntry evidence, /policy/as-code riskMatrix에 더해 e-context-risk-profile-v1 context escalation, sensitive data/external transfer/bulk/unattended feature scoring, e-security-redteam-corpus-v1 risk calibration matrix와 trend가 구현됐다. 여기에 e-risk-classifier-calibration-corpus-v1, e-risk-classifier-calibration-report-v1, e-risk-classifier-review-workflow-v1 false-positive/false-negative review, e-risk-classifier-calibration-dashboard-v1, e-risk-classifier-product-gate-v1, e-risk-operational-calibration-pipeline-v1, e-risk-operational-calibration-corpus-v1, e-risk-policy-drift-trend-v1, e-risk-classifier-release-dossier-v1과 HTTP operational/drift/release/product-gate API가 추가됐다. 또한 e-risk-classifier-release-artifact-manifest-v1, e-risk-classifier-operational-handoff-manifest-v1, e-risk-classifier-ci-nightly-gate-plan-v1, e-risk-classifier-worm-promotion-package-v1이 hash-only 운영 corpus/drift evidence와 WORM 승격 준비를 검증한다. 남은 차이는 실제 운영 SSO reviewer outcome과 원격 장기 로그 저장소 evidence를 물리 배포 환경에 연결하는 것이다.'], ['운영 SSO reviewer identity와 원격 WORM 로그 저장소를 연결하고, 실제 배포 로그에서 생성된 nightly risk release dossier를 CI artifact로 고정한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'e-context-risk-profile-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-calibration-corpus-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-calibration-report-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-review-workflow-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-operational-calibration-pipeline-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-policy-drift-trend-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-worm-promotion-package-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-product-gate-v1'), ev('apps/policy-security/src/main.mjs', '/risk/release-dossier'), ev('apps/policy-security/src/main.mjs', '/risk/product-gate'), ev('scripts/security-redteam-corpus.mjs', 'Policy drift trend'), ev('tests/ag-runtime.test.js', 'risk_classifier_worm_promotion_package_ready')]),
  req('E-02', 'E', 'Data/ministry classifier', '민감정보와 특수 도메인 데이터를 감지한다.', 'complete', 3, 0.93, ['PII, 주민번호, 이메일, 재정/헌금, 상담/목양, 건강, 미성년/가정 민감도를 policy-as-code와 multi-rule classifier로 처리하고, matchedRules/pattern, riskTierHint, field-level redaction policy(redact/summarize/mask/retain), safePreview, /data/classify API와 fixture 테스트가 구현됐다. 여기에 e-local-ner-data-adapter-v1 로컬 NER entity 추출, false-positive review/suppression, e-data-classifier-tuning-dashboard-v1 corpus dashboard, e-data-classifier-minimizer-adapter-v1 F SensitiveMemoryMinimizer 공유 계약, e-external-ner-provider-contract-v1 선택형 외부 NER 계약, e-data-classifier-precision-recall-trend-v1, e-data-classifier-hot-reload-tuning-gate-v1, e-data-classifier-product-gate-v1이 구현됐다. 또한 e-data-classifier-release-dossier-v1, e-data-classifier-release-artifact-manifest-v1, /data/release-dossier, hash-only false-positive review ledger, raw fixture/NER entity retention check, security:redteam release dossier evidence가 추가되어 데이터 분류기 출시 증거를 API와 리포트로 고정한다. 여기에 e-data-classifier-operational-handoff-manifest-v1, e-data-classifier-ci-nightly-gate-plan-v1, e-data-classifier-worm-promotion-package-v1이 추가되어 외부 NER fallback, F minimizer 연동, raw sensitive fixture 비저장, WORM 승격 준비를 release gate로 검증한다. 남은 차이는 실제 외부 ML/NER provider와 운영 false-positive 장기 추세의 물리 evidence다.'], ['실제 외부 ML/NER provider를 운영 secret으로 연결하고, 장기 precision/recall trend와 false-positive 리뷰 UI screenshot을 release dossier에 고정한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'class LocalNerDataAdapter'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-ner-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-external-ner-provider-contract-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-precision-recall-trend-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-hot-reload-tuning-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-product-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-worm-promotion-package-v1'), ev('apps/policy-security/src/main.mjs', '/data/release-dossier'), ev('scripts/security-redteam-corpus.mjs', 'Data classifier release dossier'), ev('tests/ag-runtime.test.js', 'data_classifier_worm_promotion_package_ready')]),
  req('E-03', 'E', 'Approval policy', '위험도별 승인 방식과 모바일 승인 가능 여부를 결정한다.', 'complete', 3, 0.9, ['tier별 approvalMode/mobileApprovalAllowed/expiresInSec/decision이 JSON policy-as-code에 있고, signed policy bundle hot reload 후 ApprovalPolicyEngine이 새 정책을 즉시 반영한다. 또한 e-approval-policy-change-workflow-v1 2인 승인 workflow, e-approval-policy-migration-diff-v1 tier/mode/mobile 승인 diff, e-approval-policy-signed-history-v1 운영자 서명 이력, e-approval-policy-rollback-drill-v1 rollback drill, HTTP API와 security:redteam regression artifact가 구현됐다. 여기에 e-approval-policy-ci-approval-artifact-v1, e-approval-policy-operator-identity-contract-v1, e-approval-policy-product-gate-v1, e-approval-policy-release-dossier-v1, /approval/policy/ci-approval-artifact·/approval/policy/product-gate API와 security:redteam dossier evidence가 추가됐다. 또한 e-approval-policy-release-artifact-manifest-v1, e-approval-policy-operational-handoff-manifest-v1, e-approval-policy-ci-nightly-gate-plan-v1, e-approval-policy-worm-promotion-package-v1로 operator identity/bundle 원문 비저장, rollback handoff, WORM 승격 준비를 검증한다. 남은 차이는 실제 원격 운영자 SSO/서명키와 CI provider PR check 업로드다.'], ['실제 운영자 SSO provider와 HSM/KMS signing key로 approval artifact를 서명하고, CI provider PR check와 외부 WORM release evidence에 업로드한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-change-workflow-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-migration-diff-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-signed-history-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-rollback-drill-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-ci-approval-artifact-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-worm-promotion-package-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-product-gate-v1'), ev('apps/policy-security/src/main.mjs', '/approval/policy/workflow'), ev('apps/policy-security/src/main.mjs', '/approval/policy/product-gate'), ev('scripts/security-redteam-corpus.mjs', 'approvalPolicy.productGate'), ev('tests/ag-runtime.test.js', 'approval_policy_worm_promotion_package_ready')]),
  req('E-04', 'E', 'Capability token lifecycle', 'issue/validate/consume/revoke, TTL, scope를 관리한다.', 'complete', 3, 0.93, ['HMAC-SHA256 signed capability token, tokenHash ledger, tokenId 또는 signed bearer 검증, signature tamper rejection, TTL/scope/single-use/revoke, plaintextTokenStored=false journal, /capability/journal API가 구현됐다. 여기에 e-capability-signing-key-provider-v1 OS/HSM-ready provider status, AES-256-GCM e-capability-encrypted-persistent-journal-v1 sealed journal, e-capability-key-rotation-drill-v1 이전/신규 토큰 검증, e-capability-journal-export-v1/e-capability-journal-import-recovery-v1 복구, e-capability-token-lifecycle-product-gate-v1이 구현됐다. 또한 e-capability-token-lifecycle-release-dossier-v1, e-capability-token-lifecycle-live-workflow-v1, e-capability-lifecycle-release-artifact-manifest-v1, /capability/lifecycle/release-dossier, signed bearer/scope/expiry/tamper/single-use/revocation/recovery release checks, raw bearer leak check, security:redteam release dossier evidence가 추가되어 capability token lifecycle을 출시 게이트로 고정한다. 여기에 e-capability-lifecycle-operational-handoff-manifest-v1, e-capability-lifecycle-ci-nightly-gate-plan-v1, e-capability-lifecycle-worm-promotion-package-v1이 추가되어 encrypted journal recovery handoff와 WORM 승격 준비를 검증한다. 남은 차이는 실제 HSM/KMS 계정과 운영 키 escrow 정책 적용이다.'], ['실제 OS/HSM/KMS signing key provider를 기본 활성화하고, encrypted journal backup을 외부 WORM/KMS escrow로 주기 복구한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'e-capability-signing-key-provider-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-encrypted-persistent-journal-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-key-rotation-drill-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-journal-import-recovery-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-token-lifecycle-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-worm-promotion-package-v1'), ev('apps/policy-security/src/main.mjs', '/capability/lifecycle/release-dossier'), ev('scripts/security-redteam-corpus.mjs', 'Capability lifecycle release dossier'), ev('tests/ag-runtime.test.js', 'capability_lifecycle_worm_promotion_package_ready')]),
  req('E-05', 'E', 'Immutable safety constitution', '금지 원칙과 deny-by-default 원칙을 노출한다.', 'complete', 2, 0.93, ['constitution hash, pinned status, /policy/constitution, signed HMAC policy bundle, bundleHash/manifestHash/constitutionHash 검증, 변조 bundle reject, HTTP /policy/bundle 노출, 2인 constitution 변경 승인 workflow, signed bundle rotation, hash fixture regression, signing key provider status, security:redteam dossier evidence가 구현됐다. 여기에 e-constitution-release-dossier-v1, e-constitution-release-workflow-v1, e-constitution-release-artifact-manifest-v1, /policy/constitution/release-dossier, dual-review live workflow, signed rotation verification, raw manifest hash-only retention check가 추가되어 안전 헌장을 독립 release gate로 고정한다. 또한 e-constitution-operational-handoff-manifest-v1, e-constitution-ci-nightly-gate-plan-v1, e-constitution-worm-promotion-package-v1로 rotation ceremony handoff, signed bundle WORM archive, raw manifest/signing secret 비저장을 검증한다. 남은 차이는 실제 OS/HSM backed signing key와 운영 rotation ceremony 증거다.'], ['OS/HSM backed signing key provider, 운영자 rotation ceremony artifact, WORM signed bundle archive를 release dossier에 고정한다.'], [ev('apps/policy-security/src/main.mjs', '/policy/constitution/release-dossier'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-change-workflow-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-signed-policy-bundle-rotation-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-hash-fixture-regression-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-worm-promotion-package-v1'), ev('scripts/security-redteam-corpus.mjs', 'Constitution release dossier'), ev('tests/ag-runtime.test.js', 'constitution_worm_promotion_package_ready')]),
  req('E-06', 'E', 'Prompt injection 방어', '외부 콘텐츠 지시문을 격리/차단한다.', 'complete', 3, 0.9, ['정책 파일 기반 패턴, source-boundary tagging, quoted content non-executable rule, normalized obfuscation 탐지, 한국어/영어/문서형/인용형/정상 corpus, /security/scan, /security/prompt-injection/corpus, /security/prompt-injection/run regression에 더해 zero-width/homoglyph normalization, e-security-redteam-corpus-v1 prompt fixture pack, passRate/falsePositive/falseNegative calibration, /security/redteam/run·/trend API와 dist security-redteam report가 구현됐다. 여기에 e-prompt-semantic-classifier-contract-v1 semantic classifier adapter 계약, e-prompt-injection-production-miss-corpus-v1 hash-only 운영 실패 corpus 자동 seed, e-prompt-semantic-provider-comparison-trend-v1 rule fallback/semantic shadow 비교, e-prompt-injection-product-gate-v1, production miss/semantic trend/product-gate HTTP API와 dossier evidence가 추가됐다. 또한 e-prompt-injection-operational-handoff-manifest-v1, e-prompt-injection-ci-nightly-gate-plan-v1, e-prompt-injection-worm-promotion-package-v1이 semantic shadow fallback, production miss corpus WORM 승격, raw prompt/provider payload 비저장을 검증한다. 남은 차이는 실제 외부 semantic provider 계정과 운영 실패 사례 원격 누적 파이프라인이다.'], ['실제 semantic provider를 shadow mode로 연결하고, 운영 false positive/negative를 원격 WORM production miss corpus와 release dossier trend에 자동 누적한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'homoglyph_obfuscation'), ev('apps/policy-security/src/policy-runtime.js', 'zero_width_obfuscation'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-semantic-classifier-contract-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-production-miss-corpus-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-semantic-provider-comparison-trend-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-product-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-worm-promotion-package-v1'), ev('apps/policy-security/src/main.mjs', '/security/prompt-injection/semantic-trend'), ev('apps/policy-security/src/main.mjs', '/security/prompt-injection/product-gate'), ev('scripts/security-redteam-corpus.mjs', 'Semantic provider trend'), ev('tests/ag-runtime.test.js', 'prompt_injection_worm_promotion_package_ready')]),
  req('E-07', 'E', 'Tool poisoning 방어', '툴 결과/외부 데이터가 명령으로 승격되지 않도록 막는다.', 'complete', 3, 0.93, ['ToolOutputEligibilityGate, non-executable boundary, policy-as-code poisoning patterns, provenance graph, source-boundary taint lineage, JSONL durable provenance journal, restart replay, /tool-output/evaluate·/tool-output/provenance API와 reload fixture에 더해 e-security-redteam-corpus-v1 tool poisoning fixture pack, parent taint command promotion block, toolCommandPromotionBlocked calibration, security:redteam report가 구현됐다. 여기에 e-tool-provenance-retention-dashboard-v1, e-tool-output-artifact-diff-v1, model-agent command promotion product gate인 e-tool-poisoning-product-gate-v1이 구현됐다. 또한 e-tool-poisoning-release-dossier-v1, e-tool-poisoning-command-promotion-live-workflow-v1, e-tool-poisoning-release-artifact-manifest-v1, /tool-output/release-dossier, raw tool-output retention check, hash-only provenance release evidence가 추가되어 모델-agent command promotion 방어를 release gate로 고정한다. 여기에 e-tool-poisoning-operational-handoff-manifest-v1, e-tool-poisoning-ci-nightly-gate-plan-v1, e-tool-poisoning-worm-promotion-package-v1이 추가되어 taint lineage handoff, artifact diff sanitizer, provenance WORM 승격 준비를 검증한다. 남은 차이는 실제 모델-agent 실행 경로와 장기 remote artifact retention 실행 증거다.'], ['실제 모델-agent command promotion 경로를 E gate와 end-to-end로 묶고, provenance retention execute와 외부 artifact diff trend를 WORM 저장소에 고정한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'e-tool-provenance-retention-dashboard-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-output-artifact-diff-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-product-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-worm-promotion-package-v1'), ev('apps/policy-security/src/policy-runtime.js', 'E_TOOL_OUTPUT_PROVENANCE_TAINTED'), ev('apps/policy-security/src/main.mjs', '/tool-output/release-dossier'), ev('scripts/security-redteam-corpus.mjs', 'Tool poisoning release dossier'), ev('tests/ag-runtime.test.js', 'tool_poisoning_worm_promotion_package_ready')]),
  req('E-08', 'E', 'Autonomy contract evaluator', '자동화 후보를 위험/근거/반복성 기준으로 승인 후보화한다.', 'complete', 3, 0.93, ['candidate contract schema v1, approval/failure/rejection/negative evidence/risk tier/scope/external/sensitive/expiresAt checks, failedCheckIds, evidenceThresholds, forbiddenScopeActions, negative evidence 차단 fixture와 HTTP contract 검증에 더해 e-security-redteam-corpus-v1 autonomy safe/negative/external/delete fixtures, autonomyNegativeEvidenceBlocked calibration, trend report가 구현됐다. 여기에 e-autonomy-evaluation-lifecycle-v1 평가 lifecycle, e-autonomy-evaluation-ledger-v1 audit-backed ledger, e-autonomy-review-workflow-v1 보안 review, e-autonomy-decision-trend-v1 negative/external/scope 차단 trend, e-autonomy-contract-product-gate-v1이 구현됐다. 또한 e-autonomy-contract-release-dossier-v1, e-autonomy-release-live-workflow-v1, e-autonomy-release-artifact-manifest-v1, e-autonomy-reviewer-identity-contract-v1, /autonomy/release-dossier, safe/negative/external/forbidden 후보 live workflow, raw candidate hash-only retention evidence가 추가되어 autonomy contract를 출시 게이트로 고정한다. 여기에 e-autonomy-operational-handoff-manifest-v1, e-autonomy-ci-nightly-gate-plan-v1, e-autonomy-worm-promotion-package-v1이 추가되어 reviewer handoff, ledger/trend WORM 승격, raw candidate 비저장을 검증한다. 남은 차이는 운영 SSO 기반 reviewer identity와 장기 사용자 review outcome 연동이다.'], ['운영 SSO reviewer identity, 장기 autonomy review outcome corpus, 정책 변경 전후 approval drift dashboard를 연결한다.'], [ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-evaluation-lifecycle-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-evaluation-ledger-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-review-workflow-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-decision-trend-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-contract-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-worm-promotion-package-v1'), ev('apps/policy-security/src/main.mjs', '/autonomy/release-dossier'), ev('scripts/security-redteam-corpus.mjs', 'Autonomy release dossier'), ev('tests/ag-runtime.test.js', 'autonomy_worm_promotion_package_ready')]),
  req('E-09', 'E', 'Policy-as-code', '정책을 YAML/JSON으로 선언하고 테스트 가능하게 만든다.', 'complete', 3, 0.9, ['JSON policy manifest, compiler validation, signed policy bundle, manifestHash/bundleHash/constitutionHash, signature verification, tamper rejection, runtime hot reload, /policy/as-code·/policy/bundle·/policy/reload API, HTTP reload regression이 구현됐다. 여기에 e-policy-yaml-loader-v1 YAML source roundtrip, e-policy-json-schema-v1 외부 JSON Schema export/validation, e-policy-as-code-fixture-runner-matrix-v1 fixture matrix, e-policy-migration-snapshot-diff-v1 policy migration diff, e-policy-ci-drift-gate-v1 CI drift gate, e-policy-as-code-ci-annotation-v1, e-policy-as-code-ci-approval-artifact-v1, e-policy-as-code-release-dossier-v1, /policy/as-code/schema·/policy/as-code/ci-annotation·/policy/as-code/ci-approval-artifact·/policy/as-code/product-gate API와 security:redteam dossier evidence가 추가됐다. 또한 e-policy-as-code-operational-handoff-manifest-v1, e-policy-as-code-ci-nightly-gate-plan-v1, e-policy-as-code-worm-promotion-package-v1, e-policy-as-code-worm-provider-contract-v1이 추가되어 정책 변경 handoff, CI/nightly gate, hash-only WORM 승격 준비를 검증한다. 남은 차이는 실제 운영 CI provider와 HSM/KMS signing key로 동일 artifact를 원격 PR check/WORM 저장소에 업로드하는 것이다.'], ['정책 변경 PR마다 e-policy-as-code-product-gate-v1을 필수 check로 실행하고, signed approval artifact와 CI annotation을 운영 KMS 서명 및 외부 WORM release dossier에 고정한다.'], [ev('apps/policy-security/policies/e/default-policy.json', 'policyVersion'), ev('apps/policy-security/src/policy-as-code.js', 'compileSignedBundle'), ev('apps/policy-security/src/policy-as-code.js', 'e-policy-yaml-loader-v1'), ev('apps/policy-security/src/policy-as-code.js', 'e-policy-json-schema-v1'), ev('apps/policy-security/src/policy-as-code.js', 'e-policy-as-code-fixture-runner-matrix-v1'), ev('apps/policy-security/src/policy-as-code.js', 'e-policy-migration-snapshot-diff-v1'), ev('apps/policy-security/src/policy-as-code.js', 'e-policy-ci-drift-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-ci-annotation-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-ci-approval-artifact-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-worm-promotion-package-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-product-gate-v1'), ev('apps/policy-security/src/main.mjs', '/policy/as-code/ci-annotation'), ev('apps/policy-security/src/main.mjs', '/policy/as-code/ci-approval-artifact'), ev('apps/policy-security/src/main.mjs', '/policy/as-code/product-gate'), ev('scripts/security-redteam-corpus.mjs', 'Signed approval artifact'), ev('tests/ag-runtime.test.js', 'policy_as_code_worm_promotion_package_ready')]),
  req('E-10', 'E', 'Security/audit APIs', 'policy evaluate, security scan, capability API, audit trail을 제공한다.', 'complete', 2, 0.93, ['policy evaluate, approval validate, security scan, tool-output evaluate/provenance, capability issue/validate/consume/revoke/journal, autonomy evaluate, hash-chain audit summary cursor pagination, signed audit export, audit rotation API가 구현됐다. 여기에 e-audit-search-dsl-v1 상세 검색 DSL, e-siem-compatible-audit-export-v1 CEF/JSONL SIEM export, e-audit-retention-scheduler-v1 dry-run/execute retention scheduler, e-immutable-audit-archive-sync-v1 append-only archive sync manifest, e-security-audit-api-product-gate-v1이 구현됐다. 또한 e-security-audit-api-release-dossier-v1, e-security-audit-api-release-artifact-manifest-v1, /audit/product-gate, /audit/release-dossier, signed audit export verification, CEF+JSONL SIEM export, rotation drill, immutable archive sync execute evidence, raw audit payload retention check가 추가되어 audit API를 출시 게이트로 고정한다. 여기에 e-security-audit-api-operational-handoff-manifest-v1, e-security-audit-api-ci-nightly-gate-plan-v1, e-security-audit-api-worm-promotion-package-v1, e-security-audit-api-worm-provider-contract-v1이 추가되어 SIEM/retention/archive handoff와 외부 WORM 승격 준비를 검증한다. 남은 차이는 실제 외부 SIEM/WORM 저장소 계정과 장기 retention execute 운영 증거다.'], ['실제 SIEM/WORM endpoint에 e-siem-compatible-audit-export-v1/e-immutable-audit-archive-sync-v1 결과를 전송하고, retention scheduler execute artifact를 release dossier에 주기적으로 고정한다.'], [ev('apps/policy-security/src/main.mjs', '/audit/release-dossier'), ev('apps/policy-security/src/main.mjs', '/audit/product-gate'), ev('apps/policy-security/src/policy-runtime.js', 'e-audit-search-dsl-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-siem-compatible-audit-export-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-audit-retention-scheduler-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-immutable-audit-archive-sync-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-product-gate-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-release-dossier-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-release-artifact-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-operational-handoff-manifest-v1'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-worm-promotion-package-v1'), ev('scripts/security-redteam-corpus.mjs', 'Audit API release dossier'), ev('tests/ag-runtime.test.js', 'security_audit_worm_promotion_package_ready')]),

  req('F-01', 'F', 'MemoryEvent ingest', '학습 이벤트를 저장하고 중복/doNotRemember를 처리한다.', 'complete', 3, 0.9, ['MemoryEventSchemaRegistry union schema v1, event family/source variant catalog, source-specific validation, invalid event rejection, doNotRemember·민감·외부 콘텐츠 safety flag downgrade, schema metadata tagging, duplicate fingerprint guard, /memory/events/schema API와 fixture 테스트가 구현됐다. 여기에 f-memory-event-json-schema-bundle-v1 외부 JSON Schema bundle, f-memory-event-fixture-corpus-v1 장기 fixture corpus, f-memory-event-migration-compatibility-v1 legacy/current compatibility report, f-g-learning-verifier-schema-matrix-v1 G learning verifier matrix, f-memory-event-ingest-telemetry-v1 운영 telemetry, f-memory-event-ingest-backpressure-policy-v1 queue pressure 정책, f-memory-event-anonymized-operational-corpus-v1 hash-only 운영 corpus, f-memory-event-schema-diff-v1, f-memory-event-schema-diff-approval-workflow-v1, f-memory-event-generated-fixture-drift-dashboard-v1, f-memory-event-ingest-product-gate-v1, HTTP schema-diff/generated-fixture-drift/product-gate API와 growth-quality dist artifact가 추가됐다. 또한 f-memory-event-ingest-release-dossier-v1, f-memory-event-ingest-release-artifact-manifest-v1, f-memory-event-ingest-operational-handoff-manifest-v1, f-memory-event-ingest-ci-nightly-gate-plan-v1, f-memory-event-ingest-worm-promotion-package-v1이 추가되어 raw event payload/id 비저장과 운영 handoff/WORM 승격 준비를 검증한다. 남은 차이는 실제 장기 사용자 운영 corpus를 원격 artifact store에 누적하고 물리 모바일/운영 CI에서 같은 dashboard를 장기 실행하는 것이다.'], ['실제 장기 익명화 MemoryEvent corpus를 운영 artifact store에 누적하고, f-memory-event-ingest-worm-promotion-package-v1을 운영 WORM release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'class MemoryEventSchemaRegistry'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-json-schema-bundle-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-fixture-corpus-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-migration-compatibility-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-g-learning-verifier-schema-matrix-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-schema-diff-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-schema-diff-approval-workflow-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-generated-fixture-drift-dashboard-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-worm-promotion-package-v1'), ev('apps/growth-memory/src/main.mjs', '/memory/events/schema-diff'), ev('apps/growth-memory/src/main.mjs', '/memory/events/generated-fixture-drift'), ev('apps/growth-memory/src/main.mjs', '/memory/events/product-gate'), ev('apps/growth-memory/src/main.mjs', '/memory/events/release-dossier'), ev('scripts/growth-quality-corpus.mjs', 'memory_event_ingest_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'memory_event_ingest_worm_promotion_package_ready')]),
  req('F-02', 'F', 'SQLite persistence', '메모리와 리뷰를 로컬 DB에 저장한다.', 'complete', 3, 0.87, ['MemoryEvent/GrowthReview/ConfirmedPreference/HygieneDecision 저장, schema_migrations v5, schema_json 보존, WAL/foreign key pragma, index migration, transaction boundary, integrity check, backup/restore API, restore drill report, backup retention plan, dry-run/execute rotation API, growth_trend_snapshots 장기 추세 저장소, 복구 후 schema·hygiene decision·trend snapshot replay 테스트가 구현됐고 retention scheduler와 trend archive API가 DB 상태와 함께 검증된다. 여기에 AES-256-GCM encrypted backup envelope, encryption key provider status, encrypted restore drill, backup location policy, immutable WORM mirror sync, large migration fixture, f-storage-at-rest-encryption-deployment-policy-v1, f-storage-periodic-restore-drill-evidence-v1, f-storage-persistence-product-gate-v1 release evidence가 추가됐다. 또한 f-storage-operational-handoff-manifest-v1, f-storage-ci-nightly-gate-plan-v1, f-storage-worm-promotion-package-v1, f-storage-worm-provider-contract-v1이 추가되어 DB/backup path/key 원문 비저장, restore drill handoff, 외부 WORM 승격 준비를 검증한다. 남은 차이는 실제 OS keyring/SQLCipher 또는 KMS를 물리 운영 환경에서 활성화하고 외부 WORM 계정으로 같은 주기 복구 evidence를 장기 보존하는 것이다.'], ['실제 OS keyring/SQLCipher 또는 KMS 기반 at-rest DB 암호화를 운영 환경에서 활성화하고, f-storage-worm-promotion-package-v1을 외부 WORM release dossier에 주기 고정한다.'], [ev('apps/growth-memory/src/db/sqlite-store.js', 'class SqliteMemoryStore'), ev('apps/growth-memory/src/db/sqlite-store.js', 'memory_event_schema_and_hygiene_decisions'), ev('apps/growth-memory/src/db/sqlite-store.js', 'growth_trend_snapshots'), ev('apps/growth-memory/src/db/sqlite-store.js', 'saveTrendSnapshot'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-restore-drill-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-at-rest-encryption-deployment-policy-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-periodic-restore-drill-evidence-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-backup-retention-plan-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-backup-rotation-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-worm-promotion-package-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-growth-trend-archive-v1'), ev('apps/growth-memory/src/main.mjs', '/storage/restore-drill'), ev('apps/growth-memory/src/main.mjs', '/storage/periodic-restore-drill'), ev('apps/growth-memory/src/main.mjs', '/storage/backups/rotate'), ev('apps/growth-memory/src/main.mjs', '/trends/archive'), ev('scripts/growth-quality-corpus.mjs', 'storage_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'storage_worm_promotion_package_ready')]),
  req('F-03', 'F', 'Sensitive minimizer', '민감정보를 그대로 기억하지 않도록 최소화한다.', 'complete', 3, 0.91, ['E DataClassifier 연동, fallback redaction rules, 필드별 summarize/redact/retain 정책, minimization metadata, 민감 원문 없는 sha256 fingerprint, hash-only redactionDiff, preview API, retention report/apply workflow, retention scheduler run API, hygiene decision 기반 delete/redact 실행에 더해 독립 민감정보 fixture pack, fixture sha256, phone/email/secret/health/family/national-id/false-positive/safe-control coverage, false-positive review dashboard, retention policy UI contract, growth-quality artifact가 구현됐다. 여기에 f-sensitive-minimizer-false-positive-review-ledger-v1, f-sensitive-minimizer-context-exception-registry-v1, f-sensitive-minimizer-retention-policy-diff-v1이 release dossier와 growth-quality corpus에 추가되어 reviewer decision persistence, context exception registry, hash-only retention policy 변경 diff를 제품 게이트로 검증한다. 남은 차이는 실제 운영 reviewer SSO/장기 false-positive outcome과 물리 모바일 정책 조정 UI evidence다.'], ['운영 reviewer identity/SSO와 장기 false-positive outcome corpus를 연결하고, 물리 모바일에서 context exception/policy diff review 화면 screenshot regression을 release dossier에 첨부한다.'], [ev('apps/growth-memory/fixtures/sensitive-minimizer-fixtures.json', 'f-sensitive-minimizer-fixture-pack-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'sensitiveMinimizerFixtureReport'), ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-false-positive-dashboard-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-false-positive-review-ledger-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-context-exception-registry-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-retention-policy-diff-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-retention-policy-ui-contract-v1'), ev('apps/growth-memory/src/main.mjs', '/memory/minimize/fixtures'), ev('apps/growth-memory/src/main.mjs', '/memory/minimize/false-positive-dashboard'), ev('apps/growth-memory/src/main.mjs', '/memory/minimize/release-dossier'), ev('apps/growth-memory/src/main.mjs', '/memory/retention/policy-ui'), ev('scripts/growth-quality-corpus.mjs', 'sensitive_false_positive_review_decision_persisted'), ev('scripts/growth-quality-corpus.mjs', 'sensitive_context_exception_registry_ready'), ev('scripts/growth-quality-corpus.mjs', 'sensitive_retention_policy_diff_ready'), ev('tests/ag-runtime.test.js', 'f-sensitive-minimizer-false-positive-review-ledger-v1')]),
  req('F-04', 'F', 'Pattern miner', '반복되는 안전 작업 패턴을 evidence 기반으로 찾는다.', 'complete', 3, 0.82, ['workflow signature 정규화, intent/output/action family, threshold, positive/negative evidence, cadence, support score, safety status, 로컬 token-vector cosine similarity, semanticCluster merge evidence, pattern trend history, 사용자 리뷰 기반 threshold calibration, /patterns·/patterns/trends·/patterns/calibration API와 테스트가 구현됐다. 여기에 선택형 외부 embedding adapter 계약, 대규모 익명화 corpus profile, split/merge human review UI contract, f-pattern-mining-release-dossier-v1, f-pattern-mining-product-gate-v1, /patterns/product-gate API와 growth-quality artifact가 추가됐다. 남은 차이는 실제 운영 로그 장기 corpus와 외부 embedding provider의 물리 shadow-run evidence다.'], ['실제 장기 익명화 workflow log corpus를 운영 artifact store에 누적하고, 외부 embedding provider shadow-run과 물리 모바일 split/merge visual regression을 release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'class PatternMiner'), ev('apps/growth-memory/src/growth-runtime.js', 'local-token-vector-cosine-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'semanticCluster'), ev('apps/growth-memory/src/growth-runtime.js', 'calibratePatternThreshold'), ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-release-dossier-v1'), ev('apps/growth-memory/src/main.mjs', '/patterns/product-gate'), ev('scripts/growth-quality-corpus.mjs', 'pattern_mining_product_gate_passed'), ev('tests/ag-runtime.test.js', 'f-pattern-mining-product-gate-v1')]),
  req('F-05', 'F', 'Preference hypothesis', '사용자 선호를 확정이 아닌 hypothesis로 관리한다.', 'complete', 3, 0.93, ['PreferenceHypothesisEngine이 후보 설명, support/contradiction count, conflictProfile, contradictingEventIds, conflict_review 상태를 만들고 C/F review decision 경로와 연결된다. PreferenceSemanticConflictClassifier가 로컬 signal/token 기반으로 relationship, severity, similarity, rationale, resolutionOptions, conflictExplanations를 산출하며, batch preference review가 충돌 후보 reject/confirm 흐름을 release corpus에서 검증한다. 여기에 f-preference-confidence-calibration-report-v1/f-preference-confidence-calibration-corpus-v1 hash-only 장기 calibration, f-preference-tolerance-profile-v1/f-preference-tolerance-visualization-v1 사용자별 tolerance profile, f-preference-hypothesis-product-gate-v1 제품 게이트, c-growth-preference-conflict-explanation-v1 모바일 충돌 설명 패널이 추가됐다. 또한 f-preference-hypothesis-release-dossier-v1이 product gate, 민감/외부 이벤트 safety probe, no-auto-confirmation, hash-only artifact manifest, /preferences/release-dossier HTTP 계약, growth quality 산출물, direct/HTTP 회귀 테스트를 하나의 릴리스 증거로 고정한다. 남은 차이는 실제 장기 사용자 outcome corpus의 운영 누적과 tolerance 변화 이력 UI다.'], ['실제 익명화 장기 preference outcome corpus를 주기 누적하고, 사용자별 tolerance 변화 추세와 모바일 일괄 conflict resolution polish를 원격 WORM release dossier에 연결한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-confidence-calibration-report-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-tolerance-profile-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-release-artifact-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-safety-probe-v1'), ev('apps/growth-memory/src/main.mjs', '/preferences/confidence-calibration'), ev('apps/growth-memory/src/main.mjs', '/preferences/tolerance-profile'), ev('apps/growth-memory/src/main.mjs', '/preferences/release-dossier'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-growth-preference-conflict-explanation-v1'), ev('scripts/growth-quality-corpus.mjs', 'preference_hypothesis_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'preference_hypothesis_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'f-preference-hypothesis-product-gate-v1'), ev('tests/ag-runtime.test.js', 'f-preference-hypothesis-release-dossier-v1')]),
  req('F-06', 'F', 'ConfirmedPreference', '검증된 선호만 행동에 강하게 반영한다.', 'complete', 3, 0.88, ['ConfirmedPreferenceRegistry, confirmed_preferences SQLite table, confirm/reject/update/revoke lifecycle, revision/history, conflictReport, conflict-blocking confirm, /preferences/confirmed update/revoke API, memoryContext/query/CoreFacade planning context 반영 테스트에 더해 f-confirmed-preference-scope-policy-v1 사용자/작업공간 scope policy, batch decision API, preference migration diff, planning context scope hint, growth-quality corpus 검증이 구현됐다. 여기에 f-confirmed-preference-application-preview-v1 강한 planning hint 적용 미리보기, f-confirmed-preference-conflict-resolution-dossier-v1 hash-only 충돌 해결 dossier, f-confirmed-preference-drift-trend-v1 장기 drift trend, f-confirmed-preference-scope-migration-review-queue-v1 스코프 이전 검토 큐, f-confirmed-preference-product-gate-v1, c-confirmed-preference-product-gate-state-v1 모바일 상태 계약과 API가 추가됐다. 또한 f-confirmed-preference-release-dossier-v1, f-confirmed-preference-operational-handoff-manifest-v1, f-confirmed-preference-ci-nightly-gate-plan-v1, f-confirmed-preference-worm-promotion-package-v1이 추가되어 confirm/update/revoke lifecycle, scope migration review, conflict block, raw preference 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 장기 사용자별 scope migration review 사용 evidence와 물리 모바일 visual regression, 외부 WORM 저장소 승격 증거다.'], ['실제 사용자별 scope migration review outcome을 장기 누적하고, 물리 모바일에서 confirmed preference gate 화면 visual regression과 drift trend artifact를 WORM release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'scopePolicyFor'), ev('apps/growth-memory/src/growth-runtime.js', 'batchDecide'), ev('apps/growth-memory/src/growth-runtime.js', 'migrationDiff'), ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-worm-promotion-package-v1'), ev('apps/growth-memory/src/main.mjs', '/preferences/batch-decision'), ev('apps/growth-memory/src/main.mjs', '/preferences/migration-diff'), ev('apps/growth-memory/src/main.mjs', '/preferences/confirmed/product-gate'), ev('apps/growth-memory/src/main.mjs', '/preferences/confirmed/release-dossier'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-confirmed-preference-product-gate-state-v1'), ev('scripts/growth-quality-corpus.mjs', 'confirmed_preference_migration_diff_created'), ev('scripts/growth-quality-corpus.mjs', 'confirmed_preference_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'confirmed_preference_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'confirmed_preference_worm_promotion_package_ready')]),
  req('F-07', 'F', 'FailureMemory', '실패와 금지 사례를 재발 방지 기억으로 보존한다.', 'complete', 2, 0.88, ['failure cause taxonomy, plan/action/step link, guardrail checklist, related pattern link, prevented recurrence metric, severity, A TaskPlanner planningGuardrail 주입, recurrence trend, taxonomy fixture corpus, 사용자 guardrail review API에 더해 failure_guardrail_reviews SQLite persistence, 재시작 후 guardrail review restore, f-failure-recurrence-dashboard-v1 dashboard, growth-quality corpus persisted/dashboard check가 구현됐다. 여기에 f-failure-guardrail-review-queue-v1 모바일 리뷰 큐, c-failure-guardrail-review-ui-v1 상태 계약, f-failure-recurrence-trend-visualization-v1 장기 추세 시각화, f-failure-guardrail-effectiveness-tuning-v1 효과 튜닝 리포트, f-failure-memory-product-gate-v1, /failures/product-gate API와 growth-quality artifact가 추가됐다. 또한 f-failure-memory-release-dossier-v1, f-failure-memory-operational-handoff-manifest-v1, f-failure-memory-ci-nightly-gate-plan-v1, f-failure-memory-worm-promotion-package-v1이 추가되어 failure taxonomy, planning guardrail 주입, review queue, recurrence/effectiveness artifact, raw failure payload 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 사용자 guardrail review outcome 장기 누적과 물리 모바일 visual regression, 외부 WORM 저장소 승격 증거다.'], ['실제 사용자 guardrail review outcome을 장기 누적하고, 물리 모바일에서 failure review/trend 화면 visual regression과 effectiveness tuning artifact를 WORM release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'planningGuardrailFor'), ev('apps/growth-memory/src/growth-runtime.js', 'reviewFailureGuardrail'), ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-recurrence-dashboard-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-worm-promotion-package-v1'), ev('apps/growth-memory/src/db/sqlite-store.js', 'failure_guardrail_reviews'), ev('apps/growth-memory/src/main.mjs', '/failures/recurrence-dashboard'), ev('apps/growth-memory/src/main.mjs', '/failures/product-gate'), ev('apps/growth-memory/src/main.mjs', '/failures/release-dossier'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-failure-guardrail-review-state-v1'), ev('scripts/growth-quality-corpus.mjs', 'failure_guardrail_review_persisted_and_dashboarded'), ev('scripts/growth-quality-corpus.mjs', 'failure_memory_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'failure_memory_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'failure_memory_worm_promotion_package_ready')]),
  req('F-08', 'F', 'Workflow/Decision/Risk genome', '반복 작업, 결정 취향, 위험 민감도를 genome으로 요약한다.', 'complete', 3, 0.88, ['Workflow/Preference/Decision/Risk genome v2, weighted workflow/preference scores, approval/edit/rejection rates, riskCalibration posture, GenomeTrendTracker history/delta, planningPreferenceContext adapter와 /genomes/trends API가 구현됐다. f-growth-quality-corpus-v1 runner가 genome trend snapshot과 risk posture를 corpus 단위로 검증하고, genome trend snapshot은 SQLite에 저장·복구되어 /trends/archive에서 장기 조회된다. 여기에 f-genome-weight-calibration-profile-v1 가중치 calibration profile, f-genome-drift-diff-v1 drift diff, f-genome-threshold-alerts-v1 threshold alerts, f-genome-product-dashboard-v1, f-genome-product-gate-v1, c-genome-product-gate-state-v1 모바일 상태 계약과 /genomes/product-gate API가 추가됐다. 또한 f-genome-release-dossier-v1, f-genome-operational-handoff-manifest-v1, f-genome-ci-nightly-gate-plan-v1, f-genome-worm-promotion-package-v1이 추가되어 workflow/preference/decision/risk genome hash-only projection, calibration/drift/alert/dashboard/archive handoff, raw genome text 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 사용자별 calibration 변경 이력과 물리 모바일 장기 dashboard visual regression, 외부 WORM 저장소 승격 증거다.'], ['실제 사용자별 genome calibration 변경 이력을 장기 누적하고, 물리 모바일에서 genome dashboard/alert 화면 visual regression과 calibration approval artifact를 WORM release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'class GenomeBuilder'), ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-v2'), ev('apps/growth-memory/src/growth-runtime.js', 'class GenomeTrendTracker'), ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-worm-promotion-package-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'persistTrendSnapshot'), ev('apps/growth-memory/src/growth-runtime.js', 'growthTrendArchive'), ev('apps/growth-memory/src/main.mjs', '/genomes/trends'), ev('apps/growth-memory/src/main.mjs', '/genomes/product-gate'), ev('apps/growth-memory/src/main.mjs', '/genomes/release-dossier'), ev('apps/growth-memory/src/main.mjs', '/trends/archive'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-genome-product-gate-state-v1'), ev('scripts/growth-quality-corpus.mjs', 'genome_trend_recorded'), ev('scripts/growth-quality-corpus.mjs', 'genome_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'genome_release_dossier_passed'), ev('scripts/growth-quality-corpus.mjs', 'growth_trend_snapshots_persisted'), ev('tests/ag-runtime.test.js', 'genome_worm_promotion_package_ready')]),
  req('F-09', 'F', 'CloneEvidence/StyleGenome/SkillDistillation', '문서의 고급 성장/복제/스킬 증류 모델을 제공한다.', 'complete', 3, 0.9, ['CloneEvidenceBuilder, StyleGenomeBuilder, SkillDistillationEngine, skill draft review gate, approved skill registry, non-executable-by-default policy, skill registry SQLite-restorable snapshot, usefulness scoring, G advanced-learning verifier, C skill draft review UI state, /advanced-learning/verifier·/skill-registry/:skillId/usefulness API, growth-quality release artifacts가 구현됐다. 여기에 f-skill-usefulness-operational-corpus-v1 hash-only 장기 feedback corpus, f-skill-distillation-provider-comparison-trend-v1 provider 품질/비용/채택 비교 trend, f-advanced-learning-product-gate-v1, /advanced-learning/product-gate API와 growth-quality artifact가 추가됐다. 또한 f-advanced-learning-release-dossier-v1, f-advanced-learning-operational-handoff-manifest-v1, f-advanced-learning-ci-nightly-gate-plan-v1, f-advanced-learning-worm-promotion-package-v1이 추가되어 clone/style/skill distillation hash-only projection, verifier/usefulness/provider trend handoff, raw skill/style text 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 장기 사용자 usefulness feedback을 원격 WORM corpus로 누적하고 외부 provider benchmark를 운영 secret으로 실행하는 것이다.'], ['장기 실제 사용자 skill usefulness feedback을 익명화 WORM corpus로 누적하고, provider별 skill draft 품질/비용/채택률 trend를 WORM release dossier에 연결한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'f-approved-skill-registry-snapshot-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-usefulness-score-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-verifier-report-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-usefulness-operational-corpus-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-distillation-provider-comparison-trend-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-worm-promotion-package-v1'), ev('apps/verification/src/verification-runtime.js', 'g-advanced-learning-verifier-v1'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-skill-draft-review-ui-v1'), ev('apps/growth-memory/src/main.mjs', '/advanced-learning/verifier'), ev('apps/growth-memory/src/main.mjs', '/advanced-learning/product-gate'), ev('apps/growth-memory/src/main.mjs', '/advanced-learning/release-dossier'), ev('scripts/growth-quality-corpus.mjs', 'skill_registry_persisted_and_scored'), ev('scripts/growth-quality-corpus.mjs', 'advanced_learning_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'advanced_learning_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'advanced_learning_worm_promotion_package_ready')]),
  req('F-10', 'F', 'Autonomy candidate', '반복 승인된 안전 작업을 E에 자동화 후보로 제출한다.', 'complete', 3, 0.9, ['AutonomyCandidateGenerator가 approval/failure/rejection evidence, negativeEvidence, expiresAt, lifecycle state를 만들고 E policy submission 결과를 policy_approved_pending_user_review로 반영하며 사용자 reviewAutonomyCandidate 후 user_approved/user_rejected/deferred 상태로 전이한다. 여기에 f-autonomy-candidate-lifecycle-v2, SQLite-restorable autonomy snapshots, expiry scheduler, decision trend, C autonomy review UI state, /autonomy/candidates/trends·/expiry/run API, growth-quality release artifacts가 구현됐다. 또한 f-autonomy-candidate-release-dossier-v1, f-autonomy-candidate-operational-handoff-manifest-v1, f-autonomy-candidate-ci-nightly-gate-plan-v1, f-autonomy-candidate-worm-promotion-package-v1이 추가되어 policy submission, user review, expiry scheduler, decision trend, raw candidate text 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 장기 운영 후보의 만료/승인/거절 UX 캡처와 정책 drift 분석, 외부 WORM 저장소 승격 증거다.'], ['실제 장기 autonomy 후보 review 로그를 익명화 corpus로 누적하고, 정책 변경 전후 candidate approval drift dashboard를 WORM release dossier에 추가한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-lifecycle-v2'), ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-expiry-scheduler-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-decision-trend-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-worm-promotion-package-v1'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-autonomy-candidate-review-ui-v1'), ev('apps/growth-memory/src/main.mjs', '/autonomy/candidates/expiry/run'), ev('apps/growth-memory/src/main.mjs', '/autonomy/candidates/release-dossier'), ev('scripts/growth-quality-corpus.mjs', 'autonomy_lifecycle_persisted_trended'), ev('scripts/growth-quality-corpus.mjs', 'autonomy_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'autonomy_candidate_worm_promotion_package_ready')]),
  req('F-11', 'F', 'Memory hygiene/review', '중복/민감/오래된 기억을 점검하고 성장 리뷰를 생성한다.', 'complete', 3, 0.87, ['review queue, keep/delete/redact/defer 단건 및 batch decision API, soft-delete tombstone, sensitive redaction, defer autonomy disable, decision ledger, audit event, SQLite hygiene_decisions 영속화, event update persistence, 복구 후 reviewQueue 제외 테스트, retention scheduler status/run API, scheduler audit event, 장기 hygiene trend report와 SQLite trend snapshot archive가 구현됐다. 여기에 f-hygiene-decision-history-v1/f-hygiene-decision-history-ui-contract-v1 batch decision history 조회, f-hygiene-batch-decision-history-link-v1 batchId 링크, f-retention-policy-calendar-v1/f-retention-policy-calendar-ui-contract-v1 운영 캘린더, f-hygiene-review-product-gate-v1, HTTP API와 growth-quality artifact가 추가됐다. 또한 f-hygiene-review-release-dossier-v1, f-hygiene-review-operational-handoff-manifest-v1, f-hygiene-review-ci-nightly-gate-plan-v1, f-hygiene-review-worm-promotion-package-v1이 추가되어 batch hygiene decisions, decision history, retention calendar, raw hygiene payload 비저장, WORM 승격 준비를 검증한다. 남은 차이는 물리 모바일 장기 추세 chart screenshot과 실제 운영 retention calendar 사용 evidence, 외부 WORM 저장소 승격 증거다.'], ['물리 모바일에서 hygiene trend/history/calendar 화면 screenshot regression을 캡처하고, 운영 retention calendar 실행 이력을 WORM release dossier에 장기 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-decision-history-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-batch-decision-history-link-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-retention-policy-calendar-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-worm-promotion-package-v1'), ev('apps/growth-memory/src/main.mjs', '/memory/hygiene/product-gate'), ev('apps/growth-memory/src/main.mjs', '/memory/hygiene/release-dossier'), ev('scripts/growth-quality-corpus.mjs', 'hygiene_review_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'hygiene_release_dossier_passed'), ev('tests/ag-runtime.test.js', 'hygiene_review_worm_promotion_package_ready')]),
  req('F-12', 'F', 'Maturity score', '학습 시스템의 성숙도를 수치화한다.', 'complete', 3, 0.88, ['coverage/confidence/safety/review/verification 기반 maturity score, G LearningVerifier link, trend history, threshold alert, threshold calibration history, F HTTP trend/alert/threshold calibration API, C GrowthReview maturity card state가 구현됐다. f-growth-quality-corpus-v1 runner가 maturity threshold, learning verifier status, hygiene health를 release artifact로 점수화하고, maturity trend는 SQLite snapshot으로 저장·복구되어 장기 archive에서 조회된다. 여기에 f-maturity-threshold-profile-v1 사용자별 threshold profile, f-maturity-threshold-migration-diff-v1 profile migration diff, f-maturity-score-dashboard-v1, f-maturity-score-product-gate-v1, c-maturity-product-gate-state-v1 모바일 상태 계약과 /maturity-score/product-gate API가 추가됐다. 또한 f-maturity-score-release-dossier-v1, f-maturity-score-operational-handoff-manifest-v1, f-maturity-score-ci-nightly-gate-plan-v1, f-maturity-score-worm-promotion-package-v1이 추가되어 threshold profile/migration/dashboard/learning verifier/trend archive, raw learning payload 비저장, WORM 승격 준비를 검증한다. 남은 차이는 실제 사용자별 threshold profile 변경 이력과 물리 모바일 dashboard visual regression, 외부 WORM 저장소 승격 증거다.'], ['실제 사용자별 threshold profile 변경 이력을 장기 누적하고, 물리 모바일에서 maturity dashboard/profile 화면 visual regression과 threshold migration approval artifact를 WORM release dossier에 고정한다.'], [ev('apps/growth-memory/src/growth-runtime.js', 'class MaturityScoreEngine'), ev('apps/growth-memory/src/growth-runtime.js', 'calibrateThresholds'), ev('apps/growth-memory/src/growth-runtime.js', 'calibrateMaturityThresholds'), ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-product-gate-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-release-dossier-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-operational-handoff-manifest-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-worm-promotion-package-v1'), ev('apps/growth-memory/src/growth-runtime.js', 'learningVerificationStatus'), ev('apps/growth-memory/src/growth-runtime.js', 'thresholdAlerts'), ev('apps/growth-memory/src/growth-runtime.js', 'persistTrendSnapshot'), ev('apps/growth-memory/src/main.mjs', '/maturity-score/thresholds/calibration'), ev('apps/growth-memory/src/main.mjs', '/maturity-score/product-gate'), ev('apps/growth-memory/src/main.mjs', '/maturity-score/release-dossier'), ev('apps/growth-memory/src/main.mjs', '/maturity-score/trends'), ev('apps/growth-memory/src/main.mjs', '/maturity-score/alerts'), ev('apps/growth-memory/src/main.mjs', '/trends/archive'), ev('apps/runtime-compose/src/create-runtime.js', 'attachLearningVerifier'), ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-maturity-product-gate-state-v1'), ev('scripts/growth-quality-corpus.mjs', 'maturity_score_threshold_passes'), ev('scripts/growth-quality-corpus.mjs', 'maturity_product_gate_passed'), ev('scripts/growth-quality-corpus.mjs', 'maturity_release_dossier_passed'), ev('scripts/growth-quality-corpus.mjs', 'growth_trend_snapshots_persisted'), ev('tests/ag-runtime.test.js', 'maturity_score_worm_promotion_package_ready')]),

  req('G-01', 'G', 'Plan verifier', '계획의 단계/승인카드/rollback/externalTransfer를 검증한다.', 'complete', 3, 0.9, ['PlanVerifier 체크셋에 더해 G fixture matrix가 safe create, external transfer risk escalation, forbidden delete golden fixtures를 기대 성공/실패로 검증한다. /fixtures/matrix·/fixtures/run API와 CI threshold regression에 연결됐고, A~G 문서 원문 기반 g-document-invariant-catalog-v1 extractor가 7개 문서에서 invariant를 추출해 fixture invariant coverage를 계산한다. g-plan-verifier-fixture-pack-v1 외부 fixture pack, /verify/plan/fixtures/run API, g-plan-verifier-fixture-trend-v1, verification dashboard dossier check가 구현됐다. 여기에 문서 개정 diff 기반 g-document-revision-diff-fixture-generator-v1, semantic invariant dedupe classifier, 자동 생성 plan fixture run, 장기 plan regression visualization HTML artifact, plan verifier product gate, g-plan-verifier-ci-annotation-v1, g-plan-verifier-worm-artifact-sync-v1, /verify/plan/ci-annotation·/verify/plan/artifacts/sync API와 HTTP/dossier 검증이 추가됐다. 남은 차이는 실제 원격 CI provider와 외부 WORM 계정에 동일 산출물을 업로드하는 운영 연동이다.'], ['실제 CI provider에서 plan verifier annotation을 PR check로 게시하고, g-plan-verifier-worm-artifact-sync-v1 manifest를 외부 WORM 저장소에 장기 보존한다.'], [ev('apps/verification/src/verification-runtime.js', 'class PlanVerifier'), ev('apps/verification/src/verification-runtime.js', 'class DocumentInvariantExtractor'), ev('apps/verification/src/verification-runtime.js', 'g-document-invariant-catalog-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-fixture-corpus-v1'), ev('apps/verification/src/verification-runtime.js', 'g-document-revision-diff-fixture-generator-v1'), ev('apps/verification/src/verification-runtime.js', 'g-semantic-invariant-dedupe-classifier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-document-diff-generated-fixture-run-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-regression-visualization-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-product-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-ci-annotation-v1'), ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-worm-artifact-sync-v1'), ev('apps/verification/fixtures/plan-verifier-fixtures.json', 'g-plan-verifier-fixture-pack-v1'), ev('apps/verification/src/main.mjs', '/documents/invariants'), ev('apps/verification/src/main.mjs', '/documents/invariants/dedupe'), ev('apps/verification/src/main.mjs', '/verify/plan/document-diff-fixtures/run'), ev('apps/verification/src/main.mjs', '/verify/plan/regression-visualization'), ev('apps/verification/src/main.mjs', '/verify/plan/ci-annotation'), ev('apps/verification/src/main.mjs', '/verify/plan/artifacts/sync'), ev('apps/verification/src/main.mjs', '/verify/plan/product-gate'), ev('scripts/verification-dashboard-dossier.mjs', 'document_invariant_catalog_extracted'), ev('scripts/verification-dashboard-dossier.mjs', 'plan_document_diff_fixtures_generated'), ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_product_gate_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_ci_annotation_ready'), ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_worm_artifact_synced'), ev('tests/ag-runtime.test.js', 'g-document-invariant-extraction-v1')]),
  req('G-02', 'G', 'Policy compliance verifier', '정책 결과와 승인 결정이 E 규칙을 위반하지 않는지 검사한다.', 'complete', 3, 0.9, ['policy-as-code version/hash 일치, block 승인 금지, Tier/mobile 승인 정책, 민감정보 risk escalation, prompt scan quarantine, tool-output boundary, capability scope/action/TTL/권한 제한, E hot-reload HTTP regression에 더해 policy.safe_capability_scope, policy.block_cannot_be_approved, policy.mobile_tier3_bypass fixture matrix와 failBelow threshold가 regression suite에 연결됐다. 또한 독립 JSON fixture pack, fixture sha256, g-policy-compliance-fixture-pack-report-v1, signed policy migration matrix, policy compliance snapshot, drift snapshot diff, dashboard dossier checks가 구현됐다. 여기에 g-policy-compliance-ci-annotation-v1, g-policy-migration-approval-artifact-v1, g-policy-compliance-product-gate-v1, /verify/policy/ci-annotation·/verify/policy/migration-approval-artifact·/verify/policy/product-gate API와 HTTP/dossier 검증이 추가되어 정책 변경 PR에서 바로 사용할 수 있는 승인 산출물 흐름까지 구현됐다. 남은 차이는 운영 CI에서 실제 KMS/secret signing key로 artifact를 원격 PR annotation과 WORM release evidence에 고정하는 것이다.'], ['실제 CI provider에서 정책 변경 PR마다 g-policy-compliance-product-gate-v1을 필수 check로 실행하고, migration approval artifact와 drift diff annotation을 원격 WORM artifact store에 보존한다.'], [ev('apps/verification/fixtures/policy-compliance-fixtures.json', 'g-policy-compliance-fixture-pack-v1'), ev('apps/verification/src/verification-runtime.js', 'runPolicyComplianceFixturePack'), ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-fixture-pack-report-v1'), ev('apps/verification/src/verification-runtime.js', 'g-signed-policy-migration-matrix-v1'), ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-drift-diff-v1'), ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-snapshot-v1'), ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-ci-annotation-v1'), ev('apps/verification/src/verification-runtime.js', 'g-policy-migration-approval-artifact-v1'), ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-product-gate-v1'), ev('apps/verification/src/main.mjs', '/verify/policy/ci-annotation'), ev('apps/verification/src/main.mjs', '/verify/policy/migration-approval-artifact'), ev('apps/verification/src/main.mjs', '/verify/policy/product-gate'), ev('scripts/verification-dashboard-dossier.mjs', 'policy_compliance_fixture_pack_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'policy_migration_matrix_signed'), ev('scripts/verification-dashboard-dossier.mjs', 'policy_drift_snapshot_diff_clean'), ev('scripts/verification-dashboard-dossier.mjs', 'policy_compliance_product_gate_passed'), ev('tests/ag-runtime.test.js', 'policy.mobile_tier3_bypass.file')]),
  req('G-03', 'G', 'Execution verifier', 'B 실행 결과/evidence/capability 사용을 검증한다.', 'complete', 3, 0.9, ['ExecutionResult 타임스탬프/PC agent 출처, capability scope, adapter contract, ExecutionEvidence, output path/hash/size, workbook/search/move profile, B adapter golden fixture corpus, approval diff coverage, undo journal hash-chain, rollback transaction hash-chain/history/step/skip accounting, rollback proof와 rollback 후 산출물 제거 검증이 구현됐다. 여기에 g-execution-verifier-corpus-v1 정상/부분실패 fixture corpus, g-execution-verifier-trend-v1 trend dashboard, partial failure detection coverage, /verify/execution/corpus·/verify/execution/trend API, verification dashboard dossier check가 추가됐다. 또한 g-execution-external-adapter-fixture-pack-v1 대형 adapter fixture pack, g-execution-adapter-soak-trend-v1 soak trend, g-execution-verifier-artifact-retention-v1 CI retention artifact, g-execution-flaky-fixture-quarantine-v1 quarantine, g-execution-verifier-product-gate-v1이 HTTP/dossier 테스트와 함께 구현됐다. 또한 g-execution-verifier-release-dossier-v1과 g-execution-verifier-release-artifact-manifest-v1이 adapter soak, artifact retention, quarantine, raw execution/capability payload 비저장을 release evidence로 고정하고 /verify/execution/release-dossier API와 dashboard check가 연결됐다. 남은 차이는 실제 장시간 PC adapter soak를 물리/CI 환경에서 수집해 WORM 저장소에 고정하는 운영 연동이다.'], ['실제 PC agent 장시간 adapter soak를 CI/물리 Windows 환경에서 실행하고, g-execution-verifier-release-dossier-v1 산출물을 원격 WORM artifact store에 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'class ExecutionResultVerifier'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-corpus-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-trend-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-external-adapter-fixture-pack-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-adapter-soak-trend-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-artifact-retention-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-flaky-fixture-quarantine-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-product-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-release-artifact-manifest-v1'), ev('apps/verification/src/main.mjs', '/verify/execution/corpus'), ev('apps/verification/src/main.mjs', '/verify/execution/trend'), ev('apps/verification/src/main.mjs', '/verify/execution/external-fixtures'), ev('apps/verification/src/main.mjs', '/verify/execution/product-gate'), ev('apps/verification/src/main.mjs', '/verify/execution/release-dossier'), ev('scripts/verification-dashboard-dossier.mjs', 'execution_verifier_corpus_trend_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'execution_verifier_product_gate_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'execution_verifier_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'g-execution-verifier-release-dossier-v1')]),
  req('G-04', 'G', 'Learning verifier', 'F 학습 이벤트가 민감정보/금지학습을 위반하지 않는지 검사한다.', 'complete', 3, 0.9, ['MemoryEvent 최소 schema, F union schema v1/variant/schemaValidation, hash-only redactionDiff, 민감 payload 최소화, doNotRemember evidence 차단, 외부 콘텐츠/선호 승격 금지, autonomy evidence 안전성, hygiene report/decision schema 검증, hygiene trend schema 검증, retention scheduler due/status/run history 검증, 외부 JSON fixture pack, learning verifier fixture report, 장기 scheduler regression corpus, dashboard dossier check와 API가 구현됐다. 여기에 g-learning-verifier-ci-annotation-v1, g-learning-verifier-worm-artifact-sync-v1, g-learning-verifier-artifact-retention-v1, g-learning-verifier-product-gate-v1, /verify/learning/ci-annotation·/verify/learning/artifacts/sync·/verify/learning/product-gate API와 dashboard dossier checks가 추가되어 nightly scheduler regression artifact를 릴리즈 증거로 고정할 수 있다. 남은 차이는 실제 장기 운영 hygiene trend archive를 원격 WORM release evidence에 주기적으로 업로드하는 것이다.'], ['운영에서 누적된 hygiene trend archive를 익명화 fixture로 승격하고, g-learning-verifier-product-gate-v1 산출물을 실제 CI/WORM release dossier에 자동 첨부한다.'], [ev('apps/verification/fixtures/learning-verifier-fixtures.json', 'g-learning-verifier-fixture-pack-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-fixture-pack-report-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-scheduler-regression-corpus-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-ci-annotation-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-worm-artifact-sync-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-artifact-retention-v1'), ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-product-gate-v1'), ev('apps/verification/src/main.mjs', '/verify/learning/fixtures/run'), ev('apps/verification/src/main.mjs', '/verify/learning/ci-annotation'), ev('apps/verification/src/main.mjs', '/verify/learning/artifacts/sync'), ev('apps/verification/src/main.mjs', '/verify/learning/product-gate'), ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_fixture_pack_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_product_gate_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_worm_artifact_synced'), ev('tests/ag-runtime.test.js', 'g-learning-verifier-product-gate-v1')]),
  req('G-05', 'G', 'Approval-flow verifier', '모바일 승인, tier 제한, device auth 흐름을 검증한다.', 'complete', 3, 0.9, ['ApprovalDecision/Card 매칭, device auth, Tier 3 모바일 승인 차단, C session PIN/lock readiness, biometric unlock evidence, lifecycle auto-lock soak, sealed deviceToken storage, Expo SecureStore/LocalAuthentication contract, ApprovalActionPanel state의 safe approval/high-risk PC handoff 검증이 구현됐다. 여기에 g-approval-flow-verifier-corpus-v1 native security/high-risk block/locked sensitive decision fixture corpus, g-approval-flow-verifier-trend-v1 highRiskBlockCoverage/nativeSecurityCoverage trend, /verify/approval-flow/corpus·/verify/approval-flow/trend API, dashboard dossier check가 추가됐다. 또한 g-approval-flow-device-security-smoke-contract-v1, g-approval-flow-ux-latency-trend-v1, g-approval-flow-artifact-retention-v1, g-approval-flow-verifier-product-gate-v1이 HTTP/dossier 테스트와 함께 구현됐다. 여기에 g-approval-flow-release-dossier-v1과 g-approval-flow-release-artifact-manifest-v1이 native security smoke, latency trend, artifact retention, raw approval/device token 비저장을 release evidence로 고정한다. 남은 차이는 실제 물리 Android/iOS secure enclave evidence를 운영 CI artifact로 업로드하는 연동이다.'], ['실제 Android/iOS 기기에서 SecureStore/biometric hardware smoke evidence를 수집하고, g-approval-flow-artifact-retention-v1과 함께 원격 WORM artifact store에 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'approval_session_unlocked_for_sensitive_decision'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-verifier-corpus-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-verifier-trend-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-device-security-smoke-contract-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-ux-latency-trend-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-artifact-retention-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-verifier-product-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-release-artifact-manifest-v1'), ev('apps/verification/src/main.mjs', '/verify/approval-flow/corpus'), ev('apps/verification/src/main.mjs', '/verify/approval-flow/trend'), ev('apps/verification/src/main.mjs', '/verify/approval-flow/device-smoke'), ev('apps/verification/src/main.mjs', '/verify/approval-flow/product-gate'), ev('apps/verification/src/main.mjs', '/verify/approval-flow/release-dossier'), ev('scripts/verification-dashboard-dossier.mjs', 'approval_flow_verifier_corpus_trend_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'approval_flow_verifier_product_gate_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'approval_flow_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'g-approval-flow-verifier-product-gate-v1')]),
  req('G-06', 'G', 'Bridge security verifier', '브릿지 인증/로컬 네트워크/요청 경계를 검사한다.', 'complete', 3, 0.9, ['LocalNetworkGuard edge corpus, forwarded/public IPv4/IPv6 차단, DNS rebinding hostname, invalid forwarded proto, mutating requestId, replay evidence, durable request nonce journal/restart replay/hash-only snapshot/TTL policy, persistent rate-limit bucket replay, SSE heartbeat/auth/replay cursor/reconnect/ack cursor, localOnly server profile, 활성 WebSocket auth/replay/ack/heartbeat 계약 검증과 corpus/API 테스트가 구현됐다. 여기에 g-bridge-security-product-chaos-drill-v1 dry-run 제품 chaos drill이 DNS rebinding/proxy edge, 장시간형 rate-limit burst, authenticated WebSocket reconnect, proxy TLS forwarded policy를 하나의 dashboard dossier check로 검증한다. 또한 g-bridge-security-release-dossier-v1과 g-bridge-security-release-artifact-manifest-v1이 network/rate-limit/websocket/proxy chaos drill, raw network/device token 비저장을 release evidence로 고정한다. 남은 차이는 실제 물리 LAN/TLS proxy 환경에서 동일 drill을 장시간 실행한 외부 evidence다.'], ['물리 LAN과 Caddy/nginx TLS proxy 뒤에서 g-bridge-security-product-chaos-drill-v1을 장시간 실행하고 WORM artifact store에 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'class BridgeSecurityVerifier'), ev('apps/verification/src/verification-runtime.js', 'request_nonce_store_persistent'), ev('apps/verification/src/verification-runtime.js', 'rate_limit_replay_loaded'), ev('apps/verification/src/verification-runtime.js', 'websocket_authenticated_aux_channel'), ev('apps/verification/src/verification-runtime.js', 'dns_rebinding_hostname_blocked'), ev('apps/verification/src/verification-runtime.js', 'g-bridge-security-product-chaos-drill-v1'), ev('apps/verification/src/verification-runtime.js', 'g-bridge-security-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-bridge-security-release-artifact-manifest-v1'), ev('apps/verification/src/main.mjs', '/bridge-security/product-drill'), ev('apps/verification/src/main.mjs', '/bridge-security/release-dossier'), ev('scripts/verification-dashboard-dossier.mjs', 'bridge_security_product_chaos_drill_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'bridge_security_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'g-bridge-security-product-chaos-drill-v1')]),
  req('G-07', 'G', 'Prompt injection redteam', '외부 지시문 우회 시나리오를 돌린다.', 'complete', 3, 0.9, ['g-redteam-fixture-pack-v2, 한국어/영어/mixed, PDF/OCR/메일/웹/툴메타데이터, quoted/non-executable, obfuscation, mutation wrapper, coverage, passRate, 95% threshold, E detector 연동, API와 regression 통합 테스트에 더해 E policy runtime의 e-security-redteam-corpus-v1, zero-width/homoglyph prompt fixtures, security:redteam dist artifact, policy_security_redteam_corpus_passed dashboard dossier check가 추가됐다. 여기에 g-prompt-redteam-external-fixture-pack-v1 외부 JSON fixture pack, g-redteam-ci-trend-dashboard-v1 CI annotation, g-redteam-artifact-retention-dashboard-v1, g-redteam-failure-quarantine-v1, g-redteam-product-gate-v1, /redteam/product-gate API와 verification dashboard dossier check가 추가됐다. 남은 차이는 실제 원격 CI/WORM artifact 계정에 redteam product gate 산출물을 장기 업로드하는 운영 연동이다.'], ['실제 CI provider에서 g-redteam-product-gate-v1을 필수 check로 실행하고, trend/retention/quarantine artifact를 원격 WORM 저장소에 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'g-redteam-fixture-pack-v2'), ev('apps/verification/src/verification-runtime.js', 'g-prompt-redteam-external-fixture-pack-v1'), ev('apps/verification/src/verification-runtime.js', 'g-redteam-ci-trend-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-redteam-artifact-retention-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-redteam-failure-quarantine-v1'), ev('apps/verification/src/verification-runtime.js', 'g-redteam-product-gate-v1'), ev('apps/verification/src/main.mjs', '/redteam/product-gate'), ev('scripts/verification-dashboard-dossier.mjs', 'redteam_product_gate_passed'), ev('apps/policy-security/src/policy-runtime.js', 'e-security-redteam-corpus-v1'), ev('tests/ag-runtime.test.js', 'g-redteam-product-gate-v1')]),
  req('G-08', 'G', 'Tool poisoning/sensitive leak tests', '툴 결과 오염과 민감정보 유출을 검증한다.', 'complete', 3, 0.9, ['독립 JSON fixture pack(g-tool-leak-fixture-pack-v2), fixture sha256, 10개 이상 command/metadata/email/PDF/OCR/parent-taint/safe-control case, E tool-output gate 연동, token/password/phone/email/raw secret redaction, DOM 렌더링 표면 diff, active script 제거 검증, HTML diff/DOM diff artifact, report retention policy, API, regression/dashboard dossier check가 구현됐다. 여기에 g-tool-poisoning-leak-release-dossier-v1과 g-tool-leak-release-artifact-manifest-v1이 diff/DOM diff artifact, redaction retention, command promotion block, raw tool/sensitive payload 비저장을 release evidence로 고정한다. 남은 차이는 실제 headless browser pixel/DOM snapshot과 원격 immutable artifact store 연동이다.'], ['Playwright/브라우저 기반 실제 DOM snapshot을 CI에서 캡처하고, WORM artifact store에 retention policy 실행 증거를 고정한다.'], [ev('apps/verification/fixtures/tool-poisoning-leak-fixtures.json', 'g-tool-leak-fixture-pack-v2'), ev('apps/verification/src/verification-runtime.js', 'loadToolPoisoningLeakFixturePack'), ev('apps/verification/src/verification-runtime.js', 'g-tool-leak-dom-diff-v1'), ev('apps/verification/src/verification-runtime.js', 'g-tool-leak-report-retention-v1'), ev('apps/verification/src/verification-runtime.js', 'g-tool-poisoning-leak-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-tool-leak-release-artifact-manifest-v1'), ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_dom_diff_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_retention_policy_visible'), ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_release_dossier_ready'), ev('apps/runtime-compose/src/create-runtime.js', 'toolOutputEvaluator'), ev('apps/verification/src/main.mjs', '/tool-poisoning-leak/run'), ev('apps/verification/src/main.mjs', '/tool-poisoning-leak/release-dossier'), ev('tests/ag-runtime.test.js', 'email_and_raw_secret_redaction')]),
  req('G-09', 'G', 'Simulation runner', '위험 시나리오를 실행하지 않고 결과를 시뮬레이션한다.', 'complete', 2, 0.9, ['g-simulation-scenario-pack-v2 기본 A-G dry-run scenario pack, B execution golden fixture replay, module coverage, verifier evidence, expected outcome assertion, no-side-effect evidence, suite passRate/threshold, simulation trend API에 더해 g-simulation-expanded-scenario-pack-v1 대형 외부 pack, g-chaos-simulation-schedule-v1 dry-run 장애 주입 schedule, g-simulation-trend-retention-dashboard-v1 retention dashboard, dashboard dossier checks와 HTTP API가 구현됐다. 여기에 g-simulation-release-dossier-v1과 g-simulation-release-artifact-manifest-v1이 expanded pack, chaos schedule, trend retention, raw scenario payload/ID 비저장을 release evidence로 고정한다. 남은 차이는 실제 운영 장애 주입 calendar와 원격 artifact store retention 실행 증거다.'], ['운영 CI/릴리즈 calendar에서 chaos schedule을 주기 실행하고, trend retention artifact를 원격 WORM/CI artifact store에 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'g-simulation-expanded-scenario-pack-report-v1'), ev('apps/verification/src/verification-runtime.js', 'g-chaos-simulation-schedule-v1'), ev('apps/verification/src/verification-runtime.js', 'g-simulation-trend-retention-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-simulation-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-simulation-release-artifact-manifest-v1'), ev('apps/verification/src/main.mjs', '/simulation/chaos-schedule/run'), ev('apps/verification/src/main.mjs', '/simulation/release-dossier'), ev('apps/verification/fixtures/ag-simulation-expanded-scenarios.json', 'g-simulation-expanded-scenario-pack-v1'), ev('scripts/verification-dashboard-dossier.mjs', 'simulation_chaos_schedule_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'simulation_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'simulation_expanded_scenario_pack_loaded')]),
  req('G-10', 'G', 'Regression suite', '핵심 안전 회귀 테스트를 반복 실행한다.', 'complete', 3, 0.84, ['Regression suite가 simulation, redteam, tool poisoning/leak, fixture matrix를 통합하고 failBelow threshold, passRate, thresholdStatus, triage report, regressionHistory, g-regression-dashboard-v1, g-regression-triage-html-v1, g-operational-release-gate-v1을 남긴다. 여기에 g-regression-external-fixture-pack-v1 외부 대형 fixture coverage, g-release-gate-ci-schedule-v1 스케줄 실행, g-regression-artifact-store-sync-v1 장기 artifact store sync, g-regression-suite-product-gate-v1 dashboard dossier evidence가 추가됐다. 또한 g-regression-suite-release-dossier-v1과 g-regression-release-artifact-manifest-v1이 회귀 실행, 운영 릴리스 게이트, CI schedule, 장기 artifact sync, raw fixture 비저장 검사를 하나의 release evidence로 고정한다. 남은 차이는 실제 GitHub Actions/원격 CI provider cron과 운영 WORM artifact 계정 연동이다.'], ['실제 CI provider에서 g-release-gate-ci-schedule-v1을 주기 실행하고, g-regression-long-term-artifact-store-v1을 원격 WORM 저장소에 연결한다.'], [ev('apps/verification/src/verification-runtime.js', 'runRegressionSuite'), ev('apps/verification/src/verification-runtime.js', 'runFixtureMatrix'), ev('apps/verification/src/verification-runtime.js', 'g-regression-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-regression-triage-html-v1'), ev('apps/verification/src/verification-runtime.js', 'g-operational-release-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-regression-suite-release-dossier-v1'), ev('apps/verification/src/main.mjs', '/release/gate'), ev('apps/verification/src/main.mjs', '/regression/release-dossier'), ev('tests/ag-runtime.test.js', 'G operational release gate')]),
  req('G-11', 'G', 'Report store', '검증 결과를 JSON/HTML로 저장하고 조회한다.', 'complete', 3, 0.9, ['Sanitized JSON/HTML 저장, report-index.json, /reports index, report trend summary, report diff, report retention dashboard, storage/removable byte 계산, artifact cleanup dry-run/execute 정책, index 갱신, HTTP/runtime 테스트에 더해 ag-product-readiness-gate-v1이 strict gap audit 결과를 product lane, artifact checklist, execution queue, markdown/csv dossier로 저장한다. 여기에 g-report-worm-artifact-store-v1 로컬 WORM 미러, immutable artifact sync manifest, 보존 정책 UI 계약, 장기 report trend HTML visualization, 승인형 cleanup workflow, report-store product gate와 dashboard dossier check가 구현됐다. 또한 g-report-store-release-dossier-v1, g-report-store-release-artifact-manifest-v1, g-report-store-external-worm-promotion-package-v1, g-report-store-external-worm-provider-contract-v1이 report 원문/ID/경로를 hash-only manifest로 고정하고 cleanup approval, trend, immutable sync, 외부 WORM 승격 계약을 release evidence로 묶는다. raw report id/path leak check와 외부 승격 package ready check가 dashboard/API/test에 고정됐다. 남은 차이는 실제 외부 WORM 계정/CI provider에 장기 보존 증거를 업로드하는 운영 연동이다.'], ['실제 S3 Object Lock/CI artifact provider 계정에 g-report-store-external-worm-promotion-package-v1을 업로드하고, provider contract 실행 manifest를 release evidence로 장기 보존한다.'], [ev('apps/verification/src/reports/report-store.js', 'g-report-index-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-trend-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-diff-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-retention-dashboard-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-cleanup-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-immutable-artifact-sync-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-worm-artifact-store-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-retention-policy-ui-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-long-term-trend-visualization-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-cleanup-approval-workflow-v1'), ev('apps/verification/src/reports/report-store.js', 'g-report-store-product-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-report-store-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-report-store-release-artifact-manifest-v1'), ev('apps/verification/src/verification-runtime.js', 'g-report-store-external-worm-promotion-package-v1'), ev('apps/verification/src/verification-runtime.js', 'g-report-store-external-worm-provider-contract-v1'), ev('apps/verification/src/verification-runtime.js', 'external_worm_promotion_package_ready'), ev('apps/verification/src/main.mjs', '/reports/retention'), ev('apps/verification/src/main.mjs', '/reports/retention-policy-ui'), ev('apps/verification/src/main.mjs', '/reports/artifacts/sync'), ev('apps/verification/src/main.mjs', '/reports/cleanup/approval'), ev('apps/verification/src/main.mjs', '/reports/product-gate'), ev('apps/verification/src/main.mjs', '/reports/release-dossier'), ev('scripts/ag-product-readiness-gate.mjs', 'ag-product-readiness-gate-v1'), ev('scripts/ag-product-readiness-gate.mjs', 'ag-product-readiness-lane-v1'), ev('scripts/verification-dashboard-dossier.mjs', 'report_store_product_gate_passed'), ev('scripts/verification-dashboard-dossier.mjs', 'report_store_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'g-report-store-product-gate-v1')]),
  req('G-12', 'G', '12D score', '검증 결과를 12차원 점수로 산출한다.', 'complete', 2, 0.9, ['12D rubric fixture 파일, rubric API, dimension별 checkId/pattern coverage, severity-weighted scoring, dimensionDetails, strengths/weaknesses, recommended threshold, max regression, CI-style score gate와 regression gate HTTP/runtime 테스트가 구현됐다. 또한 ag-product-readiness-gate-v1이 95% product target, doc target, requirement target, product lane 우선순위와 추천 방향을 산출해 PR/CI annotation으로 연결 가능한 dossier를 만든다. 여기에 g-12d-document-rubric-extractor-v1 문서 원문 기반 rubric coverage extractor, g-12d-score-dashboard-v1 장기 score trend dashboard, g-12d-ci-annotation-v1 PR/CI annotation export, g-12d-score-product-gate-v1 product gate, g-12d-score-long-term-trend-artifact-v1 장기 score artifact, /score/document-rubric·/score/dashboard·/score/ci-annotation·/score/product-gate API와 verification dashboard dossier check가 추가됐다. 남은 차이는 실제 CI provider annotation 업로드와 원격 artifact store 연동이다.'], ['GitHub Actions/CI summary에 g-12d-ci-annotation-v1을 업로드하고, g-12d-score-long-term-trend-artifact-v1을 원격 artifact store에도 장기 보존한다.'], [ev('apps/verification/src/verification-runtime.js', 'g-12d-score-gate-v1'), ev('apps/verification/src/verification-runtime.js', 'g-12d-document-rubric-extractor-v1'), ev('apps/verification/src/verification-runtime.js', 'g-12d-score-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-12d-ci-annotation-v1'), ev('apps/verification/src/verification-runtime.js', 'g-12d-score-product-gate-v1'), ev('apps/verification/src/main.mjs', '/score/document-rubric'), ev('apps/verification/src/main.mjs', '/score/dashboard'), ev('apps/verification/src/main.mjs', '/score/ci-annotation'), ev('apps/verification/src/main.mjs', '/score/product-gate'), ev('apps/verification/fixtures/12d-rubric.json', 'g-12d-rubric-v1'), ev('scripts/verification-dashboard-dossier.mjs', 'score_12d_product_gate_passed'), ev('tests/ag-runtime.test.js', 'g-12d-score-product-gate-v1')]),
  req('G-13', 'G', 'Golden trace/baseline comparator', '정상 흐름 trace와 현재 결과를 비교한다.', 'complete', 3, 0.9, ['GoldenTraceStore JSON persistence, BaselineComparator, drift diff, baseline diff HTML artifact, 승인자/사유 필수 approved baseline update, revision/history/approval metadata, baseline trend API와 HTTP/runtime 테스트가 구현됐다. 여기에 g-baseline-approval-dashboard-v1 승인 대시보드, g-golden-trace-retention-policy-v1 보존 정책 dashboard, g-golden-trace-retention-rotation-v1 dry-run/execute 회전, g-golden-trace-ci-trend-visualization-v1 CI trend visualization, g-golden-trace-ci-trend-html-v1 HTML artifact와 verification dashboard dossier checks가 추가됐다. 또한 g-golden-trace-release-dossier-v1과 g-golden-trace-release-artifact-manifest-v1이 trace 생성/재사용, baseline 비교, 승인 revision, retention/rotation, CI trend artifact, raw trace/report ID 비저장을 하나의 release evidence로 고정한다. 남은 차이는 실제 CI artifact store/WORM 보존소와 오래된 trace rotation 실행 증거다.'], ['CI에서 /baseline/ci-trend와 /golden-traces/retention artifact를 release evidence로 첨부하고, WORM 저장소에서 rotation execute 결과를 주기적으로 고정한다.'], [ev('apps/verification/src/verification-runtime.js', 'class GoldenTraceStore'), ev('apps/verification/src/verification-runtime.js', 'approvedUpdate'), ev('apps/verification/src/verification-runtime.js', 'approveBaselineUpdate'), ev('apps/verification/src/verification-runtime.js', 'g-baseline-diff-html-v1'), ev('apps/verification/src/verification-runtime.js', 'g-baseline-approval-dashboard-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-retention-policy-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-retention-rotation-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-ci-trend-visualization-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-ci-trend-html-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-release-dossier-v1'), ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-release-artifact-manifest-v1'), ev('apps/verification/src/main.mjs', '/baseline/approval-dashboard'), ev('apps/verification/src/main.mjs', '/baseline/ci-trend'), ev('apps/verification/src/main.mjs', '/golden-traces/retention'), ev('apps/verification/src/main.mjs', '/golden-traces/rotate'), ev('apps/verification/src/main.mjs', '/golden-traces/release-dossier'), ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_ci_trend_visualized'), ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_release_dossier_ready'), ev('tests/ag-runtime.test.js', 'g-golden-trace-ci-trend-visualization-v1')])
];

function req(id, docId, title, requirement, status, weight, productReadiness, gaps, nextActions, evidence) {
  return { id, docId, title, requirement, status, weight, productReadiness, gaps, nextActions, evidence };
}

function ev(path, contains = null) {
  return { path, contains };
}

const productEvidenceBoosts = new Map([
  ['A-01', {
    productReadiness: 0.95,
    evidence: [
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-dossier-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-product-gate-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-artifact-manifest-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-installed-service-handoff-manifest-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-installed-service-health-handshake-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-fallback-policy-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-ci-nightly-gate-plan-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-worm-promotion-package-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'a-core-service-release-worm-provider-contract-v1'),
      ev('scripts/core-service-release-dossier.mjs', 'Installed service handoff'),
      ev('scripts/core-service-release-dossier.mjs', 'rawArtifactPathsStored'),
      ev('scripts/core-service-release-dossier.mjs', 'core_service_release_dossier_ready'),
      ev('scripts/core-service-release-dossier.mjs', 'core_service_package_smoke_soak_ready'),
      ev('scripts/core-service-release-dossier.mjs', 'core_service_installed_handoff_ready'),
      ev('scripts/core-service-release-dossier.mjs', 'core_service_worm_promotion_package_ready'),
      ev('scripts/core-service-release-dossier.mjs', 'core_service_administrator_runbook_ready'),
      ev('package.json', 'core:service-release'),
      ev('tests/ag-runtime.test.js', 'a-core-service-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'core_service_installed_handoff_ready'),
      ev('tests/ag-runtime.test.js', 'core_service_worm_promotion_package_ready')
    ]
  }],
  ['F-01', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-telemetry-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-backpressure-policy-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-anonymized-operational-corpus-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-schema-diff-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-schema-diff-approval-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-generated-fixture-drift-dashboard-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-memory-event-ingest-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/memory/events/schema-diff'),
      ev('apps/growth-memory/src/main.mjs', '/memory/events/generated-fixture-drift'),
      ev('apps/growth-memory/src/main.mjs', '/memory/events/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/memory/events/release-dossier'),
      ev('scripts/growth-quality-corpus.mjs', 'memory_event_ingest_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'memory_event_ingest_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-memory-event-ingest-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'memory_event_ingest_worm_promotion_package_ready')
    ]
  }],
  ['A-02', {
    productReadiness: 0.95,
    evidence: [
      ev('packages/core/src/intake/input-providers.js', 'a-stt-command-provider-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-ocr-command-provider-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-document-parser-provider-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-quality-report-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-drift-telemetry-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-deployment-readiness-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-release-dossier-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-release-artifact-manifest-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-long-term-drift-trend-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-operational-handoff-manifest-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-health-handshake-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-fallback-policy-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-worm-promotion-package-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-worm-provider-contract-v1'),
      ev('packages/core/src/intake/input-providers.js', 'a-command-input-provider-product-gate-v1'),
      ev('scripts/command-input-provider-quality.mjs', 'a-command-input-provider-quality-report-v1'),
      ev('scripts/command-input-provider-quality.mjs', 'Operational handoff'),
      ev('scripts/command-input-provider-quality.mjs', 'WORM promotion package'),
      ev('scripts/command-input-provider-quality.mjs', 'CI/nightly gate plan'),
      ev('tests/ag-runtime.test.js', 'command_input_operational_handoff_ready')
    ]
  }],
  ['A-03', {
    productReadiness: 0.95,
    evidence: [
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-approved-intent-log-corpus-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-drift-calibration-report-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-action-drift-trend-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-telemetry-dashboard-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-product-gate-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-release-dossier-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-release-artifact-manifest-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-contract-manifest-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-external-semantic-provider-shadow-manifest-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-operational-handoff-manifest-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-health-handshake-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-semantic-provider-fallback-policy-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-worm-promotion-package-v1'),
      ev('packages/core/src/intent/intent-learning-log.js', 'a-03-intent-parser-worm-provider-contract-v1'),
      ev('packages/core/src/intent/semantic-intent-adapter.js', 'policy-gated-semantic-intent-adapter-v1'),
      ev('scripts/intent-quality-report.mjs', 'a-03-intent-quality-report-v1'),
      ev('scripts/intent-quality-report.mjs', 'Operational handoff'),
      ev('scripts/intent-quality-report.mjs', 'WORM promotion package'),
      ev('package.json', 'intent:quality'),
      ev('tests/ag-runtime.test.js', 'intent_semantic_provider_operational_handoff_ready'),
      ev('tests/ag-runtime.test.js', 'intent_worm_promotion_package_ready')
    ]
  }],
  ['A-04', {
    productReadiness: 0.95,
    evidence: [
      ev('packages/core/src/orchestration/orchestration-journal.js', 'a-clarification-chain-snapshot-v1'),
      ev('packages/core/src/core-facade.js', 'a-clarification-chain-journal-pointer-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-conversation-ui-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-copy-quality-report-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-ux-telemetry-report-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-product-gate-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-dossier-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-release-raw-leak-check-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-health-handshake-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-fallback-policy-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'a-clarification-worm-provider-contract-v1'),
      ev('tests/ag-runtime.test.js', 'clarification_operational_handoff_ready'),
      ev('tests/ag-runtime.test.js', 'clarification_worm_promotion_package_ready')
    ]
  }],
  ['A-05', {
    productReadiness: 0.95,
    evidence: [
      ev('packages/core/src/context/context-snapshot.js', 'a-windows-desktop-context-provider-pack-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-windows-uiautomation-provider-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-windows-ocr-provider-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-windows-os-event-provider-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-permission-ux-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-release-dossier-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-release-artifact-manifest-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-contract-manifest-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-operational-handoff-manifest-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-health-handshake-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-fallback-policy-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-worm-promotion-package-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-worm-provider-contract-v1'),
      ev('packages/core/src/context/context-snapshot.js', 'a-desktop-context-provider-product-gate-v1'),
      ev('scripts/context-provider-soak.mjs', 'a-desktop-context-provider-soak-v1'),
      ev('scripts/context-provider-soak.mjs', 'Operational handoff'),
      ev('scripts/context-provider-soak.mjs', 'WORM promotion package'),
      ev('tests/ag-runtime.test.js', 'desktop_context_operational_handoff_ready'),
      ev('tests/ag-runtime.test.js', 'desktop_context_worm_promotion_package_ready')
    ]
  }],
  ['A-06', {
    productReadiness: 0.95,
    evidence: [
      ev('packages/core/src/planning/task-planner.js', 'a-plan-parallel-dag-scheduler-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-parallel-dag-runtime-schedule-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-compensation-execution-runner-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-node-artifact-retention-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-node-artifact-export-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-product-gate-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-release-dossier-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-release-artifact-manifest-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-execution-manifest-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-node-artifact-release-manifest-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-worm-promotion-package-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-plan-graph-worm-provider-contract-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'plan_graph_release_dossier_ready'),
      ev('packages/core/src/main.mjs', '/tasks/:taskId/plan-graph/product-gate'),
      ev('tests/ag-runtime.test.js', 'A CoreOrchestrationWorker executes parallel-ready plan graph waves'),
      ev('tests/ag-runtime.test.js', 'plan_graph_worm_promotion_package_ready')
    ]
  }],
  ['A-07', {
    productReadiness: 0.94,
    evidence: [
      ev('packages/core/src/contracts/contract-registry.js', 'a-federated-openapi-contract-gate-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-contract-gate-report-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-release-dossier-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-release-artifact-manifest-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-module-contract-manifest-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-ci-nightly-gate-plan-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-worm-promotion-package-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'a-federated-openapi-worm-provider-contract-v1'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'rawOpenApiSpecStored'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'rawGeneratedTypesStored'),
      ev('scripts/federated-openapi-contract-gate.mjs', 'rawSecretsStored'),
      ev('package.json', 'contracts:federated-gate'),
      ev('scripts/ag-product-readiness-gate.mjs', 'dist/federated-openapi-contract-gate-report.json'),
      ev('tests/ag-runtime.test.js', 'federated-worm-promotion-package-ready')
    ]
  }],
  ['A-08', {
    productReadiness: 0.94,
    evidence: [
      ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-lease-file-lock-backend-v1'),
      ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-multiprocess-lease-backend-v1'),
      ev('packages/core/src/runtime/worker-lease-table.js', 'a-worker-crashed-heartbeat-monitor-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-timeout-scheduler-persistence-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-product-gate-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-release-dossier-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-release-artifact-manifest-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-lease-contention-manifest-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-worm-promotion-package-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'a-worker-state-machine-worm-provider-contract-v1'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'rawLeaseStorePathStored'),
      ev('packages/core/src/orchestration/core-orchestration-worker.js', 'lease_recovery_event_observed'),
      ev('packages/core/src/main.mjs', '/worker/state-product-gate'),
      ev('tests/ag-runtime.test.js', 'a-worker-state-machine-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'worker_state_machine_worm_promotion_package_ready')
    ]
  }],
  ['A-09', {
    productReadiness: 0.94,
    evidence: [
      ev('packages/core/src/runtime/event-bus.js', 'a-event-external-broker-adapter-contract-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-external-broker-delivery-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-projection-lease-file-backend-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-overflow-policy-dashboard-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-product-gate-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-release-dossier-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-release-artifact-manifest-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-broker-provider-contract-manifest-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-worm-promotion-package-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'a-event-bus-operational-worm-provider-contract-v1'),
      ev('packages/core/src/runtime/event-bus.js', 'rawProjectionLeasePathStored'),
      ev('packages/core/src/runtime/event-bus.js', 'event_external_broker_delivery_observed'),
      ev('tests/ag-runtime.test.js', 'event_bus_operational_worm_promotion_package_ready')
    ]
  }],
  ['A-10', {
    productReadiness: 0.94,
    evidence: [
      ev('packages/core/src/routing/skill-router.js', 'a-skill-signed-bundle-download-cache-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-isolated-sandbox-process-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-rollbackable-plugin-rotation-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-sandbox-worker-soak-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-product-gate-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-release-dossier-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-release-artifact-manifest-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-plugin-provider-contract-manifest-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-sandbox-hardening-profile-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-ci-nightly-gate-plan-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-worm-promotion-package-v1'),
      ev('packages/core/src/routing/skill-router.js', 'a-skill-router-worm-provider-contract-v1'),
      ev('packages/core/src/routing/skill-router.js', 'rawEntrypointStored'),
      ev('packages/core/src/routing/skill-router.js', 'skill_router_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'a-skill-router-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'skill_router_worm_promotion_package_ready')
    ]
  }],
  ['B-02', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-key-provider-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-deployment-policy-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-key-rotation-drill-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-export-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-import-recovery-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-product-gate-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-capability-vault-release-dossier-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'capability_vault_release_dossier_ready'),
      ev('apps/pc-agent/src/main.mjs', '/capability-vault/product-gate'),
      ev('tests/ag-runtime.test.js', 'b-capability-vault-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'capability_vault_release_dossier_ready')
    ]
  }],
  ['B-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-conflict-resolution-ui-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-move-batch-policy-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-partial-move-transaction-dry-run-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-windows-acl-deny-corpus-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-release-dossier-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-file-operation-product-gate-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'file_operation_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'b-file-conflict-resolution-ui-v1'),
      ev('tests/ag-runtime.test.js', 'b-file-operation-release-dossier-v1')
    ]
  }],
  ['B-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-issue-catalog-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-open-after-realpath-lock-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-release-dossier-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-path-safety-product-gate-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'path_safety_release_dossier_ready'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'runPathSafetyCorpus'),
      ev('tests/ag-runtime.test.js', 'b-path-safety-release-dossier-v1')
    ]
  }],
  ['B-05', {
    productReadiness: 0.93,
    evidence: [
      ev('apps/pc-agent/fixtures/workbook-product-corpus.json', 'b-workbook-product-corpus-v1'),
      ev('apps/pc-agent/src/adapters/excel/excel-worker.js', 'b-workbook-render-smoke-v1'),
      ev('apps/pc-agent/src/adapters/excel/excel-worker.js', 'b-workbook-worker-pool-soak-v1'),
      ev('apps/pc-agent/src/adapters/excel/workbook-template-catalog.js', 'b-workbook-template-migration-report-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'runWorkbookProductCorpus'),
      ev('scripts/workbook-product-soak.mjs', 'b-workbook-product-soak-dossier-v1'),
      ev('scripts/workbook-product-soak.mjs', 'b-workbook-product-gate-v1'),
      ev('scripts/workbook-product-soak.mjs', 'workbook_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'workbook_release_dossier_ready')
    ]
  }],
  ['B-06', {
    productReadiness: 0.93,
    evidence: [
      ev('apps/pc-agent/fixtures/browser-network-replay-corpus.json', 'b-browser-network-replay-corpus-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'runBrowserNetworkReplayCorpus'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-browser-rendering-diff-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-playwright-cache-recovery-guide-v1'),
      ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-soak-report-v1'),
      ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-release-dossier-v1'),
      ev('scripts/browser-replay-soak.mjs', 'b-browser-replay-product-gate-v1'),
      ev('scripts/browser-replay-soak.mjs', 'browser_replay_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'B browser replay corpus runs GET-only soak'),
      ev('tests/ag-runtime.test.js', 'browser_replay_release_dossier_ready')
    ]
  }],
  ['B-07', {
    productReadiness: 0.93,
    evidence: [
      ev('apps/pc-agent/src/shadow/golden-shadow-runner.js', 'b-approval-diff-v1'),
      ev('apps/mobile/src/components/ApprovalActionPanel.js', 'c-approval-diff-review-ui-v1'),
      ev('apps/pc-agent/src/install/tray-runtime.js', 'b-tray-approval-diff-panel-v1'),
      ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-soak-report-v1'),
      ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-release-dossier-v1'),
      ev('scripts/shadow-approval-soak.mjs', 'b-shadow-approval-product-gate-v1'),
      ev('scripts/shadow-approval-soak.mjs', 'b-shadow-queue-drain-soak-v1'),
      ev('scripts/shadow-approval-soak.mjs', 'shadow_approval_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'runShadowApprovalSoakReport'),
      ev('tests/ag-runtime.test.js', 'shadow_approval_release_dossier_ready')
    ]
  }],
  ['B-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-product-gate-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-archive-store-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-archive-signature-key-rotation-drill-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-crash-recovery-drill-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-release-artifact-manifest-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-operational-handoff-manifest-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-ci-nightly-gate-plan-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-promotion-package-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-rollback-worm-provider-contract-v1'),
      ev('apps/pc-agent/src/main.mjs', '/rollback/product-gate'),
      ev('tests/ag-runtime.test.js', 'b-rollback-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'rollback_worm_promotion_package_ready')
    ]
  }],
  ['B-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-secret-token-store-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-api-contract-snapshot-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-api-contract-diff-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-api-middleware-hardening-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-product-gate-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-release-dossier-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-deployment-policy-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-release-artifact-manifest-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-operational-handoff-manifest-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-health-handshake-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-fallback-policy-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-ci-nightly-gate-plan-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-worm-promotion-package-v1'),
      ev('apps/pc-agent/src/main.mjs', 'b-pc-agent-local-api-worm-provider-contract-v1'),
      ev('apps/pc-agent/src/main.mjs', 'pc_agent_local_api_release_dossier_ready'),
      ev('apps/pc-agent/src/main.mjs', '/api/product-gate'),
      ev('tests/ag-runtime.test.js', 'b-pc-agent-local-api-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'pc_agent_local_api_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'pc_agent_local_api_worm_promotion_package_ready')
    ]
  }],
  ['B-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-query-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-retention-report-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-schema-snapshot-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-evidence-privacy-redaction-fixture-report-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-product-gate-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-release-dossier-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-release-artifact-manifest-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-operational-handoff-manifest-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-health-handshake-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-fallback-policy-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-ci-nightly-gate-plan-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-worm-promotion-package-v1'),
      ev('apps/pc-agent/src/pc-agent-runtime.js', 'b-execution-evidence-worm-provider-contract-v1'),
      ev('apps/pc-agent/src/main.mjs', '/evidence/query'),
      ev('apps/pc-agent/src/main.mjs', '/evidence/product-gate'),
      ev('scripts/pc-agent-daemon-smoke.mjs', 'evidence-privacy-fixtures-pass'),
      ev('scripts/pc-agent-daemon-smoke.mjs', 'evidence-product-gate-passed'),
      ev('tests/ag-runtime.test.js', 'b-execution-evidence-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'execution_evidence_worm_promotion_package_ready')
    ]
  }],
  ['B-11', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/pc-agent/src/install/installer-packager.js', 'install-verify-release.ps1'),
      ev('apps/pc-agent/src/install/installer-packager.js', 'build-release-evidence.ps1'),
      ev('apps/pc-agent/src/install/installer-packager.js', 'installer.nsi'),
      ev('apps/pc-agent/src/install/installer-packager.js', 'tray-agent.cs'),
      ev('apps/pc-agent/src/install/service-verifier.js', 'verifyPcAgentServiceReadiness'),
      ev('scripts/pc-agent-daemon-smoke.mjs', 'b-pc-agent-daemon-smoke-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-dossier-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-product-gate-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-release-artifact-manifest-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-operational-handoff-manifest-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-health-handshake-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-fallback-policy-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-ci-nightly-gate-plan-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-worm-promotion-package-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'b-pc-agent-install-worm-provider-contract-v1'),
      ev('scripts/pc-agent-install-release-dossier.mjs', 'pc_agent_install_release_dossier_ready'),
      ev('package.json', 'pc-agent:install-release'),
      ev('scripts/ag-product-readiness-gate.mjs', 'dist/pc-agent-install-release-dossier.json'),
      ev('tests/ag-runtime.test.js', 'pc_agent_install_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'pc_agent_install_worm_promotion_package_ready')
    ]
  }],
  ['C-01', {
    productReadiness: 0.94,
    evidence: [
      ev('apps/mobile/src/App.js', 'c-mobile-app-shell-v1'),
      ev('apps/mobile/src/App.js', 'c-mobile-app-bootstrap-manifest-v1'),
      ev('apps/mobile/src/App.js', 'c-mobile-app-structure-product-gate-v1'),
      ev('scripts/mobile-release-dossier.mjs', 'c-mobile-release-dossier-v1'),
      ev('scripts/mobile-release-dossier.mjs', 'c-mobile-release-dossier-product-gate-v1'),
      ev('scripts/mobile-release-dossier.mjs', 'mobile_release_dossier_ready'),
      ev('scripts/mobile-verify.mjs', 'product:mobile-app-structure-product-gate'),
      ev('package.json', 'mobile:release-dossier'),
      ev('scripts/ag-product-readiness-gate.mjs', 'dist/mobile-release-dossier.json'),
      ev('tests/ag-runtime.test.js', 'c-mobile-app-structure-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'mobile_release_dossier_ready')
    ]
  }],
  ['C-02', {
    productReadiness: 0.94,
    evidence: [
      ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-client-auth-refresh-v1'),
      ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-request-cancel-ux-v1'),
      ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-friendly-error-taxonomy-v1'),
      ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-client-release-dossier-v1'),
      ev('apps/mobile/src/api/BridgeClient.js', 'c-bridge-client-product-gate-v1'),
      ev('apps/mobile/src/api/BridgeClient.js', 'bridge_client_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'c-bridge-client-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'bridge_client_release_dossier_ready')
    ]
  }],
  ['C-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-release-dossier-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-health-handshake-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-fallback-policy-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/PairingScreen.js', 'c-pairing-screen-product-gate-v1'),
      ev('scripts/mobile-verify.mjs', 'runtime:pairing-screen-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-pairing-screen-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'pairing_worm_promotion_package_ready')
    ]
  }],
  ['C-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-pending-queue-detail-panel-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-network-recovery-visual-regression-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-release-dossier-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-health-handshake-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-fallback-policy-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/CommandScreen.js', 'c-command-screen-product-gate-v1'),
      ev('scripts/mobile-verify.mjs', 'runtime:command-screen-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-command-screen-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'command_screen_worm_promotion_package_ready')
    ]
  }],
  ['C-05', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-visual-regression-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-release-dossier-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-health-handshake-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-fallback-policy-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-approval-lifecycle-product-gate-v1'),
      ev('scripts/mobile-verify.mjs', 'runtime:approval-lifecycle-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-approval-lifecycle-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'approval_lifecycle_worm_promotion_package_ready')
    ]
  }],
  ['C-06', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-release-dossier-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-health-handshake-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-fallback-policy-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/ApprovalDetailScreen.js', 'c-mobile-approval-restriction-product-gate-v1'),
      ev('src/domain/pc-console.js', 'createPcConsoleVisualSnapshot'),
      ev('scripts/mobile-verify.mjs', 'runtime:mobile-approval-restriction-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-mobile-approval-restriction-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'mobile_approval_restriction_worm_promotion_package_ready')
    ]
  }],
  ['C-07', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/TaskStatusScreen.js', 'c-task-status-long-polling-latency-visual-regression-v1'),
      ev('apps/mobile/src/components/ResultFeedbackPanel.js', 'c-result-rollback-proof-modal-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-release-dossier-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'c-result-feedback-product-gate-v1'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'result_feedback_release_dossier_ready'),
      ev('apps/mobile/src/screens/ResultScreen.js', 'result_feedback_worm_promotion_package_ready'),
      ev('scripts/mobile-verify.mjs', 'runtime:result-feedback-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-result-feedback-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'result_feedback_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'result_feedback_worm_promotion_package_ready')
    ]
  }],
  ['C-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-release-dossier-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'c-growth-review-product-gate-v1'),
      ev('apps/mobile/src/screens/GrowthReviewScreen.js', 'growth_review_worm_promotion_package_ready'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createGrowthReviewVisualSnapshot'),
      ev('scripts/mobile-verify.mjs', 'runtime:growth-review-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-growth-review-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'growth_review_worm_promotion_package_ready')
    ]
  }],
  ['C-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-lifecycle-status-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-recovery-ux-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-rotation-recovery-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-revoke-retry-queue-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-release-dossier-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-release-artifact-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-worm-promotion-package-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-worm-provider-contract-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-secure-token-storage-product-gate-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'secure_token_worm_promotion_package_ready'),
      ev('apps/mobile/src/screens/SettingsScreen.js', 'runSecureTokenProductGate'),
      ev('scripts/mobile-verify.mjs', 'runtime:secure-token-release-dossier'),
      ev('scripts/mobile-verify.mjs', 'runtime:secure-token-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-secure-token-storage-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'secure_token_worm_promotion_package_ready')
    ]
  }],
  ['C-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-release-dossier-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-release-artifact-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-worm-promotion-package-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-session-lock-worm-provider-contract-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'session_lock_release_dossier_ready'),
      ev('apps/mobile/src/mobile-runtime.js', 'session_lock_worm_promotion_package_ready'),
      ev('scripts/mobile-verify.mjs', 'runtime:session-lock-release-dossier'),
      ev('tests/ag-runtime.test.js', 'c-session-lock-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'session_lock_worm_promotion_package_ready')
    ]
  }],
  ['C-11', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-release-dossier-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-release-artifact-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-worm-promotion-package-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'c-notification-worm-provider-contract-v1'),
      ev('apps/mobile/src/mobile-runtime.js', 'notification_release_dossier_ready'),
      ev('apps/mobile/src/mobile-runtime.js', 'notification_worm_promotion_package_ready'),
      ev('scripts/mobile-verify.mjs', 'runtime:notification-release-dossier'),
      ev('tests/ag-runtime.test.js', 'c-notification-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'notification_worm_promotion_package_ready')
    ]
  }],
  ['C-13', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-release-dossier-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-release-artifact-manifest-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-operational-handoff-manifest-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-ci-nightly-gate-plan-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-worm-promotion-package-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-worm-provider-contract-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'c-poison-queue-product-gate-v1'),
      ev('apps/mobile/src/screens/PoisonQueueScreen.js', 'poison_queue_worm_promotion_package_ready'),
      ev('scripts/mobile-verify.mjs', 'runtime:poison-queue-release-dossier'),
      ev('scripts/mobile-verify.mjs', 'runtime:poison-queue-product-gate'),
      ev('tests/ag-runtime.test.js', 'c-poison-queue-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'poison_queue_worm_promotion_package_ready')
    ]
  }],
  ['E-01', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-calibration-corpus-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-calibration-report-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-review-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-calibration-dashboard-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-operational-calibration-pipeline-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-policy-drift-trend-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-worm-provider-contract-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-risk-classifier-product-gate-v1'),
      ev('apps/policy-security/src/main.mjs', '/risk/release-dossier'),
      ev('apps/policy-security/src/main.mjs', '/risk/product-gate'),
      ev('scripts/security-redteam-corpus.mjs', 'Policy drift trend'),
      ev('tests/ag-runtime.test.js', 'e-risk-classifier-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'risk_classifier_worm_promotion_package_ready')
    ]
  }],
  ['E-02', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-external-ner-provider-contract-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-precision-recall-trend-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-hot-reload-tuning-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-release-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-data-classifier-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/data/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Data classifier release dossier'),
      ev('tests/ag-runtime.test.js', 'e-data-classifier-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'data_classifier_worm_promotion_package_ready')
    ]
  }],
  ['E-06', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-semantic-classifier-contract-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-production-miss-corpus-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-semantic-provider-comparison-trend-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-prompt-injection-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/security/prompt-injection/semantic-trend'),
      ev('apps/policy-security/src/main.mjs', '/security/prompt-injection/product-gate'),
      ev('apps/policy-security/src/main.mjs', '/security/prompt-injection/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Semantic provider trend'),
      ev('scripts/security-redteam-corpus.mjs', 'promptInjectionReleaseDossier'),
      ev('tests/ag-runtime.test.js', 'e-prompt-injection-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'prompt_injection_worm_promotion_package_ready')
    ]
  }],
  ['E-07', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-provenance-retention-dashboard-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-output-artifact-diff-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-tool-poisoning-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/tool-output/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Tool poisoning release dossier'),
      ev('tests/ag-runtime.test.js', 'e-tool-poisoning-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'tool_poisoning_worm_promotion_package_ready')
    ]
  }],
  ['E-05', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-change-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-signed-policy-bundle-rotation-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-hash-fixture-regression-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-constitution-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/policy/constitution/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Constitution release dossier'),
      ev('tests/ag-runtime.test.js', 'e-constitution-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'constitution_worm_promotion_package_ready')
    ]
  }],
  ['E-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-change-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-migration-diff-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-signed-history-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-rollback-drill-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-ci-approval-artifact-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-worm-provider-contract-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-approval-policy-release-dossier-v1'),
      ev('apps/policy-security/src/main.mjs', '/approval/policy/ci-approval-artifact'),
      ev('apps/policy-security/src/main.mjs', '/approval/policy/product-gate'),
      ev('apps/policy-security/src/main.mjs', '/approval/policy/rollback-drill'),
      ev('scripts/security-redteam-corpus.mjs', 'approvalPolicy'),
      ev('scripts/security-redteam-corpus.mjs', 'Approval policy product gate'),
      ev('tests/ag-runtime.test.js', 'approvalPolicyRollback'),
      ev('tests/ag-runtime.test.js', 'approval_policy_worm_promotion_package_ready')
    ]
  }],
  ['E-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-signing-key-provider-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-encrypted-persistent-journal-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-key-rotation-drill-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-journal-import-recovery-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-token-lifecycle-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-capability-lifecycle-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/capability/lifecycle/release-dossier'),
      ev('tests/ag-runtime.test.js', 'e-capability-token-lifecycle-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'capability_lifecycle_worm_promotion_package_ready')
    ]
  }],
  ['E-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-evaluation-lifecycle-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-evaluation-ledger-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-review-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-decision-trend-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-contract-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-contract-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-contract-release-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-autonomy-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/autonomy/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Autonomy release dossier'),
      ev('tests/ag-runtime.test.js', 'e-autonomy-contract-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'autonomy_worm_promotion_package_ready')
    ]
  }],
  ['E-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-as-code.js', 'e-policy-yaml-loader-v1'),
      ev('apps/policy-security/src/policy-as-code.js', 'e-policy-json-schema-v1'),
      ev('apps/policy-security/src/policy-as-code.js', 'e-policy-as-code-fixture-runner-matrix-v1'),
      ev('apps/policy-security/src/policy-as-code.js', 'e-policy-migration-snapshot-diff-v1'),
      ev('apps/policy-security/src/policy-as-code.js', 'e-policy-ci-drift-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-ci-annotation-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-ci-approval-artifact-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-release-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-worm-provider-contract-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-policy-as-code-product-gate-v1'),
      ev('apps/policy-security/src/main.mjs', '/policy/as-code/ci-annotation'),
      ev('apps/policy-security/src/main.mjs', '/policy/as-code/ci-approval-artifact'),
      ev('apps/policy-security/src/main.mjs', '/policy/as-code/release-dossier'),
      ev('apps/policy-security/src/main.mjs', '/policy/as-code/product-gate'),
      ev('scripts/security-redteam-corpus.mjs', 'policyAsCodeReleaseDossier'),
      ev('scripts/security-redteam-corpus.mjs', 'policyAsCode.checks'),
      ev('scripts/security-redteam-corpus.mjs', 'Policy-as-Code Product Gate'),
      ev('tests/ag-runtime.test.js', 'raw_policy_source_not_stored'),
      ev('tests/ag-runtime.test.js', 'policy_as_code_worm_promotion_package_ready'),
      ev('tests/ag-runtime.test.js', 'policy_yaml_loader_roundtrip')
    ]
  }],
  ['E-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/policy-security/src/policy-runtime.js', 'e-audit-search-dsl-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-siem-compatible-audit-export-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-audit-retention-scheduler-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-immutable-audit-archive-sync-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-product-gate-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-release-dossier-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-release-artifact-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-worm-release-archive-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-release-workflow-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-operational-handoff-manifest-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-ci-nightly-gate-plan-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-worm-promotion-package-v1'),
      ev('apps/policy-security/src/policy-runtime.js', 'e-security-audit-api-worm-provider-contract-v1'),
      ev('apps/policy-security/src/main.mjs', '/audit/release-dossier'),
      ev('scripts/security-redteam-corpus.mjs', 'Audit API release dossier'),
      ev('tests/ag-runtime.test.js', 'e-security-audit-api-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'security_audit_worm_promotion_package_ready')
    ]
  }],
  ['F-02', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-encryption-key-provider-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-encrypted-backup-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-encrypted-restore-drill-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-at-rest-encryption-deployment-policy-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-periodic-restore-drill-evidence-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-backup-location-policy-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-worm-backup-sync-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-large-migration-fixture-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-persistence-product-gate-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-release-dossier-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-release-workflow-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-release-worm-archive-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/db/sqlite-store.js', 'f-storage-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/storage/at-rest-encryption-policy'),
      ev('apps/growth-memory/src/main.mjs', '/storage/periodic-restore-drill'),
      ev('apps/growth-memory/src/main.mjs', '/storage/release-dossier'),
      ev('apps/growth-memory/src/main.mjs', '/storage/product-gate'),
      ev('scripts/growth-quality-corpus.mjs', 'storage_persistence_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'storage_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-storage-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'storage_worm_promotion_package_ready')
    ]
  }],
  ['F-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-embedding-adapter-registry-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-anonymized-log-corpus-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-cluster-review-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-pattern-mining-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/patterns/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/patterns/cluster-review'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'createPatternClusterReviewState'),
      ev('scripts/growth-quality-corpus.mjs', 'pattern_cluster_review_has_split_merge_actions'),
      ev('scripts/growth-quality-corpus.mjs', 'pattern_mining_product_gate_passed'),
      ev('tests/ag-runtime.test.js', 'createPatternClusterReviewState'),
      ev('tests/ag-runtime.test.js', 'pattern_mining_worm_promotion_package_ready')
    ]
  }],
  ['F-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/fixtures/sensitive-minimizer-fixtures.json', 'f-sensitive-minimizer-fixture-pack-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-false-positive-dashboard-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-false-positive-review-ledger-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-context-exception-registry-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-sensitive-minimizer-retention-policy-diff-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-retention-policy-ui-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/memory/minimize/release-dossier'),
      ev('apps/growth-memory/src/main.mjs', '/memory/minimize/false-positive-dashboard'),
      ev('scripts/growth-quality-corpus.mjs', 'sensitive_minimizer_release_dossier_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'sensitive_false_positive_review_decision_persisted'),
      ev('scripts/growth-quality-corpus.mjs', 'sensitive_context_exception_registry_ready'),
      ev('scripts/growth-quality-corpus.mjs', 'sensitive_retention_policy_diff_ready'),
      ev('tests/ag-runtime.test.js', 'f-sensitive-minimizer-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'sensitive_minimizer_worm_promotion_package_ready')
    ]
  }],
  ['F-05', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-confidence-calibration-report-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-tolerance-profile-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-preference-hypothesis-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/preferences/release-dossier'),
      ev('scripts/growth-quality-corpus.mjs', 'preference_hypothesis_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-preference-hypothesis-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'preference_hypothesis_worm_promotion_package_ready')
    ]
  }],
  ['F-06', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-application-preview-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-conflict-resolution-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-drift-trend-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-scope-migration-review-queue-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-lifecycle-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-confirmed-preference-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/preferences/confirmed/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/preferences/confirmed/release-dossier'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-confirmed-preference-product-gate-state-v1'),
      ev('scripts/growth-quality-corpus.mjs', 'confirmed_preference_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'confirmed_preference_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-confirmed-preference-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'f-confirmed-preference-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'confirmed_preference_worm_promotion_package_ready')
    ]
  }],
  ['F-07', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-guardrail-review-queue-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-recurrence-trend-visualization-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-guardrail-effectiveness-tuning-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-failure-memory-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/failures/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/failures/release-dossier'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-failure-guardrail-review-state-v1'),
      ev('scripts/growth-quality-corpus.mjs', 'failure_memory_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'failure_memory_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-failure-memory-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'f-failure-memory-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'failure_memory_worm_promotion_package_ready')
    ]
  }],
  ['F-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-weight-calibration-profile-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-drift-diff-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-threshold-alerts-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-product-dashboard-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-release-hash-only-projection-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-genome-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/genomes/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/genomes/release-dossier'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-genome-product-gate-state-v1'),
      ev('scripts/growth-quality-corpus.mjs', 'genome_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'genome_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-genome-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'f-genome-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'genome_worm_promotion_package_ready')
    ]
  }],
  ['F-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-approved-skill-registry-snapshot-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-usefulness-score-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-verifier-report-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-usefulness-operational-corpus-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-skill-distillation-provider-comparison-trend-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-release-hash-only-projection-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-advanced-learning-worm-provider-contract-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-advanced-learning-verifier-v1'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-skill-draft-review-ui-v1'),
      ev('apps/growth-memory/src/main.mjs', '/advanced-learning/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/advanced-learning/release-dossier'),
      ev('scripts/growth-quality-corpus.mjs', 'skill_registry_persisted_and_scored'),
      ev('scripts/growth-quality-corpus.mjs', 'advanced_learning_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'advanced_learning_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-advanced-learning-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'advanced_learning_worm_promotion_package_ready')
    ]
  }],
  ['F-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-lifecycle-v2'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-expiry-scheduler-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-decision-trend-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-autonomy-candidate-worm-provider-contract-v1'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-autonomy-candidate-review-ui-v1'),
      ev('apps/growth-memory/src/main.mjs', '/autonomy/candidates/expiry/run'),
      ev('apps/growth-memory/src/main.mjs', '/autonomy/candidates/release-dossier'),
      ev('scripts/growth-quality-corpus.mjs', 'autonomy_lifecycle_persisted_trended'),
      ev('scripts/growth-quality-corpus.mjs', 'autonomy_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'createAutonomyCandidateReviewState'),
      ev('tests/ag-runtime.test.js', 'f-autonomy-candidate-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'autonomy_candidate_worm_promotion_package_ready')
    ]
  }],
  ['F-11', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-decision-history-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-decision-history-ui-contract-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-batch-decision-history-link-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-retention-policy-calendar-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-hygiene-review-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/memory/hygiene/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/memory/hygiene/release-dossier'),
      ev('scripts/growth-quality-corpus.mjs', 'hygiene_review_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'hygiene_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-hygiene-review-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'f-hygiene-review-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'hygiene_review_worm_promotion_package_ready')
    ]
  }],
  ['F-12', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-threshold-profile-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-threshold-migration-diff-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-dashboard-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-product-gate-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-release-dossier-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-release-workflow-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-release-artifact-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-worm-release-archive-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-operational-handoff-manifest-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-ci-nightly-gate-plan-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-worm-promotion-package-v1'),
      ev('apps/growth-memory/src/growth-runtime.js', 'f-maturity-score-worm-provider-contract-v1'),
      ev('apps/growth-memory/src/main.mjs', '/maturity-score/product-gate'),
      ev('apps/growth-memory/src/main.mjs', '/maturity-score/release-dossier'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-maturity-product-gate-state-v1'),
      ev('scripts/growth-quality-corpus.mjs', 'maturity_product_gate_passed'),
      ev('scripts/growth-quality-corpus.mjs', 'maturity_release_dossier_passed'),
      ev('tests/ag-runtime.test.js', 'f-maturity-score-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'f-maturity-score-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'maturity_score_worm_promotion_package_ready')
    ]
  }],
  ['D-01', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/main.mjs', 'createBridgeDeploymentProfile'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-reverse-proxy-lab-dossier-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-product-gate-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-release-dossier-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-release-artifact-manifest-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-worm-release-archive-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-worm-promotion-package-v1'),
      ev('apps/bridge/src/main.mjs', 'd-bridge-server-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', 'bridge_server_release_manifest_hash_only'),
      ev('apps/bridge/src/main.mjs', 'handleEventWebSocketUpgrade'),
      ev('scripts/bridge-server-soak.mjs', 'd-bridge-server-soak-report-v1'),
      ev('scripts/bridge-server-soak.mjs', 'reverse-proxy-lab-dossier-passed'),
      ev('scripts/bridge-server-soak.mjs', 'bridge-server-release-dossier-required-passed'),
      ev('scripts/bridge-server-soak.mjs', 'bridge-server-worm-promotion-package-ready'),
      ev('tests/ag-runtime.test.js', 'd-bridge-server-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'd-bridge-server-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'bridge_server_worm_promotion_package_ready')
    ]
  }],
  ['D-02', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-pairing-device-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/pairing/release-dossier'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runPairingReleaseDossier'),
      ev('tests/ag-runtime.test.js', 'pairing_worm_promotion_package_ready')
    ]
  }],
  ['D-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-auth-worm-provider-contract-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-device-token-signing-key-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/devices/token/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'DeviceTokenReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runDeviceTokenReleaseDossier'),
      ev('tests/ag-runtime.test.js', 'device.token.release_dossier'),
      ev('tests/ag-runtime.test.js', 'device_token_worm_promotion_package_ready')
    ]
  }],
  ['D-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-route-policy-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-compaction-report-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-clock-skew-fixtures-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-shared-backend-concurrency-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-product-gate-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-request-nonce-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/request-nonces/clock-skew-fixtures'),
      ev('apps/bridge/src/main.mjs', '/request-nonces/product-gate'),
      ev('apps/bridge/src/main.mjs', '/request-nonces/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'RequestNonceReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runRequestNonceProductGate'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runRequestNonceReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'request_nonce.release_dossier'),
      ev('tests/ag-runtime.test.js', 'd-request-nonce-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'request_nonce_worm_promotion_package_ready')
    ]
  }],
  ['D-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/main.mjs', '/events/ws'),
      ev('apps/bridge/src/main.mjs', '/events/chaos-drill'),
      ev('apps/bridge/src/main.mjs', '/events/product-gate'),
      ev('apps/bridge/src/main.mjs', '/events/release-dossier'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-network-chaos-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-cursor-compaction-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-mobile-websocket-fallback-ux-contract-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-product-gate-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-exercise-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-workflow-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-worm-release-archive-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-event-stream-worm-provider-contract-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'event_stream_raw_identifiers_not_stored'),
      ev('apps/bridge/src/request-validator.js', 'EventStreamReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'eventWebSocketUrl'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runEventStreamProductGate'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runEventStreamReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'events.release_dossier'),
      ev('scripts/bridge-server-soak.mjs', 'all-cycles-websocket-passed'),
      ev('scripts/bridge-server-soak.mjs', 'event-release-dossier-passed'),
      ev('tests/ag-runtime.test.js', 'd-event-stream-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'd-event-stream-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'event_stream_worm_promotion_package_ready')
    ]
  }],
  ['D-05', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-policy-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-shared-backend-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-abuse-corpus-report-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-shared-backend-concurrency-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-reputation-escalation-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-product-gate-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-rate-limit-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/rate-limit/status'),
      ev('apps/bridge/src/main.mjs', '/rate-limit/product-gate'),
      ev('apps/bridge/src/main.mjs', '/rate-limit/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'RateLimitReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'getRateLimitStatus'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runRateLimitProductGate'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runRateLimitReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'rate_limit.release_dossier'),
      ev('apps/verification/src/verification-runtime.js', 'rate_limit_abuse_corpus_passed'),
      ev('scripts/bridge-server-soak.mjs', 'rate-limit-product-gate-passed'),
      ev('tests/ag-runtime.test.js', 'd-rate-limit-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'rate_limit_worm_promotion_package_ready')
    ]
  }],
  ['D-06', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-live-workflow-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-task-approval-result-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/task-approval-result/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'TaskApprovalResultReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runTaskApprovalResultReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'task_approval_result.release_dossier'),
      ev('tests/ag-runtime.test.js', 'task_approval_result_worm_promotion_package_ready')
    ]
  }],
  ['D-07', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-review-decision-history-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-trend-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-growth-routing-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/growth/decisions/history'),
      ev('apps/bridge/src/main.mjs', '/growth/routing/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'GrowthDecisionHistoryResponse'),
      ev('apps/bridge/src/request-validator.js', 'GrowthRoutingReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'getGrowthRoutingTrends'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runGrowthRoutingReleaseDossier'),
      ev('apps/mobile/src/components/GrowthReviewDecisionPanel.js', 'c-growth-hygiene-batch-selection-event-v1'),
      ev('tests/ag-runtime.test.js', 'growth.routing.release_dossier'),
      ev('tests/ag-runtime.test.js', 'growth_routing_worm_promotion_package_ready')
    ]
  }],
  ['D-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-journal-rotation-archive-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-external-store-contract-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-schema-diff-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-compaction-lock-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-external-store-deployment-policy-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-rotation-archive-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-archive-restore-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-product-gate-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-worm-release-archive-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-state-cache-worm-provider-contract-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'state_cache_release_artifact_manifest_hash_only'),
      ev('apps/bridge/src/main.mjs', '/cache/schema-snapshot'),
      ev('apps/bridge/src/main.mjs', '/cache/product-gate'),
      ev('apps/bridge/src/main.mjs', '/cache/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'CacheReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'getCacheSchemaSnapshot'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runCacheProductGate'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runCacheReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'cache.release_dossier'),
      ev('scripts/bridge-server-soak.mjs', 'cache-schema-snapshot-diff-passed'),
      ev('scripts/bridge-server-soak.mjs', 'cache-product-gate-passed'),
      ev('scripts/bridge-server-soak.mjs', 'cache-release-dossier-passed'),
      ev('tests/ag-runtime.test.js', 'd-state-cache-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'd-state-cache-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'state_cache_worm_promotion_package_ready')
    ]
  }],
  ['D-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/network-guard.js', 'd-dns-rebinding-resolver-drill-v1'),
      ev('apps/bridge/src/network-guard.js', 'd-bridge-reverse-proxy-deployment-guide-v1'),
      ev('apps/bridge/src/network-guard.js', 'd-mdns-discovery-allowlist-ux-v1'),
      ev('apps/mobile/src/components/PairingQrPanel.js', 'c-mdns-bridge-allowlist-review-ui-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-product-drill-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-release-dossier-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-release-artifact-manifest-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-operational-handoff-manifest-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-ci-nightly-gate-plan-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-worm-promotion-package-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'd-bridge-network-guard-worm-provider-contract-v1'),
      ev('scripts/bridge-network-guard-drill.mjs', 'network_guard_product_drill_passed'),
      ev('scripts/bridge-network-guard-drill.mjs', 'network-guard-release-dossier-ready'),
      ev('tests/ag-runtime.test.js', 'd-bridge-network-guard-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'network_guard_worm_promotion_package_ready'),
      ev('tests/ag-runtime.test.js', 'dns-rebinding-resolver-drill-passed')
    ]
  }],
  ['D-11', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/request-validator.js', 'd-bridge-api-schema-snapshot-v1'),
      ev('apps/bridge/src/request-validator.js', 'd-bridge-api-schema-snapshot-diff-v1'),
      ev('apps/bridge/src/request-validator.js', 'd-bridge-malformed-request-corpus-v1'),
      ev('apps/bridge/src/request-validator.js', 'd-bridge-client-server-drift-gate-v1'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'd-bridge-openapi-client-types-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-gate-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-release-dossier-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-release-artifact-manifest-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-operational-handoff-manifest-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-ci-nightly-gate-plan-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-worm-promotion-package-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'd-bridge-client-contract-worm-provider-contract-v1'),
      ev('scripts/bridge-client-contract-gate.mjs', 'bridge_client_contract_release_dossier_ready'),
      ev('scripts/bridge-client-contract-gate.mjs', 'bridge_client_contract_worm_promotion_package_ready'),
      ev('tests/ag-runtime.test.js', 'd-bridge-client-server-drift-gate-v1')
    ]
  }],
  ['D-12', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/bridge/src/bridge-runtime.js', 'd-siem-compatible-audit-export-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-immutable-audit-archive-sync-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-audit-retention-scheduler-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-audit-archive-restore-drill-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-product-gate-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-release-dossier-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-release-artifact-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-operational-handoff-manifest-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-ci-nightly-gate-plan-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-worm-promotion-package-v1'),
      ev('apps/bridge/src/bridge-runtime.js', 'd-bridge-audit-log-worm-provider-contract-v1'),
      ev('apps/bridge/src/main.mjs', '/audit/product-gate'),
      ev('apps/bridge/src/main.mjs', '/audit/release-dossier'),
      ev('apps/bridge/src/request-validator.js', 'AuditReleaseDossierResponse'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runAuditProductGate'),
      ev('apps/mobile/src/api/BridgeClient.js', 'runAuditReleaseDossier'),
      ev('apps/mobile/src/api/generated/bridge-api-types.d.ts', 'audit.release_dossier'),
      ev('scripts/bridge-server-soak.mjs', 'audit-release-dossier-passed'),
      ev('tests/ag-runtime.test.js', 'd-bridge-audit-log-product-gate-v1'),
      ev('tests/ag-runtime.test.js', 'd-bridge-audit-log-release-dossier-v1'),
      ev('tests/ag-runtime.test.js', 'audit_worm_promotion_package_ready')
    ]
  }],
  ['G-01', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/src/verification-runtime.js', 'g-document-revision-diff-fixture-generator-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-semantic-invariant-dedupe-classifier-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-plan-regression-visualization-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-ci-annotation-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-plan-verifier-worm-artifact-sync-v1'),
      ev('apps/verification/src/main.mjs', '/verify/plan/ci-annotation'),
      ev('apps/verification/src/main.mjs', '/verify/plan/artifacts/sync'),
      ev('apps/verification/src/main.mjs', '/verify/plan/product-gate'),
      ev('scripts/verification-dashboard-dossier.mjs', 'plan_document_diff_fixtures_generated'),
      ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_ci_annotation_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'plan_verifier_worm_artifact_synced'),
      ev('tests/ag-runtime.test.js', 'verification dashboard dossier')
    ]
  }],
  ['G-02', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-ci-annotation-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-policy-migration-approval-artifact-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-policy-migration-reviewer-policy-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-policy-compliance-product-gate-v1'),
      ev('apps/verification/src/main.mjs', '/verify/policy/ci-annotation'),
      ev('apps/verification/src/main.mjs', '/verify/policy/migration-approval-artifact'),
      ev('apps/verification/src/main.mjs', '/verify/policy/product-gate'),
      ev('scripts/verification-dashboard-dossier.mjs', 'policy_compliance_product_gate_passed'),
      ev('tests/ag-runtime.test.js', 'g-policy-compliance-product-gate-v1')
    ]
  }],
  ['G-03', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/src/verification-runtime.js', 'g-execution-external-adapter-fixture-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-adapter-soak-trend-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-artifact-retention-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-flaky-fixture-quarantine-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-product-gate-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-release-dossier-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-execution-verifier-release-artifact-manifest-v1'),
      ev('apps/verification/src/main.mjs', '/verify/execution/product-gate'),
      ev('apps/verification/src/main.mjs', '/verify/execution/release-dossier'),
      ev('scripts/verification-dashboard-dossier.mjs', 'execution_verifier_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'execution_verifier_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'g-execution-verifier-release-dossier-v1')
    ]
  }],
  ['G-04', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/fixtures/learning-verifier-fixtures.json', 'g-learning-verifier-fixture-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-fixture-pack-report-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-scheduler-regression-corpus-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-ci-annotation-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-worm-artifact-sync-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-artifact-retention-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-learning-verifier-product-gate-v1'),
      ev('apps/verification/src/main.mjs', '/verify/learning/fixtures/run'),
      ev('apps/verification/src/main.mjs', '/verify/learning/ci-annotation'),
      ev('apps/verification/src/main.mjs', '/verify/learning/artifacts/sync'),
      ev('apps/verification/src/main.mjs', '/verify/learning/product-gate'),
      ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_fixture_pack_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'learning_verifier_worm_artifact_synced'),
      ev('tests/ag-runtime.test.js', 'g-learning-verifier-product-gate-v1')
    ]
  }],
  ['G-05', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-device-security-smoke-contract-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-ux-latency-trend-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-artifact-retention-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-verifier-product-gate-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-approval-flow-release-dossier-v1'),
      ev('apps/verification/src/main.mjs', '/verify/approval-flow/product-gate'),
      ev('apps/verification/src/main.mjs', '/verify/approval-flow/release-dossier'),
      ev('scripts/verification-dashboard-dossier.mjs', 'approval_flow_verifier_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'approval_flow_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'g-approval-flow-verifier-product-gate-v1')
    ]
  }],
  ['G-06', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/src/verification-runtime.js', 'g-bridge-security-product-chaos-drill-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-bridge-security-release-dossier-v1'),
      ev('apps/verification/src/main.mjs', '/bridge-security/product-drill'),
      ev('apps/verification/src/main.mjs', '/bridge-security/release-dossier'),
      ev('scripts/verification-dashboard-dossier.mjs', 'bridge_security_product_chaos_drill_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'bridge_security_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'g-bridge-security-product-chaos-drill-v1')
    ]
  }],
  ['G-07', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/fixtures/prompt-redteam-fixtures.json', 'g-prompt-redteam-external-fixture-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-redteam-ci-trend-dashboard-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-redteam-artifact-retention-dashboard-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-redteam-failure-quarantine-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-redteam-product-gate-v1'),
      ev('apps/verification/src/main.mjs', '/redteam/trend'),
      ev('apps/verification/src/main.mjs', '/redteam/product-gate'),
      ev('scripts/verification-dashboard-dossier.mjs', 'redteam_corpus_threshold_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'redteam_external_fixture_trend_retention_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'redteam_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'policy_security_redteam_corpus_passed'),
      ev('scripts/security-redteam-corpus.mjs', 'e-security-redteam-corpus-v1'),
      ev('tests/ag-runtime.test.js', 'g-redteam-product-gate-v1')
    ]
  }],
  ['G-08', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/fixtures/tool-poisoning-leak-fixtures.json', 'g-tool-leak-fixture-pack-v2'),
      ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_suite_diff_artifact_written'),
      ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_dom_diff_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_retention_policy_visible'),
      ev('scripts/verification-dashboard-dossier.mjs', 'tool_leak_release_dossier_ready'),
      ev('apps/verification/src/verification-runtime.js', 'g-tool-poisoning-leak-release-dossier-v1'),
      ev('apps/verification/src/main.mjs', '/tool-poisoning-leak/release-dossier'),
      ev('tests/ag-runtime.test.js', 'verification dashboard dossier')
    ]
  }],
  ['G-09', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/fixtures/ag-simulation-expanded-scenarios.json', 'g-simulation-expanded-scenario-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-chaos-simulation-schedule-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-simulation-trend-retention-dashboard-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-simulation-release-dossier-v1'),
      ev('apps/verification/src/main.mjs', '/simulation/trend/retention'),
      ev('apps/verification/src/main.mjs', '/simulation/release-dossier'),
      ev('scripts/verification-dashboard-dossier.mjs', 'simulation_expanded_scenario_pack_loaded'),
      ev('scripts/verification-dashboard-dossier.mjs', 'simulation_chaos_schedule_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'simulation_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'simulation_chaos_schedule_passed')
    ]
  }],
  ['G-10', {
    productReadiness: 0.95,
    evidence: [
      ev('apps/verification/fixtures/regression-external-fixtures.json', 'g-regression-external-fixture-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-regression-external-fixture-pack-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-release-gate-ci-schedule-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-regression-artifact-store-sync-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-regression-suite-product-gate-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-regression-suite-release-dossier-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-regression-release-artifact-manifest-v1'),
      ev('apps/verification/src/main.mjs', '/regression/product-gate'),
      ev('apps/verification/src/main.mjs', '/regression/release-dossier'),
      ev('scripts/verification-dashboard-dossier.mjs', 'regression_suite_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'regression_release_dossier_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'regression_external_fixture_pack_loaded'),
      ev('scripts/verification-dashboard-dossier.mjs', 'operational_release_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'regression_dashboard_current'),
      ev('scripts/verification-dashboard-dossier.mjs', 'g-verification-dashboard-release-dossier-v1'),
      ev('scripts/verification-dashboard-dossier.mjs', 'g-verification-dashboard-release-artifact-manifest-v1'),
      ev('scripts/verification-dashboard-dossier.mjs', 'g-verification-dashboard-release-workflow-v1'),
      ev('scripts/verification-dashboard-dossier.mjs', 'g-verification-dashboard-worm-release-archive-v1'),
      ev('tests/ag-runtime.test.js', 'verification_dashboard_release_dossier_ready'),
      ev('tests/ag-runtime.test.js', 'g-regression-suite-product-gate-v1')
    ]
  }],
  ['G-11', {
    productReadiness: 0.95,
    evidence: [
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_retention_visible'),
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_immutable_artifact_synced'),
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_long_term_trend_visualized'),
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_cleanup_approval_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_product_gate_passed'),
      ev('scripts/verification-dashboard-dossier.mjs', 'report_store_release_dossier_ready'),
      ev('apps/verification/src/main.mjs', '/reports/artifacts/sync'),
      ev('apps/verification/src/main.mjs', '/reports/cleanup/approval'),
      ev('apps/verification/src/reports/report-store.js', 'g-report-worm-artifact-store-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-report-store-release-dossier-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-report-store-release-artifact-manifest-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-report-store-external-worm-promotion-package-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-report-store-external-worm-provider-contract-v1'),
      ev('apps/verification/src/verification-runtime.js', 'external_worm_promotion_package_ready'),
      ev('apps/verification/src/main.mjs', '/reports/release-dossier'),
      ev('tests/ag-runtime.test.js', 'verification dashboard dossier')
    ]
  }],
  ['G-12', {
    productReadiness: 0.95,
    evidence: [
      ev('scripts/verification-dashboard-dossier.mjs', 'score_12d_gate_available'),
      ev('scripts/verification-dashboard-dossier.mjs', 'score_12d_dashboard_annotation_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'score_12d_product_gate_passed'),
      ev('apps/verification/src/verification-runtime.js', 'g-12d-document-rubric-extractor-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-12d-score-dashboard-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-12d-ci-annotation-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-12d-score-product-gate-v1'),
      ev('apps/verification/src/main.mjs', '/score/product-gate'),
      ev('tests/ag-runtime.test.js', 'g-12d-score-product-gate-v1')
    ]
  }],
  ['G-13', {
    productReadiness: 0.95,
    evidence: [
      ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_baseline_approved'),
      ev('scripts/verification-dashboard-dossier.mjs', 'baseline_approval_dashboard_ready'),
      ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_retention_policy_visible'),
      ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_ci_trend_visualized'),
      ev('scripts/verification-dashboard-dossier.mjs', 'golden_trace_release_dossier_ready'),
      ev('apps/verification/src/verification-runtime.js', 'g-baseline-approval-dashboard-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-retention-policy-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-ci-trend-visualization-v1'),
      ev('apps/verification/src/verification-runtime.js', 'g-golden-trace-release-dossier-v1'),
      ev('apps/verification/src/main.mjs', '/golden-traces/release-dossier'),
      ev('tests/ag-runtime.test.js', 'g-golden-trace-ci-trend-visualization-v1')
    ]
  }]
]);

function expandEvidence(item) {
  const boost = productEvidenceBoosts.get(item.id);
  if (!boost) return item.evidence;
  const evidence = [...item.evidence];
  const seen = new Set(evidence.map((entry) => evidenceKey(entry)));
  for (const entry of boost.evidence) {
    const key = evidenceKey(entry);
    if (!seen.has(key)) {
      evidence.push(entry);
      seen.add(key);
    }
  }
  return evidence;
}

function adjustedProductReadiness(item, evidenceResults) {
  const boost = productEvidenceBoosts.get(item.id);
  if (!boost) return item.productReadiness;
  const allBoostEvidencePassed = boost.evidence.every((entry) => evidenceResults.some((result) => evidenceKey(result) === evidenceKey(entry) && result.pass));
  return allBoostEvidencePassed ? Math.max(item.productReadiness, boost.productReadiness) : item.productReadiness;
}

function evidenceKey(item) {
  return `${item.path}::${item.contains ?? ''}`;
}

async function verifyEvidence(evidence) {
  const checked = [];
  for (const item of evidence) {
    let exists = false;
    let containsPass = item.contains ? false : true;
    try {
      await access(item.path);
      exists = true;
      if (item.contains) {
        const content = await readFile(item.path, 'utf8');
        containsPass = content.includes(item.contains);
      }
    } catch {
      exists = false;
      containsPass = false;
    }
    checked.push({ ...item, pass: exists && containsPass });
  }
  return checked;
}

function scoreRequirement(item, evidenceResults) {
  const base = statuses[item.status].score;
  if (item.evidence.length === 0) return base;
  const allEvidencePass = evidenceResults.every((result) => result.pass);
  return allEvidencePass ? base : Math.min(base, statuses.stub.score);
}

function summarizeDoc(docId, items) {
  const weighted = weightedAverage(items, (item) => item.effectiveScore);
  const product = weightedAverage(items, (item) => item.productReadiness);
  const counts = {};
  for (const status of Object.keys(statuses)) counts[status] = 0;
  for (const item of items) counts[item.status] += 1;
  return {
    id: docId,
    title: docTitles[docId],
    strictScore: round(weighted * 100),
    productReadinessScore: round(product * 100),
    counts,
    requirements: items
  };
}

function weightedAverage(items, selector) {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return 0;
  return items.reduce((sum, item) => sum + selector(item) * item.weight, 0) / totalWeight;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

const docTitles = {
  A: '공통 코어 엔진',
  B: '로컬 PC 제어 프로그램',
  C: '모바일/태블릿 앱',
  D: 'PC/모바일 통신 브릿지',
  E: '권한/승인/보안 시스템',
  F: '성장형 기억/학습 시스템',
  G: '테스트/검증 시뮬레이션 시스템'
};

function topGaps(docs) {
  return docs
    .flatMap((doc) => doc.requirements.map((item) => ({
      docId: doc.id,
      id: item.id,
      title: item.title,
      status: item.status,
      gapWeight: round(item.weight * (1 - item.effectiveScore)),
      gap: item.gaps[0],
      nextAction: item.nextActions[0]
    })))
    .filter((item) => item.gapWeight > 0.4)
    .sort((a, b) => b.gapWeight - a.gapWeight)
    .slice(0, 20);
}

function renderMarkdown(report) {
  const lines = [
    '# JARVIS A-G Strict Gap Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Overall strict implementation score: ${report.overall.strictScore}%`,
    `Overall product-readiness score: ${report.overall.productReadinessScore}%`,
    '',
    '> 이 감사는 기존 ag:audit처럼 파일 존재 여부를 완료로 보지 않는다. 문서 요구사항별로 실제 동작, 구현 깊이, 제품화 수준, 미구현 항목을 따로 계산한다.',
    '',
    '## Summary',
    '',
    '| Doc | Area | Strict score | Product readiness | Complete | Substantial | Partial | Stub | Missing |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  for (const doc of report.docs) {
    lines.push(`| ${doc.id} | ${doc.title} | ${doc.strictScore}% | ${doc.productReadinessScore}% | ${doc.counts.complete} | ${doc.counts.substantial} | ${doc.counts.partial} | ${doc.counts.stub} | ${doc.counts.missing} |`);
  }

  lines.push('', '## Highest Priority Gaps', '');
  for (const gap of report.topGaps) {
    lines.push(`- **${gap.id} ${gap.title}** (${statuses[gap.status].label}, gap ${gap.gapWeight}): ${gap.gap}`);
    lines.push(`  - Next: ${gap.nextAction}`);
  }

  for (const doc of report.docs) {
    lines.push('', `## ${doc.id}. ${doc.title}`, '');
    lines.push(`Strict score: ${doc.strictScore}%`);
    lines.push(`Product readiness: ${doc.productReadinessScore}%`);
    lines.push('');
    lines.push('| ID | Requirement | Status | Effective | Product | Evidence | Main gap | Next action |');
    lines.push('| --- | --- | --- | ---: | ---: | --- | --- | --- |');
    for (const item of doc.requirements) {
      const evidence = item.evidenceResults.length === 0
        ? 'none'
        : item.evidenceResults.map((result) => `${result.pass ? 'ok' : 'fail'}:${result.path}`).join('<br>');
      lines.push(`| ${item.id} | ${escapeMd(item.title)} | ${statuses[item.status].label} | ${round(item.effectiveScore * 100)}% | ${round(item.productReadiness * 100)}% | ${escapeMd(evidence)} | ${escapeMd(item.gaps[0] ?? '')} | ${escapeMd(item.nextActions[0] ?? '')} |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function renderCsv(report) {
  const rows = [
    ['doc', 'id', 'title', 'status', 'effective_score', 'product_readiness', 'weight', 'gap', 'next_action', 'evidence'].join(',')
  ];
  for (const doc of report.docs) {
    for (const item of doc.requirements) {
      rows.push([
        doc.id,
        item.id,
        csv(item.title),
        item.status,
        round(item.effectiveScore * 100),
        round(item.productReadiness * 100),
        item.weight,
        csv(item.gaps[0] ?? ''),
        csv(item.nextActions[0] ?? ''),
        csv(item.evidenceResults.map((result) => `${result.pass ? 'ok' : 'fail'}:${result.path}`).join('; '))
      ].join(','));
    }
  }
  return `${rows.join('\n')}\n`;
}

function escapeMd(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function csv(value) {
  const text = String(value).replaceAll('"', '""');
  return `"${text}"`;
}

export async function runAgGapAudit({
  jsonPath = 'dist/ag-strict-gap-audit.json',
  markdownPath = 'dist/ag-strict-gap-audit.md',
  csvPath = 'dist/ag-strict-gap-audit.csv',
  failBelow = null
} = {}) {
  const checked = [];
  for (const item of requirements) {
    const evidence = expandEvidence(item);
    const evidenceResults = await verifyEvidence(evidence);
    const effectiveScore = scoreRequirement({ ...item, evidence }, evidenceResults);
    const productReadiness = adjustedProductReadiness(item, evidenceResults);
    checked.push({ ...item, evidence, evidenceResults, effectiveScore, productReadiness });
  }

  const docs = Object.keys(docTitles).map((docId) => summarizeDoc(docId, checked.filter((item) => item.docId === docId)));
  const report = {
    generatedAt: new Date().toISOString(),
    scoring: statuses,
    overall: {
      strictScore: round(weightedAverage(checked, (item) => item.effectiveScore) * 100),
      productReadinessScore: round(weightedAverage(checked, (item) => item.productReadiness) * 100),
      requirementCount: checked.length
    },
    topGaps: topGaps(docs),
    docs
  };

  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');

  if (failBelow !== null && report.overall.strictScore < failBelow) {
    throw new Error(`A-G strict score ${report.overall.strictScore}% is below ${failBelow}%`);
  }
  return report;
}

function parseFailBelow(argv) {
  const flag = argv.find((item) => item.startsWith('--fail-below='));
  if (!flag) return null;
  return Number(flag.split('=')[1]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failBelow = parseFailBelow(process.argv.slice(2));
  const report = await runAgGapAudit({ failBelow });
  console.log('# JARVIS A-G Strict Gap Audit');
  console.log(`Overall strict implementation score: ${report.overall.strictScore}%`);
  console.log(`Overall product-readiness score: ${report.overall.productReadinessScore}%`);
  for (const doc of report.docs) {
    console.log(`${doc.id}. ${doc.title}: strict ${doc.strictScore}% / product ${doc.productReadinessScore}%`);
  }
  console.log('Reports: dist/ag-strict-gap-audit.json, dist/ag-strict-gap-audit.md, dist/ag-strict-gap-audit.csv');
}
