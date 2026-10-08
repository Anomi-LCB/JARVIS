import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createCommercialReadinessAudit,
  writeCommercialReadinessAudit
} from './commercial-readiness-audit.mjs';
import { createLegalReleasePack, writeLegalReleasePack } from './legal-release-pack.mjs';
import { runAgOperatorHandoff } from './ag-operator-handoff.mjs';
import { runFinalReleaseGate } from './final-release-gate.mjs';
import { runFinalReleaseVerificationBundle } from './final-release-verification-bundle.mjs';
import { runFinalSignoffKit } from './final-signoff-kit.mjs';
import { runMobileReleasePreflight } from './mobile-release-preflight.mjs';
import { runOperatorPreflight } from './operator-preflight.mjs';
import { runWearablePhysicalFieldGate } from './wearable-physical-field-gate.mjs';

const stageDefinitions = Object.freeze([
  {
    id: 'windows-production-signing',
    title: 'Windows 프로덕션 서명',
    blockerIds: ['signing:core-windows', 'signing:pc-agent-windows'],
    dependsOn: [],
    command: 'npm run product:windows-sign -- -Execute',
    evidenceCommand: 'npm run product:windows-signing-audit'
  },
  {
    id: 'mobile-production-release',
    title: '모바일 프로덕션 배포',
    blockerIds: ['release:mobile'],
    dependsOn: [],
    command: 'npm run mobile:release-preflight -- --strict',
    evidenceCommand: 'npm run mobile:release-dossier'
  },
  {
    id: 'wearable-physical-field',
    title: 'AI 안경 물리 현장 검증',
    blockerIds: ['release:wearable-field'],
    dependsOn: [],
    command: 'npm run wearable:field-runner',
    evidenceCommand: 'npm run wearable:physical-gate'
  },
  {
    id: 'final-release-gate',
    title: '최종 출시 게이트',
    blockerIds: ['release:final-gate'],
    dependsOn: ['wearable-physical-field'],
    command: 'npm run ops:preflight',
    evidenceCommand: 'npm run ops:final-gate'
  },
  {
    id: 'legal-distribution-pack',
    title: '배포 법률 문서 확정',
    blockerIds: ['distribution:license', 'distribution:privacy', 'distribution:eula'],
    dependsOn: [],
    command: 'npm run product:legal-drafts',
    evidenceCommand: 'npm run product:legal-finalize'
  }
]);

async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function checkById(commercialReadiness) {
  return new Map((commercialReadiness?.checks ?? []).map((item) => [item.id, item]));
}

function pointsFor(definition, checks) {
  return definition.blockerIds.reduce((total, id) => total + Number(checks.get(id)?.weight ?? 0), 0);
}

function blockerIdsFor(definition, checks) {
  return definition.blockerIds.filter((id) => checks.get(id)?.passed !== true);
}

function classifyStage(definition, context, unresolvedIds, stageById) {
  if (unresolvedIds.length === 0) return 'completed';
  if (definition.dependsOn.some((id) => stageById.get(id)?.status !== 'completed')) return 'dependency-blocked';

  if (definition.id === 'windows-production-signing') {
    return context.windowsSigningRelease?.status === 'ready-to-sign'
      ? 'ready-to-execute'
      : 'external-certificate-required';
  }
  if (definition.id === 'mobile-production-release') {
    if (context.mobileRelease?.localStatus !== 'passed') return 'local-remediation-required';
    if (context.mobileRelease?.credentialStatus !== 'passed') return 'external-credential-required';
    if (context.mobileRelease?.deviceEvidenceStatus !== 'passed') return 'device-validation-required';
    return 'evidence-refresh-required';
  }
  if (definition.id === 'wearable-physical-field') {
    if (context.wearableField?.evidence?.state !== 'available') return 'field-evidence-required';
    if (context.wearableField?.integrity?.passed !== true) return 'field-evidence-repair-required';
    return 'physical-field-action-required';
  }
  if (definition.id === 'final-release-gate') return 'release-evidence-refresh-required';
  if (definition.id === 'legal-distribution-pack') {
    return context.legalPack?.status === 'legal-approval-required'
      ? 'owner-legal-approval-required'
      : 'owner-input-required';
  }
  return 'action-required';
}

function stageDetail(definition, context) {
  if (definition.id === 'windows-production-signing') {
    return {
      signingAuditStatus: context.windowsSigning?.status ?? 'missing',
      verifiedArtifacts: context.windowsSigning?.summary?.verifiedArtifactCount ?? 0,
      expectedArtifacts: context.windowsSigning?.summary?.expectedArtifactCount ?? 0,
      certificateValuesStored: false
    };
  }
  if (definition.id === 'mobile-production-release') {
    return {
      preflightStatus: context.mobileRelease?.status ?? 'missing',
      localStatus: context.mobileRelease?.localStatus ?? 'missing',
      credentialStatus: context.mobileRelease?.credentialStatus ?? 'missing',
      deviceEvidenceStatus: context.mobileRelease?.deviceEvidenceStatus ?? 'missing',
      credentialValuesStored: false
    };
  }
  if (definition.id === 'wearable-physical-field') {
    return {
      gateStatus: context.wearableField?.status ?? 'missing',
      evidenceState: context.wearableField?.evidence?.state ?? 'missing',
      integrityState: context.wearableField?.integrity?.state ?? 'missing',
      rawAudioStored: context.wearableField?.privacy?.rawAudioStored ?? false,
      rawTranscriptStored: context.wearableField?.privacy?.rawTranscriptStored ?? false
    };
  }
  if (definition.id === 'final-release-gate') {
    return {
      gateStatus: context.finalRelease?.status ?? 'missing',
      blockingChecks: context.finalRelease?.summary?.blockingCheckCount ?? null,
      pendingExternalValidation: context.finalRelease?.summary?.externalValidationPending ?? null
    };
  }
  return {
    legalPackStatus: context.legalPack?.status ?? 'missing',
    missingFieldCount: context.legalPack?.missingFields?.length ?? null,
    explicitApprovalConfirmed: context.legalPack?.approval?.confirmed === true,
    legalReviewAutomated: false
  };
}

function buildExternalInputs(stages) {
  const inputDefinitions = [
    {
      stageId: 'windows-production-signing',
      id: 'trusted-code-signing-certificate',
      title: '신뢰 가능한 코드 서명 인증서',
      sensitive: true,
      valuesStored: false
    },
    {
      stageId: 'mobile-production-release',
      id: 'android-and-eas-credentials',
      title: 'Android 키스토어와 EAS 계정 자격 증명',
      sensitive: true,
      valuesStored: false
    },
    {
      stageId: 'wearable-physical-field',
      id: 'wearable-physical-observations',
      title: '실제 안경 착용·음성·가독성·복구·발열 측정',
      sensitive: false,
      valuesStored: false
    },
    {
      stageId: 'legal-distribution-pack',
      id: 'owner-and-legal-approval',
      title: '공개 사업자 정보와 검토자의 명시적 승인',
      sensitive: false,
      valuesStored: false
    }
  ];
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  return inputDefinitions.map((item) => ({
    ...item,
    required: byId.get(item.stageId)?.status !== 'completed'
  }));
}

export function evaluateCommercialClosure({
  commercialReadiness,
  windowsSigning = null,
  windowsSigningRelease = null,
  mobileRelease = null,
  wearableField = null,
  finalRelease = null,
  legalPack = null,
  clock = () => new Date()
} = {}) {
  if (!commercialReadiness || !Array.isArray(commercialReadiness.checks)) {
    throw new Error('commercial-readiness-report-required');
  }

  const context = { windowsSigning, windowsSigningRelease, mobileRelease, wearableField, finalRelease, legalPack };
  const checks = checkById(commercialReadiness);
  const stageById = new Map();
  const stages = stageDefinitions.map((definition) => {
    const unresolvedBlockerIds = blockerIdsFor(definition, checks);
    const stage = {
      id: definition.id,
      title: definition.title,
      points: pointsFor(definition, checks),
      status: 'pending',
      blockerIds: unresolvedBlockerIds,
      dependsOn: [...definition.dependsOn],
      command: definition.command,
      evidenceCommand: definition.evidenceCommand,
      detail: stageDetail(definition, context)
    };
    stage.status = classifyStage(definition, context, unresolvedBlockerIds, stageById);
    stageById.set(stage.id, stage);
    return stage;
  });

  let projectedScore = Number(commercialReadiness.score ?? 0);
  const scorePath = stages.map((stage) => {
    projectedScore += stage.status === 'completed' ? 0 : stage.points;
    return {
      stageId: stage.id,
      from: projectedScore - (stage.status === 'completed' ? 0 : stage.points),
      to: projectedScore,
      points: stage.status === 'completed' ? 0 : stage.points
    };
  });
  const remainingPoints = 100 - Number(commercialReadiness.score ?? 0);
  const unresolvedPoints = stages.reduce((total, stage) => total + (stage.status === 'completed' ? 0 : stage.points), 0);
  const blockerPoints = (commercialReadiness.checks ?? [])
    .filter((item) => !item.passed)
    .reduce((total, item) => total + Number(item.weight ?? 0), 0);
  const nextActions = stages
    .filter((stage) => stage.status !== 'completed' && stage.status !== 'dependency-blocked')
    .map((stage) => ({
      stageId: stage.id,
      status: stage.status,
      command: stage.command,
      evidenceCommand: stage.evidenceCommand
    }));

  return {
    reportVersion: 'jarvis-commercial-100-closure-v1',
    generatedAt: clock().toISOString(),
    status: commercialReadiness.commercialReady === true ? 'commercial-100-complete' : 'closure-in-progress',
    summary: {
      currentScore: Number(commercialReadiness.score ?? 0),
      targetScore: 100,
      remainingPoints,
      completedStageCount: stages.filter((stage) => stage.status === 'completed').length,
      totalStageCount: stages.length,
      externalInputCount: buildExternalInputs(stages).filter((item) => item.required).length,
      scoreAccountingValid: remainingPoints === unresolvedPoints && remainingPoints === blockerPoints
    },
    stages,
    scorePath,
    nextActions,
    externalInputs: buildExternalInputs(stages),
    truthPolicy: {
      missingEvidenceFailsClosed: true,
      externalEvidenceCannotBeSynthesized: true,
      legalApprovalCannotBeAutomated: true,
      physicalFieldResultsCannotBeSelfCertifiedBySoftware: true,
      credentialValuesStored: false,
      scoreRequiresEveryCommercialCheck: true
    }
  };
}

export function commercialClosureMarkdown(report) {
  const stageRows = report.stages.map((stage) =>
    `| ${stage.title} | ${stage.status} | ${stage.points} | ${stage.blockerIds.join(', ') || '-'} |`
  ).join('\n');
  const actions = report.nextActions.length > 0
    ? report.nextActions.map((item) => `- ${item.stageId}: \`${item.command}\` -> \`${item.evidenceCommand}\``).join('\n')
    : '- 없음';
  return `# JARVIS 상용 100점 폐쇄 계획\n\n- 현재 점수: **${report.summary.currentScore}/100**\n- 남은 점수: **${report.summary.remainingPoints}**\n- 상태: **${report.status}**\n- 배점 정합성: **${report.summary.scoreAccountingValid ? '정상' : '오류'}**\n\n## 단계\n\n| 단계 | 상태 | 배점 | 차단 항목 |\n| --- | --- | ---: | --- |\n${stageRows}\n\n## 다음 작업\n\n${actions}\n\n외부 인증서, 계정 비밀, 법률 승인 및 물리 현장 결과는 증거 없이 통과 처리하지 않습니다.\n`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function commercialClosureHtml(report) {
  const stageCards = report.stages.map((stage, index) => `
    <article class="stage">
      <div class="stage-index">${String(index + 1).padStart(2, '0')}</div>
      <div class="stage-copy">
        <div class="stage-head"><h2>${escapeHtml(stage.title)}</h2><span class="status ${escapeHtml(stage.status)}">${escapeHtml(stage.status)}</span></div>
        <p>${stage.points}점 · ${escapeHtml(stage.blockerIds.join(', ') || '완료')}</p>
        <code>${escapeHtml(stage.command)}</code>
      </div>
    </article>`).join('');
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JARVIS 상용 100점 폐쇄 계획</title>
<style>
:root{color-scheme:light;--ink:#122034;--muted:#66758a;--line:rgba(31,55,74,.12);--emerald:#0c947a;--mint:#e8f6f2;--amber:#b46b13;--paper:rgba(255,255,255,.82)}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(145deg,#f5f8fb,#edf5f2);color:var(--ink);font-family:"Segoe UI","Malgun Gothic",sans-serif;letter-spacing:0}.shell{width:min(1080px,calc(100% - 32px));margin:40px auto 64px}.top{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;margin-bottom:24px}.eyebrow{color:var(--emerald);font-size:13px;font-weight:700}.top h1{font-size:34px;margin:8px 0 6px}.top p{margin:0;color:var(--muted)}.score{width:152px;height:152px;border:14px solid var(--mint);border-top-color:var(--emerald);border-radius:50%;display:grid;place-items:center;background:var(--paper);box-shadow:0 18px 50px rgba(42,74,90,.1)}.score strong{font-size:36px}.score span{font-size:13px;color:var(--muted)}.summary,.stage{background:var(--paper);border:1px solid var(--line);backdrop-filter:blur(18px);box-shadow:0 12px 36px rgba(44,67,83,.07)}.summary{display:grid;grid-template-columns:repeat(3,1fr);border-radius:8px;margin-bottom:16px}.metric{padding:20px 24px;border-right:1px solid var(--line)}.metric:last-child{border:0}.metric span{display:block;color:var(--muted);font-size:13px}.metric strong{display:block;margin-top:6px;font-size:22px}.stages{display:grid;gap:10px}.stage{display:grid;grid-template-columns:64px 1fr;padding:18px 20px;border-radius:8px}.stage-index{font:700 14px ui-monospace,Consolas,monospace;color:var(--emerald);padding-top:4px}.stage-head{display:flex;gap:16px;align-items:center;justify-content:space-between}.stage h2{font-size:18px;margin:0}.stage p{color:var(--muted);margin:8px 0 12px}.stage code{display:block;padding:10px 12px;background:#f3f7f8;border:1px solid var(--line);border-radius:6px;overflow:auto}.status{font-size:12px;padding:5px 8px;border:1px solid var(--line);border-radius:999px;color:var(--amber);white-space:nowrap}.status.completed{color:var(--emerald);background:var(--mint)}.foot{margin-top:18px;color:var(--muted);font-size:13px}@media(max-width:700px){.shell{margin-top:24px}.top{grid-template-columns:1fr}.score{width:118px;height:118px}.summary{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.stage{grid-template-columns:42px 1fr}.stage-head{align-items:flex-start;flex-direction:column;gap:8px}.top h1{font-size:28px}}
</style></head><body><main class="shell"><section class="top"><div><div class="eyebrow">JARVIS RELEASE CONTROL</div><h1>상용 100점 폐쇄 계획</h1><p>증거가 있는 항목만 점수로 인정합니다.</p></div><div class="score"><div><strong>${report.summary.currentScore}</strong><span> / 100</span></div></div></section><section class="summary"><div class="metric"><span>남은 점수</span><strong>${report.summary.remainingPoints}</strong></div><div class="metric"><span>완료 단계</span><strong>${report.summary.completedStageCount} / ${report.summary.totalStageCount}</strong></div><div class="metric"><span>외부 입력</span><strong>${report.summary.externalInputCount}</strong></div></section><section class="stages">${stageCards}</section><p class="foot">인증서·토큰·비밀번호 원문, 음성 원본 및 법률 승인 원문은 이 보고서에 저장하지 않습니다.</p></main></body></html>`;
}

export async function writeCommercialClosure(report, {
  outputDir = resolve('dist', 'commercial-closure')
} = {}) {
  const jsonPath = join(outputDir, 'commercial-closure.json');
  const markdownPath = join(outputDir, 'commercial-closure.md');
  const htmlPath = join(outputDir, 'index.html');
  await mkdir(outputDir, { recursive: true });
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(markdownPath, commercialClosureMarkdown(report), 'utf8'),
    writeFile(htmlPath, commercialClosureHtml(report), 'utf8')
  ]);
  return { jsonPath, markdownPath, htmlPath };
}

export async function runCommercialClosure({
  workspaceRoot = process.cwd(),
  env = process.env,
  refresh = true,
  clock = () => new Date()
} = {}) {
  const root = resolve(workspaceRoot);
  let legalPack = null;
  if (refresh) {
    await runMobileReleasePreflight({
      appDir: join(root, 'apps', 'mobile'),
      env,
      outputDir: join(root, 'dist'),
      jsonPath: join(root, 'dist', 'mobile-release-preflight-report.json'),
      markdownPath: join(root, 'dist', 'mobile-release-preflight-report.md'),
      htmlPath: join(root, 'dist', 'mobile-release-preflight-report.html')
    });
    await runWearablePhysicalFieldGate({ workspaceRoot: root });
    legalPack = await writeLegalReleasePack(createLegalReleasePack({ env, clock }), { workspaceRoot: root });
    await runAgOperatorHandoff({
      jsonPath: join(root, 'dist', 'ag-operator-handoff.json'),
      markdownPath: join(root, 'dist', 'ag-operator-handoff.md'),
      csvPath: join(root, 'dist', 'ag-operator-handoff.csv')
    });
    await runOperatorPreflight({ workspaceRoot: root, env });
    await runFinalReleaseGate({ workspaceRoot: root });
    await runFinalSignoffKit({ workspaceRoot: root });
    await runFinalReleaseVerificationBundle({
      workspaceRoot: root,
      emitAnnotations: false
    });
  }

  const commercialReadiness = await createCommercialReadinessAudit({ workspaceRoot: root, env, clock });
  await writeCommercialReadinessAudit(commercialReadiness, {
    jsonPath: join(root, 'dist', 'commercial-readiness-audit.json'),
    markdownPath: join(root, 'dist', 'commercial-readiness-audit.md')
  });
  const [windowsSigning, windowsSigningRelease, mobileRelease, wearableField, finalRelease, storedLegalPack] = await Promise.all([
    readJsonIfPresent(join(root, 'dist', 'windows-code-signing-audit.json')),
    readJsonIfPresent(join(root, 'dist', 'windows-code-signing-release.json')),
    readJsonIfPresent(join(root, 'dist', 'mobile-release-preflight-report.json')),
    readJsonIfPresent(join(root, 'dist', 'wearable-physical-field-gate.json')),
    readJsonIfPresent(join(root, 'dist', 'final-release-gate.json')),
    readJsonIfPresent(join(root, 'dist', 'legal-release-pack', 'legal-release-pack.json'))
  ]);
  const report = evaluateCommercialClosure({
    commercialReadiness,
    windowsSigning,
    windowsSigningRelease,
    mobileRelease,
    wearableField,
    finalRelease,
    legalPack: legalPack ?? storedLegalPack,
    clock
  });
  report.artifacts = await writeCommercialClosure(report, { outputDir: join(root, 'dist', 'commercial-closure') });
  return report;
}

function parseArgs(argv) {
  return {
    refresh: !argv.includes('--no-refresh'),
    strict: argv.includes('--strict')
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  runCommercialClosure(options).then((report) => {
    console.log(JSON.stringify({
      status: report.status,
      currentScore: report.summary.currentScore,
      remainingPoints: report.summary.remainingPoints,
      scoreAccountingValid: report.summary.scoreAccountingValid,
      nextActionCount: report.nextActions.length,
      artifacts: report.artifacts
    }, null, 2));
    if (options.strict && report.status !== 'commercial-100-complete') process.exitCode = 1;
  }).catch((error) => {
    console.error(`JARVIS commercial closure failed: ${error.message}`);
    process.exit(1);
  });
}
