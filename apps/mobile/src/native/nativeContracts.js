export const nativeCapabilityContract = {
  requiredExpoPlugins: ['expo-secure-store', 'expo-local-authentication', 'expo-notifications'],
  requiredDependencies: ['expo-secure-store', 'expo-local-authentication', 'expo-notifications', 'expo-sharing'],
  androidPermissions: ['POST_NOTIFICATIONS', 'USE_BIOMETRIC'],
  iosInfoPlistKeys: ['NSUserNotificationsUsageDescription', 'NSFaceIDUsageDescription'],
  requiredScreens: [
    'PairingScreen',
    'CommandScreen',
    'ApprovalQueueScreen',
    'ApprovalDetailScreen',
    'TaskStatusScreen',
    'ResultScreen',
    'SettingsScreen',
    'GrowthReviewScreen',
    'PoisonQueueScreen'
  ]
};

export function validateNativeMobileConfig({ appJson, packageJson, routes = [] } = {}) {
  const expo = appJson?.expo ?? {};
  const dependencies = packageJson?.dependencies ?? {};
  const plugins = new Set((expo.plugins ?? []).map((item) => Array.isArray(item) ? item[0] : item));
  const androidPermissions = new Set(expo.android?.permissions ?? []);
  const iosInfoPlist = expo.ios?.infoPlist ?? {};
  const routeSet = new Set(routes);

  const checks = [
    ...nativeCapabilityContract.requiredExpoPlugins.map((plugin) => ({
      id: `native:plugin:${plugin}`,
      passed: plugins.has(plugin),
      expected: plugin,
      actual: [...plugins]
    })),
    ...nativeCapabilityContract.requiredDependencies.map((dependency) => ({
      id: `native:dependency:${dependency}`,
      passed: Boolean(dependencies[dependency]),
      expected: dependency,
      actual: dependencies[dependency] ?? null
    })),
    ...nativeCapabilityContract.androidPermissions.map((permission) => ({
      id: `native:android-permission:${permission}`,
      passed: androidPermissions.has(permission),
      expected: permission,
      actual: [...androidPermissions]
    })),
    ...nativeCapabilityContract.iosInfoPlistKeys.map((key) => ({
      id: `native:ios-plist:${key}`,
      passed: Boolean(iosInfoPlist[key]),
      expected: key,
      actual: iosInfoPlist[key] ?? null
    })),
    ...nativeCapabilityContract.requiredScreens.map((screen) => ({
      id: `native:route:${screen}`,
      passed: routeSet.has(screen),
      expected: screen,
      actual: routes
    }))
  ];

  return {
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    checks,
    contract: nativeCapabilityContract
  };
}
