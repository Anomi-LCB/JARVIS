import { createInitialMobileViewState } from './state/mobile-view-state.js';
import { MobileRoutes } from './navigation/routes.js';

export function createMobileAppShell() {
  const routes = Object.values(MobileRoutes);
  const bootstrapManifest = createMobileBootstrapManifest({ routes });
  return {
    shellVersion: 'c-mobile-app-shell-v1',
    initialRouteName: MobileRoutes.PairingScreen,
    routes,
    initialState: createInitialMobileViewState(),
    bootstrapManifest
  };
}

export function createMobileBootstrapManifest({ routes = Object.values(MobileRoutes) } = {}) {
  return {
    bootstrapVersion: 'c-mobile-app-bootstrap-manifest-v1',
    initialRouteName: MobileRoutes.PairingScreen,
    routeCount: routes.length,
    routes,
    deepLinkScheme: 'jarvis',
    requiredNativeStores: ['expo-secure-store'],
    requiredNativeModules: ['expo-secure-store', 'expo-local-authentication', 'expo-notifications', 'expo-sharing'],
    stateStores: ['connection', 'device', 'offline', 'approvals', 'tasks', 'notifications', 'growth', 'poisonQueue', 'security'],
    offlinePolicy: {
      autoSendQueuedCommands: false,
      requiresUserReview: true,
      pendingQueueDetailPanel: 'c-command-pending-queue-detail-panel-v1'
    },
    nativeProbe: {
      testID: 'native-runtime-probe',
      labels: ['SecureStore native:', 'Notifications native:', 'Sharing native:']
    }
  };
}

export function createMobileAppStructureProductGate({
  shell = createMobileAppShell(),
  nativeReadiness = null,
  screenReadiness = null,
  productMatrix = null,
  fileChecks = []
} = {}) {
  const requiredRoutes = [
    'PairingScreen',
    'CommandScreen',
    'ApprovalQueueScreen',
    'ApprovalDetailScreen',
    'TaskStatusScreen',
    'ResultScreen',
    'SettingsScreen',
    'GrowthReviewScreen',
    'PoisonQueueScreen'
  ];
  const checks = [
    {
      checkId: 'app_shell_bootstrap_manifest_available',
      status: shell.bootstrapManifest?.bootstrapVersion === 'c-mobile-app-bootstrap-manifest-v1' ? 'passed' : 'blocked',
      routeCount: shell.bootstrapManifest?.routeCount ?? 0
    },
    {
      checkId: 'all_document_routes_registered',
      status: requiredRoutes.every((route) => shell.routes.includes(route)) ? 'passed' : 'blocked',
      requiredRoutes
    },
    {
      checkId: 'native_contract_passed',
      status: nativeReadiness?.status === 'passed' ? 'passed' : 'blocked',
      nativeStatus: nativeReadiness?.status ?? null
    },
    {
      checkId: 'screen_contract_passed',
      status: screenReadiness?.status === 'passed' ? 'passed' : 'blocked',
      screenStatus: screenReadiness?.status ?? null
    },
    {
      checkId: 'product_artifact_manifest_available',
      status: productMatrix?.artifactManifest?.expectedReports?.includes('dist/mobile-verification-report.json') ? 'passed' : 'blocked',
      expectedReports: productMatrix?.artifactManifest?.expectedReports?.length ?? 0
    },
    {
      checkId: 'required_mobile_files_present',
      status: fileChecks.length === 0 || fileChecks.every((item) => item.passed) ? 'passed' : 'blocked',
      fileCount: fileChecks.length
    }
  ];
  return {
    productGateVersion: 'c-mobile-app-structure-product-gate-v1',
    shellVersion: shell.shellVersion,
    bootstrapManifest: shell.bootstrapManifest,
    status: checks.every((check) => check.status === 'passed') ? 'passed' : 'blocked',
    checks
  };
}
