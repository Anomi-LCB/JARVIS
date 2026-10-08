export const mobileScreenContract = Object.freeze({
  contractVersion: 'c-mobile-production-home-screen-contract-v2',
  rootTestId: 'jarvis-mobile-root',
  titleTestId: 'jarvis-mobile-title',
  routeTestId: 'jarvis-current-route',
  homeContentTestId: 'screen-content-HomeScreen',
  commandInputTestId: 'home-command-input',
  submitButtonTestId: 'home-submit-button',
  conversationButtonTestId: 'home-conversation-button',
  pairingTestIds: [
    'home-bridge-url-input',
    'home-pairing-code-input',
    'home-pair-button'
  ]
});

export function validateMobileScreenContract({ appSource = '' } = {}) {
  const expectedTestIds = [
    mobileScreenContract.rootTestId,
    mobileScreenContract.titleTestId,
    mobileScreenContract.routeTestId,
    mobileScreenContract.homeContentTestId,
    mobileScreenContract.commandInputTestId,
    mobileScreenContract.submitButtonTestId,
    mobileScreenContract.conversationButtonTestId,
    ...mobileScreenContract.pairingTestIds
  ];
  const checks = expectedTestIds.map((testId) => ({
    id: `screen:test-id:${testId}`,
    expected: testId,
    passed: appSource.includes(testId),
    actual: appSource.includes(testId) ? testId : null
  }));

  checks.push({
    id: 'screen:accessibility:command-submit',
    expected: 'accessibilityLabel="자비스에게 시키기"',
    passed: appSource.includes('accessibilityLabel="자비스에게 시키기"'),
    actual: appSource.includes('accessibilityLabel="자비스에게 시키기"') ? 'present' : null
  });
  checks.push({
    id: 'screen:accessibility:conversation-mode',
    expected: 'accessibilityLabel="대화 모드 시작"',
    passed: appSource.includes('accessibilityLabel="대화 모드 시작"'),
    actual: appSource.includes('accessibilityLabel="대화 모드 시작"') ? 'present' : null
  });
  checks.push({
    id: 'screen:product:home-is-primary-surface',
    expected: 'renderHomeScreen primary surface',
    passed: appSource.includes('return renderHomeScreen();') && appSource.includes('const isHome = true;'),
    actual: appSource.includes('return renderHomeScreen();') && appSource.includes('const isHome = true;') ? 'present' : null
  });

  return {
    status: checks.every((item) => item.passed) ? 'passed' : 'failed',
    checks,
    contract: mobileScreenContract
  };
}
