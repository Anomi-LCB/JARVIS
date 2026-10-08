const DIRECTIONS = new Set(['provider-calls-jarvis', 'jarvis-calls-provider']);
const REGION = /^[A-Z]{2}$/u;
const references = new Set(['gemini-spark-custom-apps']);

const offers = Object.freeze({
  'gemini-spark-custom-apps': Object.freeze({
    id: 'gemini-spark-custom-apps',
    provider: 'Google Gemini Spark',
    feature: '사용자 지정 MCP 앱 연결',
    direction: 'provider-calls-jarvis',
    inverseDirection: 'jarvis-calls-provider',
    regions: ['US'],
    languages: ['en'],
    accountTypes: ['personal'],
    requirements: ['age18OrOlder', 'sparkAccess', 'keepActivityEnabled', 'mcpServerUrlAvailable'],
    source: 'https://support.google.com/gemini/answer/17209137',
    checkedAt: '2026-09-29'
  })
});

const clones = value => structuredClone(value);

/** Read-only catalog. Results describe eligibility and prepared code only;
 * Mission policy remains the authority for any later execution. */
export class ExternalCapabilityCatalog {
  evaluate(input = {}, { activeToolNames = [] } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['offerId', 'region', 'language', 'accountType', 'direction', 'requirements'].includes(key))
      || !references.has(input.offerId)
      || (input.region !== undefined && (typeof input.region !== 'string' || !REGION.test(input.region)))
      || (input.language !== undefined && typeof input.language !== 'string')
      || (input.accountType !== undefined && typeof input.accountType !== 'string')
      || (input.direction !== undefined && !DIRECTIONS.has(input.direction))
      || (input.requirements !== undefined && (!input.requirements || typeof input.requirements !== 'object' || Array.isArray(input.requirements)
        || Object.keys(input.requirements).some(key => !offers[input.offerId].requirements.includes(key))
        || Object.values(input.requirements).some(value => typeof value !== 'boolean')))
      || !Array.isArray(activeToolNames) || activeToolNames.some(name => typeof name !== 'string')) {
      const error = new Error('A_EXTERNAL_CAPABILITY_INPUT_INVALID'); error.code = error.message; throw error;
    }
    const offer = offers[input.offerId];
    const region = input.region ?? null;
    const language = input.language?.trim().toLowerCase().split(/[-_]/u)[0] ?? null;
    const regionAllowed = region === null ? null : offer.regions.includes(region);
    const languageAllowed = language === null ? null : offer.languages.includes(language);
    const accountAllowed = input.accountType === undefined ? null : offer.accountTypes.includes(input.accountType);
    const missingRequirements = offer.requirements.filter(key => input.requirements?.[key] === undefined);
    const unmetRequirements = offer.requirements.filter(key => input.requirements?.[key] === false);
    const unsupportedReasons = [
      ...(regionAllowed === false ? ['region-not-supported'] : []),
      ...(languageAllowed === false ? ['language-not-supported'] : []),
      ...(accountAllowed === false ? ['account-type-not-supported'] : [])
    ];
    const unknownConditions = [regionAllowed, languageAllowed, accountAllowed].filter(value => value === null).length;
    const eligible = unsupportedReasons.length === 0 && unknownConditions === 0
      && missingRequirements.length === 0 && unmetRequirements.length === 0;
    const directionMismatch = input.direction !== undefined && input.direction !== offer.direction;
    const prepared = activeToolNames.includes('workflow.execute');
    return {
      catalogVersion: 'jarvis-external-capability-catalog-v1',
      offer: { id: offer.id, provider: offer.provider, feature: offer.feature,
        direction: offer.direction, requestedDirection: input.direction ?? null,
        directionMismatch, source: offer.source, checkedAt: offer.checkedAt },
      providerAvailability: eligible ? 'eligible' : unsupportedReasons.length ? 'unavailable'
        : unknownConditions || missingRequirements.length ? 'unknown' : 'requirements-missing',
      region: { requested: region, supported: regionAllowed },
      language: { requested: input.language ?? null, supported: languageAllowed },
      accountType: { requested: input.accountType ?? null, supported: accountAllowed },
      unsupportedReasons,
      missingRequirements,
      unmetRequirements,
      alternatives: prepared ? [{ id: 'jarvis-local-workflow', toolName: 'workflow.execute',
        readiness: 'code-registered-in-current-core', relation: 'partial-assistance',
        description: 'JARVIS의 로컬 Mission 초안·검증 경로를 사용할 수 있습니다. 외부 MCP 앱 연결과 동등한 기능이라고 보장하지 않습니다.' }] : [],
      alternativeReadiness: prepared ? 'local-code-registered' : 'no-prepared-local-alternative',
      executionAuthorized: false,
      requiresPolicyCheck: true,
      externalCallPerformed: false
    };
  }

  definition(offerId) {
    if (!references.has(offerId)) return null;
    return clones(offers[offerId]);
  }
}

export const externalCapabilityCatalog = new ExternalCapabilityCatalog();
