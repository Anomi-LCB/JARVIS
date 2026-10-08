import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyMobileReleaseCredentials } from './mobile-release-credentials.mjs';
import { verifyMobileEasBuildEvidence } from './mobile-eas-build-gate.mjs';

const defaultAppDir = 'apps/mobile';
const defaultOutputDir = 'dist';
const packageNamePattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonIfExists(path) {
  if (!await exists(path)) return null;
  try {
    return await readJson(path);
  } catch (error) {
    return { parseError: error.message };
  }
}

async function fileInfo(path) {
  if (!path || !await exists(path)) return { exists: false, path: path ?? null, bytes: 0, modifiedAt: null };
  const item = await stat(path);
  return { exists: true, path, bytes: item.size, modifiedAt: item.mtime.toISOString() };
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function addCheck(checks, {
  id,
  title,
  passed,
  severity = 'local',
  evidence = null,
  remediation = null
}) {
  checks.push({
    id,
    title,
    passed: Boolean(passed),
    severity,
    evidence,
    remediation
  });
}

function pluginSet(appJson) {
  return new Set((appJson?.expo?.plugins ?? []).map((item) => Array.isArray(item) ? item[0] : item));
}

function artifactStatus(report, passingStatuses) {
  if (!report) return { present: false, passed: false, status: 'missing' };
  if (report.parseError) return { present: true, passed: false, status: 'parse-error', error: report.parseError };
  return {
    present: true,
    passed: passingStatuses.includes(report.status),
    status: report.status
  };
}

function buildGradleSigningPolicy(source) {
  return {
    hasReleaseSigningConfig: /signingConfigs\s*\{[\s\S]*release\s*\{/m.test(source),
    usesJarvisKeystoreEnv: source.includes('JARVIS_ANDROID_KEYSTORE_PATH')
      && source.includes('JARVIS_ANDROID_KEYSTORE_PASSWORD')
      && source.includes('JARVIS_ANDROID_KEY_ALIAS')
      && source.includes('JARVIS_ANDROID_KEY_PASSWORD'),
    releaseFailsClosed: source.includes('jarvisReleaseTaskRequested && !jarvisReleaseSigningReady')
      && source.includes('signingConfig signingConfigs.release')
      && !source.includes('jarvisReleaseSigningReady ? signingConfigs.release : signingConfigs.debug')
  };
}

function easProductionProfile(easJson) {
  return easJson?.build?.production ?? null;
}

export function createMobileReleasePreflightPlan({ appDir = defaultAppDir } = {}) {
  return {
    planVersion: 'c-mobile-release-preflight-plan-v1',
    appDir,
    commands: [
      {
        id: 'local-release-preflight',
        command: 'npm run mobile:release-preflight',
        expected: 'Expo config, EAS profiles, Android release signing policy, and existing device evidence are checked.'
      },
      {
        id: 'android-production-keystore',
        command: 'set JARVIS_ANDROID_KEYSTORE_PATH, JARVIS_ANDROID_KEYSTORE_PASSWORD, JARVIS_ANDROID_KEY_ALIAS, JARVIS_ANDROID_KEY_PASSWORD',
        expected: 'Release Gradle fails closed until the production keystore is available.'
      },
      {
        id: 'eas-store-build',
        command: `cd ${appDir} && npx eas build --platform all --profile production`,
        expected: 'EAS creates Android app bundle and iOS store build using the production profile.'
      },
      {
        id: 'android-release-install-smoke',
        command: 'npm run mobile:android-install -- --build --install --variant release',
        expected: 'A signed release APK/AAB-derived build installs and launches on a ready Android device or emulator.'
      },
      {
        id: 'physical-device-smoke',
        command: 'npm run mobile:device',
        expected: 'ADB captures screenshot, UI XML, native runtime probe labels, and route navigation evidence.'
      },
      {
        id: 'store-submit-dry-run',
        command: `cd ${appDir} && npx eas submit --platform all --profile production --latest`,
        expected: 'Store submission credentials and app identifiers are validated before publication.'
      }
    ]
  };
}

export async function runMobileReleasePreflight({
  appDir = defaultAppDir,
  env = process.env,
  credentialVerifier = verifyMobileReleaseCredentials,
  easBuildEvidenceVerifier = verifyMobileEasBuildEvidence,
  outputDir = defaultOutputDir,
  jsonPath = join(outputDir, 'mobile-release-preflight-report.json'),
  markdownPath = join(outputDir, 'mobile-release-preflight-report.md'),
  htmlPath = join(outputDir, 'mobile-release-preflight-report.html')
} = {}) {
  const checks = [];
  const appJsonPath = join(appDir, 'app.json');
  const packageJsonPath = join(appDir, 'package.json');
  const easJsonPath = join(appDir, 'eas.json');
  const buildGradlePath = join(appDir, 'android', 'app', 'build.gradle');
  const gradlePropertiesPath = join(appDir, 'android', 'gradle.properties');
  const appJson = await readJson(appJsonPath);
  const packageJson = await readJson(packageJsonPath);
  const easJson = await readJsonIfExists(easJsonPath);
  const buildGradle = await readFile(buildGradlePath, 'utf8');
  const gradleProperties = await readFile(gradlePropertiesPath, 'utf8');
  const plugins = pluginSet(appJson);
  const expo = appJson.expo ?? {};
  const android = expo.android ?? {};
  const ios = expo.ios ?? {};
  const dependencies = packageJson.dependencies ?? {};
  const signingPolicy = buildGradleSigningPolicy(buildGradle);
  const productionProfile = easProductionProfile(easJson);
  const easProjectId = env.JARVIS_EAS_PROJECT_ID || expo.extra?.eas?.projectId;
  const keystore = await fileInfo(env.JARVIS_ANDROID_KEYSTORE_PATH);
  const credentialVerification = await credentialVerifier({ env, appDir, projectId: easProjectId });
  const easBuildEvidence = await easBuildEvidenceVerifier({
    appDir,
    env,
    evidencePath: join(outputDir, 'mobile-eas-production-build.json')
  });
  const installReport = await readJsonIfExists(join(outputDir, 'mobile-android-install-report.json'));
  const deviceReport = await readJsonIfExists(join(outputDir, 'mobile-device-smoke-report.json'));
  const liveBridgeReport = await readJsonIfExists(join(outputDir, 'mobile-live-bridge-e2e-report.json'));

  addCheck(checks, {
    id: 'config:expo-identity',
    title: 'Expo app identity has name, slug, version, and scheme.',
    passed: Boolean(expo.name && expo.slug && expo.version && expo.scheme),
    evidence: { name: expo.name, slug: expo.slug, version: expo.version, scheme: expo.scheme },
    remediation: 'Set expo.name, expo.slug, expo.version, and expo.scheme in app.json.'
  });
  addCheck(checks, {
    id: 'config:android-package-version',
    title: 'Android package and versionCode are store-ready.',
    passed: packageNamePattern.test(android.package ?? '') && Number.isInteger(android.versionCode) && android.versionCode > 0,
    evidence: { package: android.package, versionCode: android.versionCode },
    remediation: 'Set expo.android.package and a positive expo.android.versionCode.'
  });
  addCheck(checks, {
    id: 'config:ios-bundle-build',
    title: 'iOS bundle identifier and buildNumber are store-ready.',
    passed: packageNamePattern.test(ios.bundleIdentifier ?? '') && Boolean(ios.buildNumber),
    evidence: { bundleIdentifier: ios.bundleIdentifier, buildNumber: ios.buildNumber, supportsTablet: ios.supportsTablet },
    remediation: 'Set expo.ios.bundleIdentifier and expo.ios.buildNumber.'
  });
  addCheck(checks, {
    id: 'config:native-modules',
    title: 'SecureStore, LocalAuthentication, and Notifications native modules are declared.',
    passed: ['expo-secure-store', 'expo-local-authentication', 'expo-notifications'].every((name) => plugins.has(name) && dependencies[name]),
    evidence: { plugins: [...plugins], dependencies },
    remediation: 'Add required Expo native plugins and dependencies.'
  });
  addCheck(checks, {
    id: 'config:privacy-permissions',
    title: 'Notification and biometric permission copy is present for Android and iOS.',
    passed: android.permissions?.includes('POST_NOTIFICATIONS') === true
      && android.permissions?.includes('USE_BIOMETRIC') === true
      && Boolean(ios.infoPlist?.NSUserNotificationsUsageDescription)
      && Boolean(ios.infoPlist?.NSFaceIDUsageDescription),
    evidence: { androidPermissions: android.permissions, iosInfoPlist: ios.infoPlist },
    remediation: 'Add Android POST_NOTIFICATIONS/USE_BIOMETRIC and iOS usage descriptions.'
  });
  addCheck(checks, {
    id: 'eas:production-profile',
    title: 'EAS production profile builds store artifacts.',
    passed: Boolean(productionProfile)
      && productionProfile.distribution === 'store'
      && productionProfile.android?.buildType === 'app-bundle'
      && productionProfile.ios?.simulator === false,
    evidence: { easJsonPath, productionProfile },
    remediation: 'Create apps/mobile/eas.json with a production store profile.'
  });
  addCheck(checks, {
    id: 'gradle:release-signing-policy',
    title: 'Android release signing requires a production keystore and fails closed without it.',
    passed: signingPolicy.hasReleaseSigningConfig
      && signingPolicy.usesJarvisKeystoreEnv
      && signingPolicy.releaseFailsClosed,
    evidence: signingPolicy,
    remediation: 'Configure release signing with JARVIS_ANDROID_KEYSTORE_* environment variables.'
  });
  addCheck(checks, {
    id: 'gradle:release-runtime',
    title: 'Release build embeds JS with Hermes and production bundle settings.',
    passed: gradleProperties.includes('hermesEnabled=true') && buildGradle.includes('bundleCommand = "export:embed"'),
    evidence: {
      hermesEnabled: gradleProperties.includes('hermesEnabled=true'),
      bundleCommand: buildGradle.includes('bundleCommand = "export:embed"')
    },
    remediation: 'Keep Hermes enabled and React Native bundleCommand set to export:embed.'
  });
  addCheck(checks, {
    id: 'credential:android-keystore-file',
    title: 'Production Android keystore file is available.',
    passed: keystore.exists,
    severity: 'credential',
    evidence: keystore,
    remediation: 'Set JARVIS_ANDROID_KEYSTORE_PATH to a production keystore file.'
  });
  addCheck(checks, {
    id: 'credential:android-keystore-secret',
    title: 'Production Android keystore passwords and alias are available.',
    passed: Boolean(env.JARVIS_ANDROID_KEYSTORE_PASSWORD && env.JARVIS_ANDROID_KEY_ALIAS && env.JARVIS_ANDROID_KEY_PASSWORD),
    severity: 'credential',
    evidence: {
      hasStorePassword: Boolean(env.JARVIS_ANDROID_KEYSTORE_PASSWORD),
      hasKeyAlias: Boolean(env.JARVIS_ANDROID_KEY_ALIAS),
      hasKeyPassword: Boolean(env.JARVIS_ANDROID_KEY_PASSWORD)
    },
    remediation: 'Set JARVIS_ANDROID_KEYSTORE_PASSWORD, JARVIS_ANDROID_KEY_ALIAS, and JARVIS_ANDROID_KEY_PASSWORD.'
  });
  addCheck(checks, {
    id: 'credential:android-keystore-verified',
    title: 'Production Android keystore opens and contains the configured private key.',
    passed: credentialVerification.androidKeystore?.status === 'passed',
    severity: 'credential',
    evidence: credentialVerification.androidKeystore,
    remediation: 'Verify the keystore password, key alias, private-key password, certificate validity, and key strength.'
  });
  addCheck(checks, {
    id: 'credential:eas-account',
    title: 'EAS token is accepted and resolves the configured project.',
    passed: credentialVerification.easAccount?.status === 'passed',
    severity: 'credential',
    evidence: {
      hasExpoToken: Boolean(env.EXPO_TOKEN),
      hasProjectId: Boolean(easProjectId),
      verificationStatus: credentialVerification.easAccount?.status ?? 'not-run',
      cliAvailable: credentialVerification.easAccount?.cliAvailable ?? null,
      tokenAccepted: credentialVerification.easAccount?.tokenAccepted === true,
      projectIdMatches: credentialVerification.easAccount?.projectIdMatches === true,
      secretValuesStored: false
    },
    remediation: 'Set a valid EXPO_TOKEN and UUID JARVIS_EAS_PROJECT_ID, install EAS CLI, and verify the linked project.'
  });
  const productionBuildFresh = installReport?.variant === 'release'
    && installReport?.gradle?.build?.attempted === true
    && installReport?.gradle?.build?.exitCode === 0
    && installReport?.gradle?.build?.timedOut === false
    && installReport?.apk?.exists === true
    && Number.isFinite(Date.parse(installReport?.generatedAt))
    && Number.isFinite(Date.parse(installReport?.apk?.modifiedAt))
    && Date.parse(installReport.generatedAt) - Date.parse(installReport.apk.modifiedAt) >= 0
    && Date.parse(installReport.generatedAt) - Date.parse(installReport.apk.modifiedAt) <= 10 * 60 * 1000;
  addCheck(checks, {
    id: 'artifact:android-production-build',
    title: 'Android release artifact was built successfully in the current evidence run.',
    passed: productionBuildFresh,
    severity: 'device-artifact',
    evidence: {
      reportPresent: Boolean(installReport),
      variant: installReport?.variant ?? null,
      buildAttempted: installReport?.gradle?.build?.attempted === true,
      buildExitCode: installReport?.gradle?.build?.exitCode ?? null,
      apkPresent: installReport?.apk?.exists === true,
      currentRunArtifact: productionBuildFresh
    },
    remediation: 'Run npm run mobile:android-install -- --build --install --variant release --device <serial> with production signing configured.'
  });
  addCheck(checks, {
    id: 'artifact:android-install',
    title: 'The current production-signed Android release was installed successfully.',
    passed: productionBuildFresh
      && installReport?.status === 'installed'
      && installReport?.install?.attempted === true
      && installReport?.install?.success === true,
    severity: 'device-artifact',
    evidence: {
      status: installReport?.status ?? 'missing',
      installAttempted: installReport?.install?.attempted === true,
      installSuccess: installReport?.install?.success === true,
      currentRunBuildRequired: true
    },
    remediation: 'Build and install the production-signed release on an explicitly selected Android device in one run.'
  });
  addCheck(checks, {
    id: 'artifact:eas-production-build',
    title: 'A fresh EAS production Android build matches the current source and project.',
    passed: easBuildEvidence.passed === true,
    severity: 'device-artifact',
    evidence: easBuildEvidence,
    remediation: 'Run npm run mobile:eas-build -- --execute after production credentials are verified.'
  });
  addCheck(checks, {
    id: 'artifact:device-smoke',
    title: 'Physical/emulator launch and native runtime evidence is present.',
    passed: artifactStatus(deviceReport, ['passed']).passed,
    severity: 'device-artifact',
    evidence: {
      ...artifactStatus(deviceReport, ['passed']),
      actualDeviceVerified: deviceReport?.actualDeviceVerified === true
    },
    remediation: 'Run npm run mobile:device with an installed app on a ready Android device/emulator.'
  });
  addCheck(checks, {
    id: 'artifact:live-bridge-e2e',
    title: 'Live bridge E2E report is present.',
    passed: artifactStatus(liveBridgeReport, ['passed']).passed,
    severity: 'device-artifact',
    evidence: artifactStatus(liveBridgeReport, ['passed']),
    remediation: 'Run npm run mobile:live-bridge-e2e after pairing a mobile runtime with the bridge.'
  });

  const localChecks = checks.filter((item) => item.severity === 'local');
  const credentialChecks = checks.filter((item) => item.severity === 'credential');
  const deviceArtifactChecks = checks.filter((item) => item.severity === 'device-artifact');
  const localStatus = localChecks.every((item) => item.passed) ? 'passed' : 'failed';
  const credentialStatus = credentialChecks.every((item) => item.passed) ? 'passed' : 'external-blocked';
  const deviceEvidenceStatus = deviceArtifactChecks.every((item) => item.passed) ? 'passed' : 'external-blocked';
  const releaseReady = localStatus === 'passed' && credentialStatus === 'passed' && deviceEvidenceStatus === 'passed';
  const totalPassed = checks.filter((item) => item.passed).length;
  const score = Math.round((totalPassed / checks.length) * 1000) / 10;
  const blockers = checks
    .filter((item) => !item.passed)
    .map((item) => ({
      id: item.id,
      severity: item.severity,
      remediation: item.remediation
    }));
  const report = {
    generatedAt: new Date().toISOString(),
    preflightVersion: 'c-mobile-release-preflight-v1',
    status: localStatus !== 'passed' ? 'failed' : releaseReady ? 'passed' : 'external-blocked',
    score,
    localStatus,
    credentialStatus,
    deviceEvidenceStatus,
    appDir,
    project: {
      name: expo.name,
      slug: expo.slug,
      version: expo.version,
      androidPackage: android.package,
      androidVersionCode: android.versionCode,
      iosBundleIdentifier: ios.bundleIdentifier,
      iosBuildNumber: ios.buildNumber
    },
    plan: createMobileReleasePreflightPlan({ appDir }),
    credentialVerification,
    easBuildEvidence,
    privacy: {
      credentialValuesStored: false,
      credentialValuesPassedInProcessArguments: false
    },
    checks,
    blockers
  };
  report.artifacts = { jsonPath, markdownPath, htmlPath };
  await writeMobileReleasePreflightArtifacts(report, { jsonPath, markdownPath, htmlPath });
  return report;
}

export function renderMobileReleasePreflightMarkdown(report) {
  const lines = [
    '# JARVIS Mobile Release Preflight',
    '',
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Score: ${report.score}`,
    `Local status: ${report.localStatus}`,
    `Credential status: ${report.credentialStatus}`,
    `Device evidence status: ${report.deviceEvidenceStatus}`,
    '',
    '## Commands'
  ];
  for (const command of report.plan.commands) {
    lines.push(`- ${command.id}: \`${command.command}\` -> ${command.expected}`);
  }
  lines.push('', '## Checks');
  for (const item of report.checks) {
    lines.push(`- ${item.passed ? 'PASS' : 'BLOCKED'} ${item.id} (${item.severity}): ${item.title}`);
  }
  if (report.blockers.length) {
    lines.push('', '## Blockers');
    for (const blocker of report.blockers) {
      lines.push(`- ${blocker.id}: ${blocker.remediation}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderMobileReleasePreflightHtml(report) {
  const commands = report.plan.commands.map((item) => `<li>${htmlEscape(item.id)}: <code>${htmlEscape(item.command)}</code> - ${htmlEscape(item.expected)}</li>`).join('');
  const checks = report.checks.map((item) => `<li>${item.passed ? 'PASS' : 'BLOCKED'} ${htmlEscape(item.id)} (${htmlEscape(item.severity)}): ${htmlEscape(item.title)}</li>`).join('');
  const blockers = report.blockers.map((item) => `<li>${htmlEscape(item.id)}: ${htmlEscape(item.remediation)}</li>`).join('');
  return `<!doctype html>
<html lang="ko">
<head><meta charset="utf-8"><title>JARVIS Mobile Release Preflight</title></head>
<body>
  <h1>JARVIS Mobile Release Preflight</h1>
  <p>Status: ${htmlEscape(report.status)}</p>
  <p>Local status: ${htmlEscape(report.localStatus)}</p>
  <p>Credential status: ${htmlEscape(report.credentialStatus)}</p>
  <p>Device evidence status: ${htmlEscape(report.deviceEvidenceStatus)}</p>
  <h2>Commands</h2>
  <ul>${commands}</ul>
  <h2>Checks</h2>
  <ul>${checks}</ul>
  <h2>Blockers</h2>
  <ul>${blockers || '<li>none</li>'}</ul>
  <pre>${htmlEscape(JSON.stringify(report, null, 2))}</pre>
</body>
</html>
`;
}

export async function writeMobileReleasePreflightArtifacts(report, {
  jsonPath = 'dist/mobile-release-preflight-report.json',
  markdownPath = 'dist/mobile-release-preflight-report.md',
  htmlPath = 'dist/mobile-release-preflight-report.html'
} = {}) {
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(htmlPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  await writeFile(markdownPath, renderMobileReleasePreflightMarkdown(report), 'utf8');
  await writeFile(htmlPath, renderMobileReleasePreflightHtml(report), 'utf8');
  return { jsonPath, markdownPath, htmlPath };
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app-dir') options.appDir = argv[index + 1];
    if (arg === '--output-dir') options.outputDir = argv[index + 1];
    if (arg === '--json') options.jsonPath = argv[index + 1];
    if (arg === '--md') options.markdownPath = argv[index + 1];
    if (arg === '--html') options.htmlPath = argv[index + 1];
    if (arg === '--strict') options.strict = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = cliOptions(process.argv.slice(2));
  const report = await runMobileReleasePreflight(options);
  console.log('# JARVIS Mobile Release Preflight');
  console.log(`Status: ${report.status}`);
  console.log(`Score: ${report.score}`);
  console.log(`Local status: ${report.localStatus}`);
  console.log(`Credential status: ${report.credentialStatus}`);
  console.log(`Device evidence status: ${report.deviceEvidenceStatus}`);
  console.log(`Reports: ${report.artifacts.jsonPath}, ${report.artifacts.markdownPath}, ${report.artifacts.htmlPath}`);
  if (options.strict && report.status !== 'passed') process.exitCode = 1;
}
