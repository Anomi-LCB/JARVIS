import { createHash } from 'node:crypto';
const labels = Object.freeze({ fact: '사실로 제출한 주장', 'scholarly-view': '학계 견해', inference: '추론', application: '설교·생활 적용' });
const fail = () => { throw new Error('A_THEOLOGY_REVIEW_INPUT_INVALID'); };
const text = (value, max = 12000) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(value);
const shape = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => keys.includes(key));
const escape = value => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/[\\`*_{}\[\]()#!|]/gu, '\\$&').replace(/[\r\n]+/gu, ' ');

/** Reviews submitted evidence linkage. It does not decide doctrine, truth or scholarly consensus. */
export function reviewTheologyResearch(input) {
  if (!shape(input, ['sources', 'passages', 'claims']) || !Array.isArray(input.sources) || input.sources.length > 40
    || !Array.isArray(input.passages) || input.passages.length > 40 || !Array.isArray(input.claims)
    || !input.claims.length || input.claims.length > 100 || Buffer.byteLength(JSON.stringify(input)) > 512 * 1024) fail();
  const sources = new Map(), passages = new Map(), claims = new Map();
  for (const source of input.sources) {
    if (!shape(source, ['id', 'title', 'author', 'locator', 'text']) || !id(source.id) || sources.has(source.id)
      || !text(source.title, 500) || !text(source.author, 500) || !text(source.locator, 1000) || !text(source.text, 50000)) fail();
    sources.set(source.id, source);
  }
  for (const passage of input.passages) {
    if (!shape(passage, ['id', 'reference', 'version', 'text']) || !id(passage.id) || passages.has(passage.id)
      || !text(passage.reference, 300) || !text(passage.version, 300) || !text(passage.text, 20000)) fail();
    passages.set(passage.id, passage);
  }
  for (const claim of input.claims) {
    if (!shape(claim, ['id', 'category', 'statement', 'sourceRefs', 'passageRefs', 'premiseIds', 'perspective', 'distribution'])
      || !id(claim.id) || claims.has(claim.id) || !Object.hasOwn(labels, claim.category) || !text(claim.statement)
      || !Array.isArray(claim.sourceRefs) || claim.sourceRefs.length > 20 || !Array.isArray(claim.passageRefs) || claim.passageRefs.length > 20
      || !Array.isArray(claim.premiseIds) || claim.premiseIds.length > 20 || claim.premiseIds.some(value => !id(value))
      || new Set(claim.premiseIds).size !== claim.premiseIds.length
      || (claim.perspective !== undefined && !text(claim.perspective, 500))
      || (claim.distribution !== undefined && !['majority', 'minority', 'disputed', 'unspecified'].includes(claim.distribution))) fail();
    for (const [refs, key] of [[claim.sourceRefs, 'sourceId'], [claim.passageRefs, 'passageId']]) {
      for (const ref of refs) if (!shape(ref, [key, 'quote']) || !id(ref[key]) || !text(ref.quote, 8000)) fail();
    }
    claims.set(claim.id, claim);
  }
  // Walk once per node with three colors, avoiding exponential traversal of shared premises.
  const colors = new Map(), cycleMembers = new Set();
  const visit = (claimId, stack = []) => {
    if (colors.get(claimId) === 2 || !claims.has(claimId)) return;
    if (colors.get(claimId) === 1) { for (const member of stack.slice(stack.indexOf(claimId))) cycleMembers.add(member); return; }
    colors.set(claimId, 1); for (const dependency of claims.get(claimId).premiseIds) visit(dependency, [...stack, claimId]); colors.set(claimId, 2);
  };
  for (const claimId of claims.keys()) visit(claimId);
  const reviewed = input.claims.map(claim => {
    const issues = [], citations = [];
    for (const [refs, collection, key, kind] of [[claim.sourceRefs, sources, 'sourceId', 'source'], [claim.passageRefs, passages, 'passageId', 'passage']]) {
      for (const ref of refs) {
        const source = collection.get(ref[key]), matched = !!source?.text.includes(ref.quote);
        if (!matched) issues.push(`${kind}-quote-unmatched`);
        citations.push({ kind, id: ref[key], quote: ref.quote, quoteMatched: matched,
          provenance: 'caller-provided', sourceAuthenticity: 'not-evaluated', semanticEntailment: 'not-evaluated',
          ...(source ? { textSha256: createHash('sha256').update(source.text).digest('hex') } : {}) });
      }
    }
    if (!citations.length) issues.push('evidence-missing');
    if (claim.category === 'scholarly-view' && (!claim.sourceRefs.length || !claim.perspective)) issues.push('scholarly-attribution-missing');
    if (['inference', 'application'].includes(claim.category) && !claim.premiseIds.length) issues.push('premises-missing');
    if (claim.category === 'application' && !claim.passageRefs.length) issues.push('application-passage-basis-missing');
    if (claim.premiseIds.some(value => !claims.has(value))) issues.push('premise-not-found');
    if (cycleMembers.has(claim.id)) issues.push('circular-premises');
    return { id: claim.id, category: claim.category, label: labels[claim.category], statement: claim.statement,
      premiseIds: [...claim.premiseIds], perspective: claim.perspective ?? null, submittedDistribution: claim.distribution ?? 'unspecified',
      consensusVerified: false, citations, issues, evidenceLinksMatched: issues.length === 0,
      truthVerified: false, interpretationVerified: false, requiresExpertReview: true };
  });
  const byId = new Map(reviewed.map(claim => [claim.id, claim]));
  for (let pass = 0; pass < reviewed.length; pass++) {
    let changed = false;
    for (const claim of reviewed) if (claim.premiseIds.some(value => byId.get(value)?.evidenceLinksMatched === false)
      && !claim.issues.includes('premise-evidence-unresolved')) {
      claim.issues.push('premise-evidence-unresolved'); claim.evidenceLinksMatched = false; changed = true;
    }
    if (!changed) break;
  }
  const report = ['# 신학 연구 근거 검토', '', '분류는 제출자의 구분입니다. 인용 일치는 사실·해석·학계 다수설의 입증이 아닙니다.',
    '출처 진위와 주장에 대한 근거의 충분성은 전문가 검토가 필요합니다.',
    '', '## 제출한 문헌', ...input.sources.map(source => `${escape(source.id)}: ${escape(source.author)} · ${escape(source.title)} · ${escape(source.locator)}`),
    '', '## 제출한 성경 본문', ...input.passages.map(passage => `${escape(passage.id)}: ${escape(passage.reference)} · ${escape(passage.version)}`),
    ...Object.entries(labels).flatMap(([category, label]) => ['', `## ${label}`, ...reviewed.filter(claim => claim.category === category).flatMap(claim => [
      '', `### ${escape(claim.id)}`, escape(claim.statement), `근거 연결: ${claim.evidenceLinksMatched ? '문자열·참조 일치' : '보완 필요'}`,
      `미해결: ${claim.issues.join(', ') || '출처 진위·의미·해석 검토'}`, `전제: ${claim.premiseIds.join(', ') || '없음'}`,
      ...(claim.perspective ? [`견해: ${escape(claim.perspective)}`] : []), `학계 분포: ${claim.submittedDistribution} (미검증)`,
      ...claim.citations.map(citation => `${citation.kind === 'source' ? '문헌' : '성경 본문'} ${escape(citation.id)}: ${escape(citation.quote)} (${citation.quoteMatched ? '일치' : '불일치'})`)
    ])])].join('\n') + '\n';
  return { schemaVersion: 'jarvis-theology-review-v1', claims: reviewed, report,
    evidenceLinksMatched: reviewed.every(claim => claim.evidenceLinksMatched), completionEligible: false,
    semanticEntailment: 'not-evaluated', sourceAuthenticity: 'not-evaluated', executionAuthority: false,
    nextAction: '보완 항목을 수정하고 출처 진위·문맥·경쟁 해석·개혁주의 신학 정합성을 전문가와 검토하세요.' };
}
