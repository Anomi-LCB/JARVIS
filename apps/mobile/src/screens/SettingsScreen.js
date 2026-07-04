import { createRetryPolicySettingsState } from '../components/RetryPolicySettingsPanel.js';

export function createSettingsScreenViewModel({ mobileRuntime }) {
  const session = mobileRuntime.sessionStatus();
  const tokenStorage = mobileRuntime.tokenStorageStatus();
  const tokenLifecycle = mobileRuntime.tokenLifecycleStatus();
  const tokenRecovery = mobileRuntime.tokenRecoveryState();
  const notifications = mobileRuntime.notificationStatus();
  const retryPolicy = mobileRuntime.queueRetryPolicy();
  return {
    route: 'SettingsScreen',
    connection: mobileRuntime.connection,
    paired: Boolean(mobileRuntime.token()),
    security: {
      tokenStorage,
      tokenLifecycle,
      tokenRecovery,
      session,
      pairedTokenSealed: Boolean(tokenStorage.exists && tokenStorage.sealed && tokenStorage.plaintextExposed === false),
      sensitiveActionsLocked: session.locked
    },
    notifications,
    retryPolicy,
    retryPolicyState(draft = {}) {
      return createRetryPolicySettingsState({
        policy: retryPolicy?.success === false ? null : retryPolicy,
        readiness: mobileRuntime.sensitiveActionReadiness('queue-retry-policy:update'),
        draft
      });
    },
    saveRetryPolicy(draft = {}) {
      const state = this.retryPolicyState(draft);
      if (!state.saveAction.enabled) {
        return { success: false, error: { code: 'C_RETRY_POLICY_SAVE_NOT_AVAILABLE', message: state.saveAction.blockedReason } };
      }
      return mobileRuntime.updateQueueRetryPolicy(state.draft);
    },
    checkConnection() {
      return mobileRuntime.checkConnection();
    },
    requestNotifications(options) {
      return mobileRuntime.requestNotificationPermission(options);
    },
    registerPushToken(token, options) {
      return mobileRuntime.registerPushToken(token, options);
    },
    rotatePushToken(token, options) {
      return mobileRuntime.rotatePushToken(token, options);
    },
    verifyNotificationReceipts(options) {
      return mobileRuntime.verifyNotificationReceipts(options);
    },
    runNotificationProviderDrill(options) {
      return mobileRuntime.runNotificationProviderDrill(options);
    },
    runNotificationTokenRotationTrend(options) {
      return mobileRuntime.runNotificationTokenRotationTrend(options);
    },
    runNotificationProductGate(options) {
      return mobileRuntime.runNotificationProductGate(options);
    },
    revokeNotifications() {
      return mobileRuntime.revokeNotificationPermission();
    },
    configureSessionPin(pin) {
      return mobileRuntime.configureSessionPin(pin);
    },
    unlockSession(pin) {
      return mobileRuntime.unlockSession(pin);
    },
    unlockSessionWithBiometric(options = {}) {
      return mobileRuntime.unlockSessionWithBiometric(options);
    },
    lockSession(reason = 'settings-manual-lock') {
      return mobileRuntime.lockSession(reason);
    },
    handleAppStateChange(nextState) {
      return mobileRuntime.handleAppStateChange(nextState);
    },
    runLifecycleSoak(sequence) {
      return mobileRuntime.runLifecycleSoak(sequence);
    },
    runSessionLockProductGate(options) {
      return mobileRuntime.runSessionLockProductGate(options);
    },
    rotateDeviceToken(options) {
      return mobileRuntime.rotateDeviceToken(options);
    },
    revokeBridgeDevice(options) {
      return mobileRuntime.revokeBridgeDevice(options);
    },
    retryTokenRecoveryQueue(options) {
      return mobileRuntime.retryTokenRecoveryQueue(options);
    },
    runSecureTokenProductGate() {
      return mobileRuntime.runSecureTokenProductGate();
    },
    disconnect() {
      mobileRuntime.disconnect();
      return { nextRoute: 'PairingScreen' };
    }
  };
}
