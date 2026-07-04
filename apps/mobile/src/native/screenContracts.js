export const mobileScreenContract = {
  rootTestId: 'jarvis-mobile-root',
  titleTestId: 'jarvis-mobile-title',
  routeTestId: 'jarvis-current-route',
  routeButtonPrefix: 'route-button-',
  nativeRuntimeProbeTestId: 'native-runtime-probe',
  nativeRuntimeProbeLabels: ['Native runtime probe', 'SecureStore native:', 'Notifications native:', 'Sharing native:']
};

export function expectedRouteButtonTestIds(routes = []) {
  return routes.map((route) => `${mobileScreenContract.routeButtonPrefix}${route}`);
}

export function validateMobileScreenContract({ appSource = '', routes = [] } = {}) {
  const expectedTestIds = [
    mobileScreenContract.rootTestId,
    mobileScreenContract.titleTestId,
    mobileScreenContract.routeTestId,
    mobileScreenContract.nativeRuntimeProbeTestId,
    ...expectedRouteButtonTestIds(routes)
  ];
  const mappedRouteButtonPattern = `${mobileScreenContract.routeButtonPrefix}\${item}`;
  const checks = expectedTestIds.map((testId) => {
    const directMatch = appSource.includes(testId);
    const mappedRouteMatch = testId.startsWith(mobileScreenContract.routeButtonPrefix)
      && appSource.includes(mappedRouteButtonPattern);
    return {
      id: `screen:test-id:${testId}`,
      expected: testId,
      passed: directMatch || mappedRouteMatch,
      actual: directMatch ? testId : (mappedRouteMatch ? mappedRouteButtonPattern : null)
    };
  });

  checks.push({
    id: 'screen:accessibility:route-buttons',
    expected: 'accessibilityRole="button"',
    passed: appSource.includes('accessibilityRole="button"'),
    actual: appSource.includes('accessibilityRole="button"') ? 'present' : null
  });
  checks.push({
    id: 'screen:accessibility:current-route',
    expected: 'accessibilityLabel={`current route ${route}`}',
    passed: appSource.includes('accessibilityLabel={`current route ${route}`}'),
    actual: appSource.includes('accessibilityLabel={`current route ${route}`}') ? 'present' : null
  });
  for (const label of mobileScreenContract.nativeRuntimeProbeLabels) {
    checks.push({
      id: `screen:native-probe:${label}`,
      expected: label,
      passed: appSource.includes(label),
      actual: appSource.includes(label) ? 'present' : null
    });
  }

  return {
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    checks,
    contract: mobileScreenContract
  };
}
