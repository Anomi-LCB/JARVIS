import { runG01LiveAdapter } from './agent-platform-g01-live-adapter.mjs';
import { runG02ConflictAdapter } from './agent-platform-g02-conflict-adapter.mjs';
import { runG03RoutineAdapter } from './agent-platform-g03-routine-adapter.mjs';
import { runG05SkillEvaluationAdapter } from './agent-platform-g05-skill-evaluation-adapter.mjs';
import { runG06SkillRollbackAdapter } from './agent-platform-g06-skill-rollback-adapter.mjs';
import { runM04PreferenceRevisionAdapter } from './agent-platform-m04-preference-revision-adapter.mjs';
import { runM03MemoryRetractionAdapter } from './agent-platform-m03-memory-retraction-adapter.mjs';
import { runControlScenario } from './agent-platform-g08-g09-control-adapter.mjs';
import { runG10InjectionAdapter } from './agent-platform-g10-injection-adapter.mjs';
import { runG12HandoffAdapter } from './agent-platform-g12-handoff-adapter.mjs';
import { runM01LongGoalAdapter } from './agent-platform-m01-long-goal-adapter.mjs';
import { runM02ProcessRecoveryAdapter } from './agent-platform-m02-process-recovery-adapter.mjs';
import { runS10CapabilityAdapter } from './agent-platform-s10-capability-adapter.mjs';
import { runM10EgressAdapter } from './agent-platform-m10-egress-adapter.mjs';
import { runM05ProactivityAdapter } from './agent-platform-m05-proactivity-adapter.mjs';
import { runM11TransportAdapter } from './agent-platform-m11-transport-adapter.mjs';
import { runM06ContainerSandboxAdapter } from './agent-platform-m06-container-sandbox-adapter.mjs';
import { runM08BrowserHandoffAdapter } from './agent-platform-m08-browser-handoff-adapter.mjs';
import { runM09ArtifactConsistencyAdapter } from './agent-platform-m09-artifact-consistency-adapter.mjs';
import { runM12CapabilityPromotionAdapter } from './agent-platform-m12-capability-promotion-adapter.mjs';
import { runS03SourceRevisionAdapter } from './agent-platform-s03-source-revision-adapter.mjs';
import { runS05NodePartitionAdapter } from './agent-platform-s05-node-partition-adapter.mjs';
import { runS04TravelSandboxAdapter } from './agent-platform-s04-travel-sandbox-adapter.mjs';
import { runS08DualBrowserAdapter } from './agent-platform-s08-dual-browser-adapter.mjs';
import { runS09WeeklyRevisionAdapter } from './agent-platform-s09-weekly-revision-adapter.mjs';
import { runS11HealthAdapter } from './agent-platform-s11-health-adapter.mjs';
import { runS12DeviceAdapter } from './agent-platform-s12-device-adapter.mjs';
import { runM07EnvironmentRecoveryAdapter } from './agent-platform-m07-environment-recovery-adapter.mjs';
import { runG11DesktopFixtureAdapter } from './agent-platform-g11-desktop-fixture-adapter.mjs';

export function createAgentPlatformScenarioRunners() {
  return new Map([
    ['G01', runG01LiveAdapter],
    ['G02', runG02ConflictAdapter],
    ['G03', runG03RoutineAdapter],
    ['G05', runG05SkillEvaluationAdapter],
    ['G06', runG06SkillRollbackAdapter],
    ['G08', () => runControlScenario('G08')],
    ['G09', () => runControlScenario('G09')],
    ['G10', runG10InjectionAdapter],
    ['G11', runG11DesktopFixtureAdapter],
    ['G12', runG12HandoffAdapter],
    ['M01', runM01LongGoalAdapter],
    ['M02', runM02ProcessRecoveryAdapter],
    ['M03', runM03MemoryRetractionAdapter],
    ['M04', runM04PreferenceRevisionAdapter],
    ['M05', runM05ProactivityAdapter],
    ['M06', runM06ContainerSandboxAdapter],
    ['M07', runM07EnvironmentRecoveryAdapter],
    ['M08', runM08BrowserHandoffAdapter],
    ['M09', runM09ArtifactConsistencyAdapter],
    ['M10', runM10EgressAdapter],
    ['M11', runM11TransportAdapter],
    ['M12', runM12CapabilityPromotionAdapter],
    ['S03', runS03SourceRevisionAdapter],
    ['S04', runS04TravelSandboxAdapter],
    ['S08', runS08DualBrowserAdapter],
    ['S05', runS05NodePartitionAdapter],
    ['S10', runS10CapabilityAdapter],
    ['S09', runS09WeeklyRevisionAdapter],
    ['S11', runS11HealthAdapter],
    ['S12', runS12DeviceAdapter]
  ]);
}
