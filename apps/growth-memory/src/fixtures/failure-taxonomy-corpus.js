import { ActionType } from '../../../../packages/shared/src/types.js';

export const failureTaxonomyCorpusId = 'f-failure-taxonomy-fixture-corpus-v1';

export const failureTaxonomyFixtureCorpus = [
  {
    fixtureId: 'failure_taxonomy_policy_block',
    eventType: 'policy.blocked',
    taskId: 'fixture_failure_policy_block',
    payload: {
      rawText: '밴드에 외부 전송해',
      reason: '외부 전송은 PC 승인 필요',
      reasonCode: 'E_EXTERNAL_TRANSFER_PC_ONLY',
      actionType: ActionType.UPLOAD_FILE,
      toolName: 'band.post'
    },
    expected: {
      category: 'policy_safety_block',
      severity: 'critical',
      checklistIncludes: ['require_pc_or_policy_review', 'block_external_transfer_autonomy']
    }
  },
  {
    fixtureId: 'failure_taxonomy_capability_scope',
    eventType: 'execution.failed',
    taskId: 'fixture_failure_capability_scope',
    payload: {
      rawText: '파일 만들어',
      reason: 'capability token scope mismatch',
      reasonCode: 'CAPABILITY_SCOPE',
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile'
    },
    expected: {
      category: 'capability_scope_failure',
      severity: 'high',
      checklistIncludes: ['validate_capability_scope', 'require_single_use_token']
    }
  },
  {
    fixtureId: 'failure_taxonomy_rollback',
    eventType: 'execution.failed',
    taskId: 'fixture_failure_rollback',
    payload: {
      rawText: '파일 변경 후 복구해',
      reason: 'rollback undo journal check failed',
      reasonCode: 'ROLLBACK_CHECK',
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile'
    },
    expected: {
      category: 'rollback_or_recovery_failure',
      severity: 'high',
      checklistIncludes: ['require_rollback_plan', 'verify_recovery_evidence']
    }
  },
  {
    fixtureId: 'failure_taxonomy_verification',
    eventType: 'verification.failed',
    taskId: 'fixture_failure_verification',
    payload: {
      rawText: '엑셀 보고서 만들어',
      reason: '검증 evidence 누락',
      reasonCode: 'G_EVIDENCE_MISSING',
      actionType: ActionType.CREATE_FILE,
      toolName: 'excel.createWorkbook'
    },
    expected: {
      category: 'verification_evidence_failure',
      severity: 'high',
      checklistIncludes: ['require_execution_evidence', 'run_g_verifier_before_learning']
    }
  },
  {
    fixtureId: 'failure_taxonomy_filesystem',
    eventType: 'execution.failed',
    taskId: 'fixture_failure_filesystem',
    payload: {
      rawText: '없는 경로에 파일 만들어',
      reason: 'path outside allowed root',
      reasonCode: 'FILESYSTEM_PREFLIGHT',
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile'
    },
    expected: {
      category: 'filesystem_preflight_failure',
      severity: 'medium',
      checklistIncludes: ['run_shadow_preflight', 'verify_allowed_root']
    }
  },
  {
    fixtureId: 'failure_taxonomy_user_rejected',
    eventType: 'approval.rejected',
    taskId: 'fixture_failure_user_rejected',
    payload: {
      rawText: '이 작업 실행해',
      reason: '사용자가 의도를 거절함',
      reasonCode: 'USER_REJECTED'
    },
    expected: {
      category: 'user_rejected_intent',
      severity: 'medium',
      checklistIncludes: ['ask_before_repeating_suggestion', 'record_rejection_reason']
    }
  },
  {
    fixtureId: 'failure_taxonomy_runtime',
    eventType: 'execution.failed',
    taskId: 'fixture_failure_runtime',
    payload: {
      rawText: '보고서 생성해',
      reason: 'adapter crashed with runtime error',
      reasonCode: 'RUNTIME_FAILED',
      actionType: ActionType.CREATE_FILE,
      toolName: 'filesystem.createTextFile'
    },
    expected: {
      category: 'execution_runtime_failure',
      severity: 'medium',
      checklistIncludes: ['validate_tool_contract', 'capture_runtime_error']
    }
  }
];
