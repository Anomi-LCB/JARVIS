import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createBridgeReverseProxyDeploymentGuide,
  createMdnsDiscoveryAllowlistUx,
  LocalNetworkGuard,
  runDnsRebindingResolverDrill
} from '../apps/bridge/src/network-guard.js';

export const bridgeNetworkGuardProductDrillVersion = 'd-bridge-network-guard-product-drill-v1';

export async function runBridgeNetworkGuardDrillReport({
  jsonPath = 'dist/bridge-network-guard-drill-report.json',
  markdownPath = 'dist/bridge-network-guard-drill-report.md',
  csvPath = 'dist/bridge-network-guard-drill-report.csv',
  hostname = 'jarvis-rebind.test',
  useSystemResolver = false,
  clock = () => new Date()
} = {}) {
  const guard = new LocalNetworkGuard({
    allowedHostnames: ['jarvis.local'],
    trustedProxyHosts: ['127.0.0.1']
  });
  const resolver = useSystemResolver
    ? undefined
    : async (_hostname, { sampleIndex }) => (sampleIndex === 0 ? ['93.184.216.34'] : ['127.0.0.1']);
  const dnsRebinding = await runDnsRebindingResolverDrill({
    hostname,
    guard,
    resolver,
    samples: 2,
    clock
  });
  const reverseProxyGuide = createBridgeReverseProxyDeploymentGuide({
    publicHostname: 'jarvis.local',
    upstreamHost: '127.0.0.1',
    upstreamPort: 17777,
    allowedHostnames: ['jarvis.local'],
    trustedProxyHosts: ['127.0.0.1']
  });
  const mdnsAllowlistUx = createMdnsDiscoveryAllowlistUx({
    allowedHostnames: ['jarvis.local'],
    selectedHostnames: ['jarvis-lab.local'],
    services: [
      {
        serviceId: 'mdns_jarvis_lab',
        displayName: 'JARVIS Lab Bridge',
        hostname: 'jarvis-lab.local',
        serviceType: '_jarvis._tcp.local',
        port: 17777,
        addresses: ['192.168.0.42']
      },
      {
        serviceId: 'mdns_jarvis_known',
        displayName: 'JARVIS Known Bridge',
        hostname: 'jarvis.local',
        serviceType: '_jarvis._tcp.local',
        port: 17777,
        addresses: ['192.168.0.10']
      }
    ],
    clock
  });
  const checks = [
    {
      id: 'dns-rebinding-resolver-drill-passed',
      passed: dnsRebinding.status === 'passed',
      evidence: dnsRebinding.guardDecision
    },
    {
      id: 'reverse-proxy-deployment-guide-ready',
      passed: reverseProxyGuide.guideVersion === 'd-bridge-reverse-proxy-deployment-guide-v1'
        && reverseProxyGuide.requiredNetworkGuardEnv.JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS.includes('127.0.0.1'),
      evidence: reverseProxyGuide.requiredNetworkGuardEnv
    },
    {
      id: 'mdns-discovery-allowlist-ux-ready',
      passed: mdnsAllowlistUx.uxVersion === 'd-mdns-discovery-allowlist-ux-v1'
        && mdnsAllowlistUx.proposedAllowlist.includes('jarvis-lab.local'),
      evidence: {
        state: mdnsAllowlistUx.state,
        proposedAllowlist: mdnsAllowlistUx.proposedAllowlist
      }
    }
  ];
  const releaseDossier = createBridgeNetworkGuardReleaseDossier({
    dnsRebinding,
    reverseProxyGuide,
    mdnsAllowlistUx,
    checks,
    hostname,
    clock
  });
  checks.push({
    id: 'network-guard-release-dossier-ready',
    passed: releaseDossier.dossierVersion === 'd-bridge-network-guard-release-dossier-v1'
      && releaseDossier.status === 'passed'
  });
  const report = {
    reportVersion: bridgeNetworkGuardProductDrillVersion,
    generatedAt: clock().toISOString(),
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    dnsRebinding,
    reverseProxyGuide,
    mdnsAllowlistUx,
    releaseDossier,
    checks
  };
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await mkdir(dirname(csvPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  await writeFile(csvPath, renderCsv(report), 'utf8');
  return report;
}

function renderMarkdown(report) {
  return [
    '# Bridge Network Guard Drill',
    '',
    `Report version: ${report.reportVersion}`,
    `Status: ${report.status}`,
    `DNS rebinding drill: ${report.dnsRebinding.status}`,
    `Reverse proxy guide: ${report.reverseProxyGuide.guideVersion}`,
    `mDNS allowlist UX: ${report.mdnsAllowlistUx.uxVersion}`,
    `Release dossier: ${report.releaseDossier.dossierVersion} (${report.releaseDossier.status})`,
    '',
    '## Release Checks',
    '',
    ...report.releaseDossier.releaseChecks.map((check) => `- ${check.passed ? 'pass' : 'fail'}: ${check.checkId}`),
    '',
    '## Checks',
    '',
    ...report.checks.map((check) => `- ${check.passed ? 'pass' : 'fail'}: ${check.id}`)
  ].join('\n');
}

function renderCsv(report) {
  return [
    'kind,id,status,detail',
    `report,${report.reportVersion},${report.status},checks=${report.checks.length}`,
    `dossier,${report.releaseDossier.dossierVersion},${report.releaseDossier.status},sha256=${report.releaseDossier.dossierSha256}`,
    ...report.releaseDossier.releaseChecks.map((check) => `release_check,${check.checkId},${check.passed ? 'passed' : 'failed'},`),
    ...report.checks.map((check) => `check,${check.id},${check.passed ? 'passed' : 'failed'},`)
  ].join('\n') + '\n';
}

export function createBridgeNetworkGuardReleaseDossier({
  dnsRebinding,
  reverseProxyGuide,
  mdnsAllowlistUx,
  checks = [],
  hostname = 'jarvis-rebind.test',
  clock = () => new Date()
} = {}) {
  const baseReleaseChecks = [
    {
      checkId: 'network_guard_product_drill_passed',
      passed: checks.every((check) => check.passed)
    },
    {
      checkId: 'dns_rebinding_resolver_drill_passed',
      passed: dnsRebinding?.reportVersion === 'd-dns-rebinding-resolver-drill-v1'
        && dnsRebinding.status === 'passed'
        && dnsRebinding.guardDecision?.dnsRebindingSuspected === true
    },
    {
      checkId: 'reverse_proxy_deployment_guide_ready',
      passed: reverseProxyGuide?.guideVersion === 'd-bridge-reverse-proxy-deployment-guide-v1'
        && reverseProxyGuide.requiredNetworkGuardEnv?.JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS
        && reverseProxyGuide.validation?.some((item) => item.id === 'bridge-soak-through-proxy')
    },
    {
      checkId: 'mdns_allowlist_review_ready',
      passed: mdnsAllowlistUx?.uxVersion === 'd-mdns-discovery-allowlist-ux-v1'
        && mdnsAllowlistUx.proposedAllowlist?.length > 0
        && mdnsAllowlistUx.cards?.every((card) => card.rawSecretStored === false)
    },
    {
      checkId: 'network_guard_raw_secret_retention_safe',
      passed: mdnsAllowlistUx?.cards?.every((card) => card.rawSecretStored === false)
        && JSON.stringify(dnsRebinding ?? {}).includes('deviceToken') === false
    }
  ];
  const artifactManifest = {
    manifestVersion: 'd-bridge-network-guard-release-artifact-manifest-v1',
    drillReportVersion: bridgeNetworkGuardProductDrillVersion,
    dnsRebindingReportVersion: dnsRebinding?.reportVersion ?? null,
    reverseProxyGuideVersion: reverseProxyGuide?.guideVersion ?? null,
    mdnsUxVersion: mdnsAllowlistUx?.uxVersion ?? null,
    hostname,
    proposedAllowlist: mdnsAllowlistUx?.proposedAllowlist ?? [],
    rawDeviceTokenStored: false,
    rawNetworkSecretStored: false,
    rawProxyCredentialStored: false,
    rawLeakCheck: {
      checkedSurface: ['dns_rebinding_drill', 'reverse_proxy_guide', 'mdns_allowlist_ux'],
      rawLeakDetected: JSON.stringify(dnsRebinding ?? {}).includes('deviceToken')
        || mdnsAllowlistUx?.cards?.some((card) => card.rawSecretStored !== false) === true
    }
  };
  const operationalHandoffManifest = {
    manifestVersion: 'd-bridge-network-guard-operational-handoff-manifest-v1',
    generatedAt: clock().toISOString(),
    owner: 'bridge-network-guard-release-owner',
    scope: 'local_private_lan_boundary_dns_rebinding_forwarded_proxy_mdns_allowlist',
    status: baseReleaseChecks.every((check) => check.passed)
      && artifactManifest.rawLeakCheck.rawLeakDetected === false ? 'ready' : 'blocked',
    healthHandshakeVersion: 'd-bridge-network-guard-health-handshake-v1',
    healthHandshake: {
      dnsRebindingDrillPassed: dnsRebinding?.status === 'passed',
      reverseProxyGuideReady: reverseProxyGuide?.guideVersion === 'd-bridge-reverse-proxy-deployment-guide-v1',
      mdnsAllowlistReviewReady: mdnsAllowlistUx?.uxVersion === 'd-mdns-discovery-allowlist-ux-v1'
        && mdnsAllowlistUx.proposedAllowlist?.length > 0,
      forwardedHeaderPolicyReady: reverseProxyGuide?.requiredNetworkGuardEnv?.JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS === 'true',
      rawLeakDetected: artifactManifest.rawLeakCheck.rawLeakDetected
    },
    fallbackPolicy: {
      policyVersion: 'd-bridge-network-guard-fallback-policy-v1',
      primaryFlow: 'bind_bridge_to_loopback_or_private_lan_and_block_public_dns_rebinding_hosts',
      fallbackFlows: [
        'disable_forwarded_headers_when_reverse_proxy_trust_list_is_missing',
        'keep_mdns_discovered_hosts_in_review_required_until_user_allowlists_them',
        'block_release_when_dns_rebinding_drill_or_proxy_guide_fails',
        'block_release_when_device_token_proxy_secret_or_raw_secret_is_retained'
      ],
      operatorEscalation: 'bridge_network_guard_release_and_physical_lan_soak_report'
    },
    rawDeviceTokenStored: false,
    rawNetworkSecretStored: false,
    rawProxyCredentialStored: false
  };
  const ciNightlyGatePlan = {
    planVersion: 'd-bridge-network-guard-ci-nightly-gate-plan-v1',
    requiredCommand: 'npm run bridge:network-guard-drill',
    requiredForPr: true,
    requiredForNightly: true,
    requiredChecks: [
      'network_guard_product_drill_passed',
      'dns_rebinding_resolver_drill_passed',
      'reverse_proxy_deployment_guide_ready',
      'mdns_allowlist_review_ready',
      'network_guard_raw_secret_retention_safe',
      'network_guard_operational_handoff_ready',
      'network_guard_worm_promotion_package_ready'
    ],
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    rawDeviceTokenStored: false,
    rawProxyCredentialStored: false
  };
  const externalWormPromotionPackage = {
    packageVersion: 'd-bridge-network-guard-worm-promotion-package-v1',
    providerContractVersion: 'd-bridge-network-guard-worm-provider-contract-v1',
    status: artifactManifest.manifestVersion === 'd-bridge-network-guard-release-artifact-manifest-v1'
      && artifactManifest.rawLeakCheck.rawLeakDetected === false
      && operationalHandoffManifest.status === 'ready'
      && ciNightlyGatePlan.planVersion === 'd-bridge-network-guard-ci-nightly-gate-plan-v1'
      ? 'ready'
      : 'blocked',
    requiredForFinalRelease: true,
    artifactManifestHash: sha256Hex(canonicalJson(artifactManifest)),
    operationalHandoffHash: sha256Hex(canonicalJson(operationalHandoffManifest)),
    ciNightlyGatePlanHash: sha256Hex(canonicalJson(ciNightlyGatePlan)),
    storagePolicy: {
      appendOnly: true,
      objectLockRequired: true,
      minimumRetentionDays: 365,
      overwriteAllowed: false,
      deleteAllowed: false
    },
    rawDeviceTokenStored: false,
    rawNetworkSecretStored: false,
    rawProxyCredentialStored: false
  };
  const releaseChecks = [
    ...baseReleaseChecks,
    {
      checkId: 'network_guard_operational_handoff_ready',
      passed: operationalHandoffManifest.manifestVersion === 'd-bridge-network-guard-operational-handoff-manifest-v1'
        && operationalHandoffManifest.healthHandshakeVersion === 'd-bridge-network-guard-health-handshake-v1'
        && operationalHandoffManifest.fallbackPolicy.policyVersion === 'd-bridge-network-guard-fallback-policy-v1'
        && operationalHandoffManifest.status === 'ready'
    },
    {
      checkId: 'network_guard_worm_promotion_package_ready',
      passed: externalWormPromotionPackage.packageVersion === 'd-bridge-network-guard-worm-promotion-package-v1'
        && externalWormPromotionPackage.providerContractVersion === 'd-bridge-network-guard-worm-provider-contract-v1'
        && externalWormPromotionPackage.status === 'ready'
    }
  ];
  const unsignedDossier = {
    dossierVersion: 'd-bridge-network-guard-release-dossier-v1',
    generatedAt: clock().toISOString(),
    status: releaseChecks.every((check) => check.passed) ? 'passed' : 'blocked',
    releaseChecks,
    artifactManifest,
    operationalHandoffManifest,
    ciNightlyGatePlan,
    externalWormPromotionPackage,
    physicalEvidence: {
      requiredForFinalRelease: true,
      status: 'pending',
      requiredArtifacts: [
        '24h bridge:server-soak behind physical TLS reverse proxy',
        'physical mobile LAN pairing through selected mDNS allowlist entry',
        'DNS rebinding drill with production resolver logs'
      ]
    },
    operationsRunbook: [
      'Keep the bridge bound to loopback or a private LAN interface.',
      'Only trust forwarded headers from configured reverse proxy hosts.',
      'Require explicit user review before adding mDNS-discovered hostnames to JARVIS_BRIDGE_ALLOWED_HOSTS.',
      'Run bridge:network-guard-drill after proxy, DNS, or LAN discovery changes.'
    ]
  };
  return {
    ...unsignedDossier,
    dossierSha256: sha256Hex(canonicalJson(unsignedDossier))
  };
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runBridgeNetworkGuardDrillReport({
    jsonPath: readFlag('--output') ?? readFlag('--report') ?? 'dist/bridge-network-guard-drill-report.json',
    markdownPath: readFlag('--markdown') ?? 'dist/bridge-network-guard-drill-report.md',
    csvPath: readFlag('--csv') ?? 'dist/bridge-network-guard-drill-report.csv',
    hostname: readFlag('--hostname') ?? 'jarvis-rebind.test',
    useSystemResolver: readFlag('--system-resolver') === 'true'
  });
  console.log(`Bridge network guard drill: ${report.status}`);
  console.log(`Report: ${readFlag('--output') ?? readFlag('--report') ?? 'dist/bridge-network-guard-drill-report.json'}`);
}
