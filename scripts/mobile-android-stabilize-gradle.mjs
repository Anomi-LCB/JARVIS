import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const defaultAppDir = 'apps/mobile';

function sdkRoot(env = process.env) {
  return env.ANDROID_HOME
    ?? env.ANDROID_SDK_ROOT
    ?? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Android', 'Sdk') : null);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function assertInside(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  if (child !== parent && !child.startsWith(`${parent}${sep}`)) {
    throw new Error(`Refusing to touch path outside ${parent}: ${child}`);
  }
}

function resolvePackageJson(packageName, appDir = defaultAppDir) {
  return require.resolve(`${packageName}/package.json`, { paths: [resolve(appDir)] });
}

function resolveGradleSources(appDir = defaultAppDir) {
  const reactNativePackageJson = resolvePackageJson('react-native', appDir);
  const reactNativeGradlePluginPackageJson = require.resolve('@react-native/gradle-plugin/package.json', {
    paths: [reactNativePackageJson]
  });
  const expoPackageJson = resolvePackageJson('expo', appDir);
  const expoAutolinkingPackageJson = require.resolve('expo-modules-autolinking/package.json', {
    paths: [expoPackageJson]
  });

  return {
    reactNativeGradlePlugin: dirname(reactNativeGradlePluginPackageJson),
    expoGradlePlugin: resolve(expoAutolinkingPackageJson, '../android/expo-gradle-plugin')
  };
}

function stableSettingsGradle() {
  return `pluginManagement {
  def jarvisIncludesDir = new File(settingsDir, ".jarvis-gradle-includes")
  includeBuild(new File(jarvisIncludesDir, "react-native-gradle-plugin").absolutePath)

  def expoPluginsPath = new File(
    providers.exec {
      workingDir(rootDir)
      commandLine("node", "--print", "require.resolve('expo-modules-autolinking/package.json', { paths: [require.resolve('expo/package.json')] })")
    }.standardOutput.asText.get().trim(),
    "../android/expo-gradle-plugin"
  ).absolutePath
  includeBuild(expoPluginsPath)

  repositories {
    google()
    mavenCentral()
    gradlePluginPortal()
  }
}

plugins {
  id("com.facebook.react.settings")
  id("expo-autolinking-settings")
}

extensions.configure(com.facebook.react.ReactSettingsExtension) { ex ->
  if (System.getenv('EXPO_USE_COMMUNITY_AUTOLINKING') == '1') {
    ex.autolinkLibrariesFromCommand()
  } else {
    ex.autolinkLibrariesFromCommand(expoAutolinking.rnConfigCommand)
  }
}
expoAutolinking.useExpoModules()

rootProject.name = 'JARVIS Mobile'

expoAutolinking.useExpoVersionCatalog()

include ':app'
includeBuild(new File(settingsDir, ".jarvis-gradle-includes/react-native-gradle-plugin").absolutePath)
`;
}

async function copyStableInclude({ source, target, includeRoot }) {
  assertInside(target, includeRoot);
  await rm(target, { recursive: true, force: true });
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      return !['.gradle', '.kotlin', 'build', 'out'].includes(name);
    }
  });
}

async function clearGeneratedAutolinking({ androidDir }) {
  const targets = [
    join(androidDir, 'build', 'generated', 'autolinking'),
    join(androidDir, 'app', 'build', 'generated', 'autolinking')
  ];
  const cleared = [];
  for (const target of targets) {
    assertInside(target, androidDir);
    if (await exists(target)) {
      await rm(target, { recursive: true, force: true });
      cleared.push(target);
    }
  }
  return cleared;
}

async function fileCount(path) {
  const item = await stat(path);
  if (!item.isDirectory()) return 1;
  const entries = await readdir(path, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    count += await fileCount(join(path, entry.name));
  }
  return count;
}

export async function stabilizeAndroidGradle({
  appDir = defaultAppDir,
  env = process.env,
  jsonPath = 'dist/mobile-android-gradle-stabilize-report.json'
} = {}) {
  const androidDir = resolve(appDir, 'android');
  const includeRoot = join(androidDir, '.jarvis-gradle-includes');
  const settingsPath = join(androidDir, 'settings.gradle');
  const localPropertiesPath = join(androidDir, 'local.properties');
  const sources = resolveGradleSources(appDir);
  const targets = {
    reactNativeGradlePlugin: join(includeRoot, 'react-native-gradle-plugin'),
    expoGradlePlugin: join(includeRoot, 'expo-gradle-plugin')
  };
  const sourceState = {
    reactNativeGradlePlugin: await exists(sources.reactNativeGradlePlugin),
    expoGradlePlugin: await exists(sources.expoGradlePlugin),
    settingsGradle: await exists(settingsPath)
  };

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    appDir,
    androidDir,
    includeRoot,
    sources,
    targets,
    sourceState,
    copied: false,
    settingsPatched: false,
    localPropertiesPatched: false,
    autolinkingOutputsCleared: [],
    targetFileCounts: {},
    jsonPath
  };

  if (!sourceState.reactNativeGradlePlugin || !sourceState.expoGradlePlugin || !sourceState.settingsGradle) {
    await mkdir(dirname(jsonPath), { recursive: true });
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  await mkdir(includeRoot, { recursive: true });
  await copyStableInclude({
    source: sources.reactNativeGradlePlugin,
    target: targets.reactNativeGradlePlugin,
    includeRoot
  });
  report.autolinkingOutputsCleared = await clearGeneratedAutolinking({ androidDir });

  const nextSettings = stableSettingsGradle();
  const currentSettings = await readFile(settingsPath, 'utf8');
  if (currentSettings !== nextSettings) {
    await writeFile(settingsPath, nextSettings, 'utf8');
    report.settingsPatched = true;
  }

  const sdk = sdkRoot(env);
  if (sdk) {
    const nextLocalProperties = `sdk.dir=${sdk.replaceAll('\\', '\\\\')}\n`;
    const currentLocalProperties = await exists(localPropertiesPath)
      ? await readFile(localPropertiesPath, 'utf8')
      : '';
    if (currentLocalProperties !== nextLocalProperties) {
      await writeFile(localPropertiesPath, nextLocalProperties, 'utf8');
      report.localPropertiesPatched = true;
    }
  }

  report.copied = true;
  report.targetFileCounts = {
    reactNativeGradlePlugin: await fileCount(targets.reactNativeGradlePlugin),
    expoGradlePlugin: 0
  };
  report.status = 'stabilized';

  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

function cliOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--app-dir') options.appDir = argv[index + 1];
    if (arg === '--json') options.jsonPath = argv[index + 1];
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await stabilizeAndroidGradle(cliOptions(process.argv.slice(2)));
  console.log('# JARVIS Android Gradle Stabilization');
  console.log(`Status: ${report.status}`);
  console.log(`React Native Gradle plugin copied: ${report.targetFileCounts.reactNativeGradlePlugin ?? 0} files`);
  console.log(`Expo Gradle plugin copied: ${report.targetFileCounts.expoGradlePlugin ?? 0} files`);
  console.log(`Settings patched: ${report.settingsPatched}`);
  console.log(`Local properties patched: ${report.localPropertiesPatched}`);
  console.log(`Autolinking outputs cleared: ${report.autolinkingOutputsCleared.length}`);
  console.log(`Report: ${report.jsonPath}`);
  if (report.status !== 'stabilized') process.exitCode = 1;
}
