import { resolve } from 'node:path';

const cleanId = value => typeof value === 'string' && value.trim() ? value.trim() : null;
export function workReferenceScope({ workspaceRoot = './workspace', metadata = {}, userId = 'local_user' } = {}) {
  return { workspaceId: resolve(workspaceRoot), conversationId: cleanId(metadata.conversationId), userId: cleanId(userId) ?? 'local_user' };
}

export function resolveWorkReferenceContext(workMemory, rawText, { scope, mission = false } = {}) {
  if (typeof workMemory?.resolveArtifactReference !== 'function') {
    const hit = workMemory?.rewriteWithReference?.(rawText, { scope });
    return hit ? { status: 'resolved', ...hit } : { status: 'not_reference' };
  }
  const result = workMemory.resolveArtifactReference(rawText, { scope });
  if (!result || result.status === 'not_reference') return { status: 'not_reference' };
  if (result.status !== 'resolved') {
    const names = (result.candidates ?? []).slice(0, 4).map(candidate => candidate.path ?? candidate.artifact?.path).filter(Boolean);
    const messages = {
      ambiguous: `이 대화에서 가리킬 수 있는 파일이 여러 개입니다. 파일 이름이나 순서를 알려주세요.${names.length ? ` 후보: ${names.join(', ')}` : ''}`,
      stale: '기억한 뒤 파일 내용이 바뀌었습니다. 현재 파일을 사용할지 파일 경로로 지정해주세요.',
      not_found: '이 대화에서 해당 파일을 찾을 수 없습니다. 사용할 파일 이름이나 경로를 알려주세요.',
      unverified: '파일의 현재 버전을 확인할 수 없습니다. 사용할 파일 경로를 지정해주세요.'
    };
    return { status: result.status, issue: { code: `A_WORK_REFERENCE_${String(result.status).toUpperCase()}`,
      status: result.status, message: messages[result.status] ?? '파일 참조를 확인할 수 없습니다.', candidates: names } };
  }
  let rewritten = result.rewritten;
  if (result.path) {
    const phrase = result.matchedPhrase;
    const index = typeof phrase === 'string' && phrase.length ? String(rawText).indexOf(phrase) : -1;
    if (index < 0) return { status: 'unverified', issue: { code: 'A_WORK_REFERENCE_UNVERIFIED', status: 'unverified', message: '파일 참조 위치를 확인할 수 없습니다.' } };
    let start = index, end = index + phrase.length;
    const before = String(rawText)[start - 1], after = String(rawText)[end];
    if ((before === "'" || before === '"') && after === before) { start -= 1; end += 1; }
    rewritten = String(rawText).slice(0, start) + JSON.stringify(result.path.replaceAll('\\', '/')) + String(rawText).slice(end);
  }
  if (!rewritten) rewritten = workMemory.rewriteWithReference(rawText, { scope, resolution: result })?.rewritten;
  return { ...result, rewritten, scope, binding: { artifactId: result.artifactId ?? result.artifact?.artifactId,
    path: result.path, sha256: result.artifact?.sha256, size: result.artifact?.size, version: result.artifact?.version } };
}

export function cleanWorkReferenceMetadata(metadata = {}) {
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !key.startsWith('workReference')));
}

export function resolveMissionWorkReference(coreFacade, objective, metadata = {}) {
  const cleanMetadata = cleanWorkReferenceMetadata(metadata);
  const scope = coreFacade.workReferenceScope?.({ metadata: cleanMetadata, userId: metadata.userId ?? 'local_user' })
    ?? workReferenceScope({ metadata: cleanMetadata });
  const resolution = resolveWorkReferenceContext(coreFacade.workMemory, objective, { scope, mission: true });
  const result = { objective, metadata: { ...cleanMetadata, workReferenceScope: scope }, resolution };
  if (resolution.status === 'resolved') {
    result.objective = resolution.rewritten;
    Object.assign(result.metadata, { workReference: resolution.binding, workReferenceOriginalText: objective, workReferenceResolved: true });
  }
  return result;
}
