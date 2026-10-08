import { createHash } from 'node:crypto';

export const COMPLEX_WORKFLOW_CORRECTION_VERSION = 'jarvis-complex-workflow-correction-v1';

const correctionSets = Object.freeze({
  'c45-ranking-v1': Object.freeze({
    description: 'C45의 단독 1위 점수와 모순되는 공동 1위 표현을 상위 두 옵션 표현으로 교정합니다.',
    patches: Object.freeze([Object.freeze({
      caseId: '45',
      field: 'command',
      before: '공동 1위 두 옵션을 cards/option-a.png와 cards/option-b.png로 만들고',
      after: '상위 두 옵션 A와 B를 cards/option-a.png와 cards/option-b.png로 만들고',
      reason: 'B 7.75점은 단독 1위이고 A 7.70점은 2위이므로 두 카드는 공동 1위가 아니라 상위 두 옵션을 나타냅니다.'
    })])
  }),
  'c47-stop-report-v1': Object.freeze({
    description: 'C47의 기대 중단 보고에 누락 파일과 승인 규칙의 세 필드를 정확히 보고하도록 강제합니다.',
    patches: Object.freeze([Object.freeze({
      caseId: '47',
      kind: 'add-stop-report-required-fields',
      field: 'expected.stopReport.requiredFields',
      baseCommandSha256: '167b1bca4bd19a9e1536cdee504537ec39924f1dba0cc47ab56cd52f477d709f',
      baseExpectedSha256: '7ee87a9c1f0df9eb6855a0a1fdb4e683e2ce908bf4ec4e81bafd3445a73860e5',
      sourceInputPath: 'approval-rule.txt',
      sourceInputSha256: 'f852d4e888c49c9c1957dddce1d583f4260f2c6bacf37dad379fd968bb5b0fde',
      requiredFields: Object.freeze(['annex-sla.csv', 'uptime', 'response_minutes', 'penalty']),
      reason: 'approval-rule.txt가 annex-sla.csv와 uptime, response_minutes, penalty를 승인 전 필수 검증값으로 정확히 선언합니다.'
    })])
  })
});

export function applyComplexWorkflowCorrectionSet(items, setId = null) {
  if (!setId) return { cases: [...items], metadata: null };
  const definition = correctionSets[setId];
  if (!definition) throw correctionError('AUDIT_CORRECTION_SET_UNKNOWN', `Unknown correction set: ${setId}`);

  const patchByCaseId = new Map(definition.patches.map((patch) => [patch.caseId, patch]));
  const appliedCaseIds = [];
  const correctedCases = items.map((item) => {
    const patch = patchByCaseId.get(String(item?.id ?? ''));
    if (!patch) return item;
    if (patch.kind === 'add-stop-report-required-fields') {
      const command = String(item?.command ?? '');
      const expected = item?.expected;
      const sourceInput = item?.inputs?.[patch.sourceInputPath];
      const preconditionsHold = (
        sha256(command) === patch.baseCommandSha256
        && sha256(JSON.stringify(expected)) === patch.baseExpectedSha256
        && expected?.status === 'EXPECTED_STOP'
        && expected?.stopReport === undefined
        && sha256(String(sourceInput ?? '')) === patch.sourceInputSha256
      );
      if (!preconditionsHold) {
        throw correctionError(
          'AUDIT_CORRECTION_PRECONDITION_FAILED',
          `Correction ${setId} requires the exact C${patch.caseId} command, expected schema, and ${patch.sourceInputPath} source evidence.`
        );
      }
      const correctedExpected = {
        ...expected,
        stopReport: { requiredFields: [...patch.requiredFields] }
      };
      appliedCaseIds.push(patch.caseId);
      return {
        ...item,
        expected: correctedExpected,
        correction: {
          correctionVersion: COMPLEX_WORKFLOW_CORRECTION_VERSION,
          setId,
          field: patch.field,
          before: null,
          after: [...patch.requiredFields],
          reason: patch.reason,
          sourceInputPath: patch.sourceInputPath,
          sourceInputSha256: patch.sourceInputSha256,
          baseValueSha256: sha256(JSON.stringify(expected)),
          correctedValueSha256: sha256(JSON.stringify(correctedExpected))
        }
      };
    }
    const original = String(item?.[patch.field] ?? '');
    const occurrenceCount = original.split(patch.before).length - 1;
    if (occurrenceCount !== 1) {
      throw correctionError(
        'AUDIT_CORRECTION_PRECONDITION_FAILED',
        `Correction ${setId} expected one exact match in case ${patch.caseId}; found ${occurrenceCount}.`
      );
    }
    const corrected = original.replace(patch.before, patch.after);
    appliedCaseIds.push(patch.caseId);
    return {
      ...item,
      [patch.field]: corrected,
      correction: {
        correctionVersion: COMPLEX_WORKFLOW_CORRECTION_VERSION,
        setId,
        field: patch.field,
        before: patch.before,
        after: patch.after,
        reason: patch.reason,
        baseValueSha256: sha256(original),
        correctedValueSha256: sha256(corrected)
      }
    };
  });

  const unapplied = definition.patches.map((patch) => patch.caseId).filter((id) => !appliedCaseIds.includes(id));
  if (unapplied.length > 0) {
    throw correctionError(
      'AUDIT_CORRECTION_TARGET_MISSING',
      `Correction ${setId} target case(s) are missing: ${unapplied.join(', ')}`
    );
  }

  const definitionSha256 = sha256(JSON.stringify({
    correctionVersion: COMPLEX_WORKFLOW_CORRECTION_VERSION,
    setId,
    description: definition.description,
    patches: definition.patches
  }));
  return {
    cases: correctedCases,
    metadata: {
      correctionVersion: COMPLEX_WORKFLOW_CORRECTION_VERSION,
      setId,
      description: definition.description,
      appliedCaseIds,
      definitionSha256
    }
  };
}

function correctionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
