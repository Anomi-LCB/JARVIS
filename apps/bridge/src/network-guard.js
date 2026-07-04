import { resolve4, resolve6 } from 'node:dns/promises';
import { isIP } from 'node:net';

export class LocalNetworkGuard {
  constructor({
    allowedHostnames = [],
    trustedProxyHosts = [],
    allowPrivateLan = true,
    allowLoopback = true,
    allowForwardedHeaders = true
  } = {}) {
    this.allowedHostnames = new Set(allowedHostnames.map(normalizeHost).filter(Boolean));
    this.trustedProxyHosts = new Set(trustedProxyHosts.map(normalizeHost).filter(Boolean));
    this.allowPrivateLan = allowPrivateLan;
    this.allowLoopback = allowLoopback;
    this.allowForwardedHeaders = allowForwardedHeaders;
  }

  evaluate({ hostHeader = '127.0.0.1', remoteAddress = null, headers = {} } = {}) {
    const host = normalizeHost(hostHeader);
    const forwardedHost = headers['x-forwarded-host'];
    const forwardedFor = headers['x-forwarded-for'];
    const forwardedProto = headers['x-forwarded-proto'];
    const remoteHost = normalizeHost(remoteAddress);
    const options = {
      allowedHostnames: this.allowedHostnames,
      trustedProxyHosts: this.trustedProxyHosts,
      allowPrivateLan: this.allowPrivateLan,
      allowLoopback: this.allowLoopback,
      remoteAddress: remoteHost
    };
    const checks = [
      classifyHost(host, 'host', options),
      ...(forwardedHost ? [classifyHost(normalizeHost(String(forwardedHost).split(',')[0]), 'x-forwarded-host', options)] : []),
      ...(forwardedFor ? String(forwardedFor).split(',').map((item) => classifyHost(normalizeHost(item), 'x-forwarded-for', options)) : []),
      ...(remoteAddress ? [classifyHost(remoteHost, 'remote-address', options)] : [])
    ];
    const proxyHeaderPresent = Boolean(forwardedHost || forwardedFor || forwardedProto);
    const proxyPolicy = this.proxyPolicy({ proxyHeaderPresent, remoteHost, forwardedProto });
    if (!proxyPolicy.allowed) checks.push(blocked('proxy-policy', remoteHost, proxyPolicy.reason));
    const blockedCheck = checks.find((check) => check.allowed === false);
    return {
      allowed: !blockedCheck,
      host,
      remoteAddress: remoteHost,
      proxyHeaderPresent,
      proxyPolicy,
      dnsRebindingSuspected: blockedCheck?.reason === 'dns-rebinding-hostname',
      allowlist: {
        allowedHostnames: [...this.allowedHostnames],
        trustedProxyHosts: [...this.trustedProxyHosts],
        allowPrivateLan: this.allowPrivateLan,
        allowLoopback: this.allowLoopback,
        allowForwardedHeaders: this.allowForwardedHeaders
      },
      blockedBy: blockedCheck ?? null,
      checks
    };
  }

  proxyPolicy({ proxyHeaderPresent, remoteHost, forwardedProto }) {
    if (!proxyHeaderPresent) return { allowed: true, reason: 'no-forwarded-headers' };
    if (!this.allowForwardedHeaders) return { allowed: false, reason: 'forwarded-headers-disabled' };
    const proto = String(forwardedProto ?? '').split(',')[0].trim().toLowerCase();
    if (proto && !['http', 'https'].includes(proto)) return { allowed: false, reason: 'unsupported-forwarded-proto' };
    if (!remoteHost) return { allowed: true, reason: 'forwarded-headers-without-remote-address' };
    const remoteAllowed = classifyHost(remoteHost, 'remote-address', {
      allowedHostnames: this.allowedHostnames,
      trustedProxyHosts: this.trustedProxyHosts,
      allowPrivateLan: this.allowPrivateLan,
      allowLoopback: this.allowLoopback
    });
    const trustedByList = this.trustedProxyHosts.has(remoteHost);
    return {
      allowed: remoteAllowed.allowed || trustedByList,
      reason: remoteAllowed.allowed ? 'trusted-local-or-private-proxy' : (trustedByList ? 'trusted-proxy-allowlist' : 'untrusted-forwarded-proxy'),
      trustedByList
    };
  }

  runDnsRebindingDrill(options = {}) {
    return runDnsRebindingResolverDrill({ ...options, guard: this });
  }

  mdnsAllowlistUx(options = {}) {
    return createMdnsDiscoveryAllowlistUx({
      ...options,
      allowedHostnames: options.allowedHostnames ?? [...this.allowedHostnames]
    });
  }

  reverseProxyDeploymentGuide(options = {}) {
    return createBridgeReverseProxyDeploymentGuide({
      ...options,
      allowedHostnames: options.allowedHostnames ?? [...this.allowedHostnames],
      trustedProxyHosts: options.trustedProxyHosts ?? [...this.trustedProxyHosts],
      allowForwardedHeaders: this.allowForwardedHeaders
    });
  }
}

export async function runDnsRebindingResolverDrill({
  hostname = 'jarvis.local',
  resolver = defaultDnsResolver,
  guard = new LocalNetworkGuard(),
  samples = 2,
  remoteAddress = '127.0.0.1',
  clock = () => new Date()
} = {}) {
  const normalizedHostname = normalizeHost(hostname);
  const sampleItems = [];
  for (let index = 0; index < samples; index += 1) {
    let addresses = [];
    let error = null;
    try {
      addresses = normalizeResolverAddresses(await resolver(normalizedHostname, { sampleIndex: index, hostname: normalizedHostname }));
    } catch (caught) {
      error = caught;
    }
    sampleItems.push({
      sampleIndex: index,
      hostname: normalizedHostname,
      addresses,
      addressClasses: addresses.map((address) => classifyHost(normalizeHost(address), 'dns-answer')),
      errorCode: error ? 'D_DNS_RESOLVER_FAILED' : null,
      errorMessage: error ? String(error.message ?? error).slice(0, 160) : null
    });
  }
  const publicAddresses = sampleItems.flatMap((sample) => sample.addressClasses.filter((item) => item.reason === 'public-ipv4' || item.reason === 'public-ipv6'));
  const localAddresses = sampleItems.flatMap((sample) => sample.addressClasses.filter((item) => item.allowed === true));
  const localCandidate = localAddresses[0]?.host ?? remoteAddress;
  const hostnameGuard = guard.evaluate({ hostHeader: normalizedHostname, remoteAddress: localCandidate });
  const rebindingDetected = publicAddresses.length > 0 && localAddresses.length > 0;
  const passed = rebindingDetected && hostnameGuard.allowed === false && hostnameGuard.dnsRebindingSuspected === true;
  return {
    reportVersion: 'd-dns-rebinding-resolver-drill-v1',
    generatedAt: clock().toISOString(),
    status: passed ? 'passed' : 'needs-review',
    hostname: normalizedHostname,
    resolverMode: resolver === defaultDnsResolver ? 'system-dns-resolver' : 'injected-resolver',
    sampleCount: sampleItems.length,
    rebindingDetected,
    publicAddressCount: publicAddresses.length,
    localAddressCount: localAddresses.length,
    guardDecision: {
      allowed: hostnameGuard.allowed,
      dnsRebindingSuspected: hostnameGuard.dnsRebindingSuspected,
      blockedBy: hostnameGuard.blockedBy
    },
    checks: [
      { id: 'resolver-returned-public-and-local-addresses', passed: rebindingDetected },
      { id: 'guard-blocked-hostname-rebinding', passed: hostnameGuard.allowed === false },
      { id: 'guard-marked-dns-rebinding-suspected', passed: hostnameGuard.dnsRebindingSuspected === true }
    ],
    samples: sampleItems
  };
}

export function createMdnsDiscoveryAllowlistUx({
  services = [],
  allowedHostnames = [],
  selectedHostnames = [],
  clock = () => new Date()
} = {}) {
  const allowedSet = new Set(allowedHostnames.map(normalizeHost).filter(Boolean));
  const selectedSet = new Set(selectedHostnames.map(normalizeHost).filter(Boolean));
  const serviceCards = services.map((service, index) => {
    const hostname = normalizeHost(service.hostname ?? service.host ?? service.name ?? '');
    const selected = selectedSet.has(hostname);
    const alreadyAllowed = allowedSet.has(hostname);
    return {
      cardVersion: 'd-mdns-discovery-allowlist-card-v1',
      serviceId: service.serviceId ?? `mdns_service_${index + 1}`,
      displayName: service.displayName ?? service.name ?? hostname,
      serviceType: service.serviceType ?? service.type ?? '_jarvis._tcp.local',
      hostname,
      port: Number.isInteger(service.port) ? service.port : 17777,
      addresses: normalizeResolverAddresses(service.addresses ?? service.address ?? []),
      state: alreadyAllowed ? 'already-allowed' : (selected ? 'selected-for-allowlist' : 'review-required'),
      suggestedAllowlistEntry: hostname,
      actions: alreadyAllowed
        ? ['keep-allowlisted', 'remove-from-allowlist']
        : ['allow-this-bridge', 'reject-service'],
      riskHint: hostname.endsWith('.local') ? 'mdns-local-service' : 'non-mdns-hostname',
      rawSecretStored: false
    };
  });
  const proposedAllowlist = [
    ...allowedSet,
    ...serviceCards.filter((card) => card.state === 'selected-for-allowlist').map((card) => card.hostname)
  ].filter(Boolean);
  return {
    uxVersion: 'd-mdns-discovery-allowlist-ux-v1',
    generatedAt: clock().toISOString(),
    state: serviceCards.some((card) => card.state === 'review-required') ? 'review-required' : 'ready',
    serviceCount: serviceCards.length,
    selectedCount: serviceCards.filter((card) => card.state === 'selected-for-allowlist').length,
    proposedAllowlist: [...new Set(proposedAllowlist)],
    envPatchPreview: {
      variable: 'JARVIS_BRIDGE_ALLOWED_HOSTS',
      valuePreview: [...new Set(proposedAllowlist)].join(',')
    },
    cards: serviceCards
  };
}

export function createBridgeReverseProxyDeploymentGuide({
  publicHostname = 'jarvis.local',
  upstreamHost = '127.0.0.1',
  upstreamPort = 17777,
  allowedHostnames = ['jarvis.local'],
  trustedProxyHosts = ['127.0.0.1'],
  allowForwardedHeaders = true
} = {}) {
  const normalizedPublicHostname = normalizeHost(publicHostname);
  const normalizedAllowed = [...new Set(allowedHostnames.map(normalizeHost).filter(Boolean))];
  const normalizedTrustedProxies = [...new Set(trustedProxyHosts.map(normalizeHost).filter(Boolean))];
  return {
    guideVersion: 'd-bridge-reverse-proxy-deployment-guide-v1',
    topology: 'tls-terminated-reverse-proxy',
    publicHostname: normalizedPublicHostname,
    upstream: `http://${upstreamHost}:${upstreamPort}`,
    requiredNetworkGuardEnv: {
      JARVIS_BRIDGE_ALLOWED_HOSTS: normalizedAllowed.includes(normalizedPublicHostname)
        ? normalizedAllowed.join(',')
        : [...normalizedAllowed, normalizedPublicHostname].filter(Boolean).join(','),
      JARVIS_BRIDGE_TRUSTED_PROXY_HOSTS: normalizedTrustedProxies.join(','),
      JARVIS_BRIDGE_ALLOW_FORWARDED_HEADERS: allowForwardedHeaders ? 'true' : 'false'
    },
    caddy: [
      `${normalizedPublicHostname} {`,
      '  tls internal',
      `  reverse_proxy ${upstreamHost}:${upstreamPort} {`,
      '    header_up Host {host}',
      '    header_up X-Forwarded-For {remote_host}',
      '    header_up X-Forwarded-Proto {scheme}',
      '  }',
      '}'
    ].join('\n'),
    nginx: [
      `server_name ${normalizedPublicHostname};`,
      'location / {',
      `  proxy_pass http://${upstreamHost}:${upstreamPort};`,
      '  proxy_set_header Host $host;',
      '  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
      '  proxy_set_header X-Forwarded-Proto $scheme;',
      '  proxy_http_version 1.1;',
      '  proxy_set_header Upgrade $http_upgrade;',
      '  proxy_set_header Connection "upgrade";',
      '}'
    ].join('\n'),
    validation: [
      { id: 'health-through-proxy', command: `curl -fsS https://${normalizedPublicHostname}/health` },
      { id: 'openapi-through-proxy', command: `curl -fsS https://${normalizedPublicHostname}/openapi.json` },
      { id: 'bridge-soak-through-proxy', command: 'npm run bridge:server-soak' }
    ],
    securityNotes: [
      'Terminate TLS at the local reverse proxy and keep the Node bridge on a loopback or private LAN upstream.',
      'Only trust forwarded headers from configured proxy hosts.',
      'Keep unknown mDNS hostnames in review-required state until the user explicitly allowlists them.'
    ]
  };
}

export function normalizeHost(value) {
  if (!value) return '';
  let host = String(value).trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    host = end >= 0 ? host.slice(1, end) : host.slice(1);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    host = host.split(':')[0];
  }
  if (host.startsWith('::ffff:')) host = host.slice('::ffff:'.length);
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isLocalOrPrivateHost(host) {
  return classifyHost(normalizeHost(host), 'host').allowed;
}

async function defaultDnsResolver(hostname) {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
}

function normalizeResolverAddresses(value) {
  if (Array.isArray(value)) return value.flatMap(normalizeResolverAddresses);
  if (value && typeof value === 'object') {
    if (Array.isArray(value.addresses)) return normalizeResolverAddresses(value.addresses);
    if (value.address) return normalizeResolverAddresses(value.address);
    if (value.host) return normalizeResolverAddresses(value.host);
  }
  const host = normalizeHost(value);
  return host ? [host] : [];
}

function classifyHost(host, source, {
  allowedHostnames = new Set(),
  allowPrivateLan = true,
  allowLoopback = true,
  remoteAddress = null
} = {}) {
  if (!host) return blocked(source, host, 'empty-host');
  if (allowedHostnames.has(host)) return allowed(source, host, 'configured-host-allowlist');
  if (host === 'localhost') {
    return allowLoopback ? allowed(source, host, 'localhost') : blocked(source, host, 'loopback-disabled');
  }
  const ipVersion = isIP(host);
  if (ipVersion === 4) {
    const octets = host.split('.').map(Number);
    const [a, b] = octets;
    if (a === 127) return allowLoopback ? allowed(source, host, 'loopback-127/8') : blocked(source, host, 'loopback-disabled');
    if (a === 10) return allowPrivateLan ? allowed(source, host, 'private-10/8') : blocked(source, host, 'private-lan-disabled');
    if (a === 192 && b === 168) return allowPrivateLan ? allowed(source, host, 'private-192.168/16') : blocked(source, host, 'private-lan-disabled');
    if (a === 172 && b >= 16 && b <= 31) return allowPrivateLan ? allowed(source, host, 'private-172.16/12') : blocked(source, host, 'private-lan-disabled');
    if (a === 169 && b === 254) return allowPrivateLan ? allowed(source, host, 'link-local-169.254/16') : blocked(source, host, 'private-lan-disabled');
    return blocked(source, host, 'public-ipv4');
  }
  if (ipVersion === 6) {
    if (host === '::1') return allowLoopback ? allowed(source, host, 'loopback-ipv6') : blocked(source, host, 'loopback-disabled');
    if (host.startsWith('fc') || host.startsWith('fd')) return allowPrivateLan ? allowed(source, host, 'unique-local-ipv6') : blocked(source, host, 'private-lan-disabled');
    if (/^fe[89ab]/.test(host)) return allowPrivateLan ? allowed(source, host, 'link-local-ipv6') : blocked(source, host, 'private-lan-disabled');
    return blocked(source, host, 'public-ipv6');
  }
  const remote = remoteAddress ? classifyHost(remoteAddress, 'remote-address-for-hostname', {
    allowedHostnames,
    allowPrivateLan,
    allowLoopback
  }) : null;
  return blocked(source, host, remote?.allowed ? 'dns-rebinding-hostname' : 'hostname-not-local');
}

function allowed(source, host, reason) {
  return { source, host, allowed: true, reason };
}

function blocked(source, host, reason) {
  return { source, host, allowed: false, reason };
}
