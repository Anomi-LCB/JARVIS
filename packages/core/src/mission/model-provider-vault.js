const modelProviderConnections = Object.freeze({
  xai: { connectorId: 'jarvis-model-xai', displayName: 'xAI 모델 계획', scope: 'model.plan', service: 'xai-api' },
  meta: { connectorId: 'jarvis-model-meta', displayName: 'Meta 모델 계획', scope: 'model.plan', service: 'meta-model-api' },
  gemini: { connectorId: 'jarvis-model-gemini', displayName: 'Gemini 모델 계획', scope: 'model.plan', service: 'google-gemini-api' },
  'gemini-interactions': { connectorId: 'jarvis-model-gemini', displayName: 'Gemini Interactions 모델 계획', scope: 'model.plan', service: 'google-gemini-interactions-api' }
});

const openAiAgentsConnector = Object.freeze({
  connectorId: 'jarvis-openai-agents',
  displayName: 'OpenAI Agents API 세션',
  operations: Object.freeze({
    'provider.verify': { scope: 'agents.provider.verify', capabilityId: 'agents-provider-verify', riskTier: 'read' },
    'session.create': { scope: 'agents.session.create', capabilityId: 'agents-session-create', riskTier: 'external-action' },
    'session.read': { scope: 'agents.session.read', capabilityId: 'agents-session-read', riskTier: 'read' },
    'session.message': { scope: 'agents.session.message', capabilityId: 'agents-session-message', riskTier: 'external-action' },
    'session.tool-result': { scope: 'agents.session.tool-result', capabilityId: 'agents-session-tool-result', riskTier: 'external-action' },
    'session.cancel': { scope: 'agents.session.cancel', capabilityId: 'agents-session-cancel', riskTier: 'external-action' }
  })
});

/** Registers the managed session credential separately from model-plan keys. */
export function registerOpenAiAgentsConnector(registry) {
  if (!registry?.register || !registry?.get) throw new TypeError('A trusted integration connector registry is required.');
  const operations = Object.values(openAiAgentsConnector.operations);
  const declaration = { id: openAiAgentsConnector.connectorId, displayName: openAiAgentsConnector.displayName,
    category: 'agent-provider', authMethods: ['api-key'], scopes: operations.map(item => item.scope),
    credentialFields: ['apiKey'], requiredCredentialFields: ['apiKey'],
    capabilities: operations.map(item => ({ id: item.capabilityId, riskTier: item.riskTier, scopes: [item.scope] })) };
  const existing = registry.get(openAiAgentsConnector.connectorId);
  if (!existing) registry.register(declaration);
  else {
    const normalize = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
    const expectedScopes = [...declaration.scopes].sort();
    const actualScopes = [...(existing.scopes ?? [])].sort();
    const expectedCapabilities = declaration.capabilities.map(({ id, riskTier, scopes }) => ({ id, riskTier, scopes: [...scopes].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const actualCapabilities = (existing.capabilities ?? []).map(({ id, riskTier, scopes = [] }) => ({ id, riskTier, scopes: [...scopes].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id));
    if (existing.category !== declaration.category || !existing.authMethods?.includes('api-key')
      || normalize(actualScopes) !== normalize(expectedScopes)
      || normalize(actualCapabilities) !== normalize(expectedCapabilities)
      || normalize([...(existing.credentialFields ?? [])].sort()) !== normalize(declaration.credentialFields)
      || normalize([...(existing.requiredCredentialFields ?? [])].sort()) !== normalize(declaration.requiredCredentialFields)) {
      throw credentialError('A_OPENAI_AGENTS_CONNECTOR_CONTRACT_CONFLICT');
    }
  }
  return registry;
}

/** Resolves the API key from the protected vault for one precisely scoped request. */
export function createVaultOpenAiAgentsCredentialAccess({ registry, vault } = {}) {
  if (!registry?.get || typeof registry.authorize !== 'function' || !vault?.list || !vault?.withCredentials) {
    throw new TypeError('A connector registry and credential vault are required.');
  }
  registerOpenAiAgentsConnector(registry);
  const operationFor = operation => {
    const value = openAiAgentsConnector.operations[operation];
    if (!value) throw credentialError('A_OPENAI_AGENTS_OPERATION_UNSUPPORTED');
    return value;
  };
  const connectionFor = requiredScope => {
    const eligible = vault.list().filter(connection => connection.connectorId === openAiAgentsConnector.connectorId
      && ['credentials-stored-unverified', 'credentials-stored-provider-verified'].includes(connection.status)
      && connection.authMethod === 'api-key' && connection.scopes.includes(requiredScope));
    return eligible.length === 1 ? eligible[0] : null;
  };
  return Object.freeze({
    async resolve(operation) {
      const requirement = operationFor(operation);
      const connection = connectionFor(requirement.scope);
      if (!connection) throw credentialError('A_OPENAI_AGENTS_CREDENTIAL_REQUIRED');
      const authorized = registry.authorize({ connectorId: openAiAgentsConnector.connectorId,
        grantedScopes: connection.scopes, capabilityId: requirement.capabilityId,
        providerAuthorized: true, jarvisAuthorized: true });
      if (!authorized.allowed || authorized.riskTier !== requirement.riskTier) {
        throw credentialError('A_OPENAI_AGENTS_CREDENTIAL_SCOPE_DENIED');
      }
      return vault.withCredentials(connection.connectionId, (credentials, metadata) => {
        if (metadata.connectorId !== openAiAgentsConnector.connectorId || !metadata.scopes.includes(requirement.scope)
          || typeof credentials.apiKey !== 'string' || !credentials.apiKey.trim()) {
          throw credentialError('A_OPENAI_AGENTS_CREDENTIAL_SCOPE_DENIED');
        }
        return credentials.apiKey;
      });
    },
    isConfigured(operation) {
      const requirement = operationFor(operation);
      return Boolean(connectionFor(requirement.scope));
    },
    status() {
      return Object.fromEntries(Object.keys(openAiAgentsConnector.operations).map(operation => [operation, this.isConfigured(operation)]));
    }
  });
}

/** Registers only fixed, bundled declarations. No user supplied executable adapters are loaded. */
export function registerModelProviderConnectors(registry) {
  if (!registry?.register || !registry?.get) throw new TypeError('A trusted integration connector registry is required.');
  for (const item of new Map(Object.values(modelProviderConnections).map(item => [item.connectorId, item])).values()) {
    if (registry.get(item.connectorId)) continue;
    registry.register({ id: item.connectorId, displayName: item.displayName, category: 'model-provider',
      authMethods: ['api-key'], scopes: [item.scope], credentialFields: ['apiKey'], requiredCredentialFields: ['apiKey'],
      capabilities: [{ id: 'mission-plan', riskTier: 'read', scopes: [item.scope] }] });
  }
  return registry;
}

/**
 * Resolves one provider key inside the vault callback, immediately before a model request.
 * The resolver fails closed for absent, expired, ambiguous, or wrongly scoped entries.
 */
export function createVaultModelCredentialAccess({ registry, vault } = {}) {
  if (!registry?.get || !vault?.list || !vault?.withCredentials) throw new TypeError('A connector registry and credential vault are required.');
  registerModelProviderConnectors(registry);
  const connectionFor = provider => {
    const declaration = modelProviderConnections[provider];
    if (!declaration) return null;
    const eligible = vault.list().filter(connection => connection.connectorId === declaration.connectorId
      && ['credentials-stored-unverified', 'credentials-stored-provider-verified'].includes(connection.status)
      && connection.authMethod === 'api-key'
      && connection.scopes.includes(declaration.scope));
    return eligible.length === 1 ? eligible[0] : null;
  };
  return Object.freeze({
    async resolve(provider) {
      const declaration = modelProviderConnections[provider];
      if (!declaration) throw credentialError('A_MODEL_PROVIDER_UNSUPPORTED');
      const connection = connectionFor(provider);
      if (!connection) throw credentialError('A_MODEL_CREDENTIAL_REQUIRED');
      const allowed = registry.authorize({ connectorId: declaration.connectorId, grantedScopes: connection.scopes,
        capabilityId: 'mission-plan', providerAuthorized: true, jarvisAuthorized: true });
      if (!allowed.allowed || allowed.riskTier !== 'read') throw credentialError('A_MODEL_CREDENTIAL_SCOPE_DENIED');
      return vault.withCredentials(connection.connectionId, (credentials, metadata) => {
        if (metadata.connectorId !== declaration.connectorId || !metadata.scopes.includes(declaration.scope)
          || typeof credentials.apiKey !== 'string') throw credentialError('A_MODEL_CREDENTIAL_SCOPE_DENIED');
        return credentials.apiKey;
      });
    },
    isConfigured(provider) { return Boolean(connectionFor(provider)); },
    status() {
      return Object.fromEntries(Object.keys(modelProviderConnections).map(provider => [provider, this.isConfigured(provider)]));
    }
  });
}

function credentialError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
