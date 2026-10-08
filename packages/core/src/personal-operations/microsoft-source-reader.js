import { createHash } from 'node:crypto';

export const microsoftSourceContracts = Object.freeze({
  outlook: { connectorId: 'jarvis-outlook-read', scope: 'Mail.ReadBasic', accountTypes: ['work-school', 'personal'],
    capabilityId: 'outlook-message-metadata-read' },
  'teams-chat': { connectorId: 'jarvis-teams-chat-read', scope: 'Chat.Read', accountTypes: ['work-school'],
    capabilityId: 'teams-selected-chat-metadata-read' }
});
const fail = code => { throw new Error(code); };
function assertReadAuthorization(authorize) {
  if (authorize === undefined) return;
  let decision;
  try { decision = typeof authorize === 'function' ? authorize() : false; }
  catch { fail('A_MICROSOFT_AUTHORIZATION_DENIED'); }
  // This trusted policy hook is synchronous. Never treat a pending decision as permission.
  if (decision instanceof Promise) decision.catch(() => {});
  if (decision !== true) fail('A_MICROSOFT_AUTHORIZATION_DENIED');
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['tenantId', 'clientId', 'clientSecret', 'refreshToken'];
const live = record => record && !['expired', 'revoked', 'removed', 'disconnected', 'reauth-required'].includes(record.status);

// Capture only ordinary JSON request fields before any async vault or provider work.
// The caller still owns its object and may reuse it; it cannot retarget this request.
function snapshotJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(job))) fail('A_MICROSOFT_JOB_INVALID');
  const copy = Object.create(null);
  for (const key of Reflect.ownKeys(job)) {
    if (typeof key !== 'string' || !['provider', 'connectionId', 'chatId', 'cursor'].includes(key)) fail('A_MICROSOFT_JOB_INVALID');
    const field = Object.getOwnPropertyDescriptor(job, key);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')
      || (typeof field.value !== 'string' && !(key === 'cursor' && field.value === null))) fail('A_MICROSOFT_JOB_INVALID');
    copy[key] = field.value;
  }
  return Object.freeze(copy);
}

export function registerMicrosoftSourceConnectors(registry) {
  for (const [provider, contract] of Object.entries(microsoftSourceContracts)) {
    if (!registry.get(contract.connectorId)) registry.register({ id: contract.connectorId,
      displayName: provider === 'outlook' ? 'Outlook 메일 제목 읽기' : 'Teams 선택 채팅 목록 읽기',
      category: 'personal-operations', authMethods: ['oauth2'], scopes: [contract.scope],
      credentialFields: fields, requiredCredentialFields: fields,
      capabilities: [{ id: contract.capabilityId, riskTier: 'read', scopes: [contract.scope] }] });
  }
}

function jobContract(job) {
  if (!job || Object.keys(job).some(key => !['provider', 'connectionId', 'chatId', 'cursor'].includes(key))) fail('A_MICROSOFT_JOB_INVALID');
  const contract = microsoftSourceContracts[job.provider];
  if (!contract || typeof job.connectionId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(job.connectionId)) fail('A_MICROSOFT_JOB_INVALID');
  if (job.provider === 'teams-chat' && (typeof job.chatId !== 'string' || !/^[A-Za-z0-9:@._-]{1,500}$/u.test(job.chatId))) fail('A_MICROSOFT_CHAT_INVALID');
  if (job.provider === 'outlook' && job.chatId !== undefined) fail('A_MICROSOFT_JOB_INVALID');
  const path = job.provider === 'outlook' ? '/v1.0/me/messages' : `/v1.0/chats/${encodeURIComponent(job.chatId)}/messages`;
  const url = new URL(`https://graph.microsoft.com${path}`);
  url.searchParams.set('$top', '25');
  if (job.provider === 'outlook') url.searchParams.set('$select', 'id,subject,receivedDateTime');
  if (job.cursor !== undefined && job.cursor !== null) {
    if (typeof job.cursor !== 'string' || job.cursor.length > 2000) fail('A_MICROSOFT_CURSOR_INVALID');
    let cursor; try { cursor = new URL(job.cursor); } catch { fail('A_MICROSOFT_CURSOR_INVALID'); }
    let decodedPath; try { decodedPath = decodeURIComponent(cursor.pathname); } catch { fail('A_MICROSOFT_CURSOR_INVALID'); }
    if (cursor.origin !== url.origin || cursor.username || cursor.password || cursor.hash
      || decodedPath !== decodeURIComponent(path) || /%2f|%5c/iu.test(cursor.pathname)) fail('A_MICROSOFT_CURSOR_INVALID');
    const allowed = job.provider === 'outlook' ? ['$top', '$select', '$skip', '$skiptoken'] : ['$top', '$skiptoken', '$skip'];
    if ([...cursor.searchParams.keys()].some(key => !allowed.includes(key))) fail('A_MICROSOFT_CURSOR_INVALID');
    if (new Set(cursor.searchParams.keys()).size !== [...cursor.searchParams.keys()].length) fail('A_MICROSOFT_CURSOR_INVALID');
    const top = cursor.searchParams.get('$top');
    if (top !== null && (!/^\d+$/u.test(top) || Number(top) < 1 || Number(top) > 50)) fail('A_MICROSOFT_CURSOR_INVALID');
    if (job.provider === 'outlook' && cursor.searchParams.get('$select') !== 'id,subject,receivedDateTime') fail('A_MICROSOFT_CURSOR_INVALID');
    return { contract, url: cursor };
  }
  return { contract, url };
}

async function body(response) {
  try {
    const reader = response.body?.getReader?.();
    if (!reader) fail('A_MICROSOFT_RESPONSE_INVALID');
    const chunks = []; let length = 0;
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 2 * 1024 * 1024) { await reader.cancel(); fail('A_MICROSOFT_RESPONSE_TOO_LARGE'); }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) { if (/^A_MICROSOFT_/u.test(error.message)) throw error; fail('A_MICROSOFT_RESPONSE_INVALID'); }
}

/** Only metadata enters the existing inbox. No body, attachment, send or execution grant. */
export function createMicrosoftSourceReader({ registry, vault, fetchImpl = globalThis.fetch, clock = () => new Date() } = {}) {
  if (!registry?.get || !vault?.list || !vault?.withCredentials) throw new TypeError('Microsoft reader requires the trusted integration vault.');
  registerMicrosoftSourceConnectors(registry);
  const activeConnections = new Set(), pageProofs = new WeakMap(), collections = new Map();
  const connection = (job, contract) => {
    const record = vault.list().find(item => item.connectionId === job.connectionId);
    if (!live(record) || record.connectorId !== contract.connectorId || record.authMethod !== 'oauth2'
      || !record.scopes?.includes(contract.scope)) fail('A_MICROSOFT_CONNECTION_REQUIRED');
    return record;
  };
  const reader = Object.freeze({
    progress(job,inbox,{authorize}={}){
      assertReadAuthorization(authorize);job=snapshotJob(job);
      const {contract}=jobContract(job);connection(job,contract);
      if(typeof inbox?.collectionCursor!=='function')fail('A_MICROSOFT_OUTCOME_VERIFIER_UNAVAILABLE');
      const result=inbox.collectionCursor({provider:job.provider,account:job.connectionId,
        scope:job.provider==='outlook'?contract.scope:`${contract.scope}:${job.chatId}`});
      connection(job,contract);assertReadAuthorization(authorize);
      return {...result,provider:job.provider,paginationComplete:null};
    },
    async collect(job,inbox,{signal,authorize,maxPages=20}={}){
      assertReadAuthorization(authorize);job=snapshotJob(job);jobContract(job);
      if(!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)fail('A_MICROSOFT_PAGE_LIMIT_INVALID');
      if(typeof inbox?.verifyCollection!=='function')fail('A_MICROSOFT_OUTCOME_VERIFIER_UNAVAILABLE');
      if(collections.has(job.connectionId)||activeConnections.has(job.connectionId))fail('A_MICROSOFT_CONNECTION_BUSY');
      const lease=Object.freeze({}),pages=[],seenCursors=new Set(),seenIds=new Set();
      collections.set(job.connectionId,lease);
      let cursor=job.cursor??null;
      try{
        for(let index=0;index<maxPages;index++){
          if(signal?.aborted)fail('A_MICROSOFT_REQUEST_CANCELLED');
          if(pages.length)pageProofs.get(pages.at(-1)).check();
          if(seenCursors.has(cursor))fail('A_MICROSOFT_CURSOR_CYCLE');
          seenCursors.add(cursor);
          const page=await reader.page({...job,cursor},{signal,authorize,collectionLease:lease});
          if(page.nextCursor!==null&&seenCursors.has(page.nextCursor))fail('A_MICROSOFT_CURSOR_CYCLE');
          if(page.items.some(item=>seenIds.has(item.id)))fail('A_MICROSOFT_COLLECTION_CHANGED');
          reader.commitPage(page,inbox,{authorize});pages.push(page);
          for(const item of page.items)seenIds.add(item.id);
          cursor=page.nextCursor;
          if(cursor===null)break;
        }
        const checkCollection=()=>{
          for(const page of pages)if(digest(page)!==pageProofs.get(page)?.hash)fail('A_MICROSOFT_PAGE_CHANGED');
          pageProofs.get(pages.at(-1)).check();assertReadAuthorization(authorize);
        };
        checkCollection();
        const verification=inbox.verifyCollection(pages);
        checkCollection();
        if(verification.status!=='passed')fail('A_MICROSOFT_PAGE_OUTCOME_UNVERIFIED');
        return {version:'microsoft-bounded-collection-v1',status:cursor===null?'completed':'paused',
          paginationComplete:cursor===null,snapshotVerified:false,reason:cursor===null?null:'page-limit',
          provider:job.provider,pageCount:pages.length,itemCount:seenIds.size,nextCursor:cursor,
          initialCursor:job.cursor??null,verification,metadataOnly:true,contentImported:false,executionAuthority:false};
      }finally{collections.delete(job.connectionId);}
    },
    verifyCommittedPage(page,inbox,{authorize}={}){
      const proof=pageProofs.get(page);
      if(!proof||digest(page)!==proof.hash||typeof inbox?.verifyPage!=='function')fail('A_MICROSOFT_PAGE_PROOF_REQUIRED');
      proof.check();assertReadAuthorization(authorize);
      const result=inbox.verifyPage(page);
      proof.check();assertReadAuthorization(authorize);
      return result;
    },
    commitPage(page, inbox, {authorize,onCommit} = {}) {
      const proof = pageProofs.get(page);
      if (!proof || typeof inbox?.ingest !== 'function') fail('A_MICROSOFT_PAGE_PROOF_REQUIRED');
      const check = () => {
        if (digest(page) !== proof.hash) fail('A_MICROSOFT_PAGE_CHANGED');
        proof.check();
        assertReadAuthorization(authorize);
      };
      check();
      const { metadataOnly, contentImported, executionAuthority, ...inboxPage } = page;
      if (typeof inbox.verifyPage !== 'function') fail('A_MICROSOFT_OUTCOME_VERIFIER_UNAVAILABLE');
      let verification = null;
      const result = inbox.ingest(inboxPage, {onCommit:()=>{
        check(); verification = inbox.verifyPage(inboxPage);
        if (verification?.version!=='personal-source-page-verification-v1' || verification.status!=='passed'
          || verification.observedItemCount!==page.items.length) fail('A_MICROSOFT_PAGE_OUTCOME_UNVERIFIED');
        check();
        if(onCommit!==undefined){if(typeof onCommit!=='function')fail('A_MICROSOFT_COMMIT_HOOK_INVALID');onCommit(verification);check();}
      }});
      if (!verification) fail('A_MICROSOFT_PAGE_OUTCOME_UNVERIFIED');
      return {...result,verification};
    },
    status() { return { contracts: Object.entries(microsoftSourceContracts).map(([provider, contract]) => ({ provider, ...contract })),
      configuredConnections: vault.list().filter(item => live(item) && Object.values(microsoftSourceContracts).some(c => c.connectorId === item.connectorId && item.scopes?.includes(c.scope))).length,
      automaticSync: false, realAccountVerified: false, supported: 'explicit-page-metadata-read', boundedCollection:true,maximumCollectionPages:100, executionAuthority: false }; },
    async page(job, { signal, authorize, collectionLease } = {}) {
      const checkAuthorization=()=>assertReadAuthorization(authorize);
      checkAuthorization();
      job = snapshotJob(job);
      const { contract, url } = jobContract(job);
      if (activeConnections.has(job.connectionId)||collections.has(job.connectionId)&&collections.get(job.connectionId)!==collectionLease) fail('A_MICROSOFT_CONNECTION_BUSY');
      activeConnections.add(job.connectionId);
      try {
      const initial = connection(job, contract);
      let initialHash = digest(initial);
      let revision = typeof vault.credentialRevision === 'function' ? vault.credentialRevision(job.connectionId) : null;
      const checkCancelled = () => { if (signal?.aborted) fail('A_MICROSOFT_REQUEST_CANCELLED'); };
      const checkSnapshot = () => {
        checkCancelled();
        checkAuthorization();
        if (digest(connection(job, contract)) !== initialHash) fail('A_MICROSOFT_CONNECTION_CHANGED');
        if (revision === null || typeof vault.credentialRevision !== 'function') fail('A_MICROSOFT_COMMIT_VERIFIER_UNAVAILABLE');
        try { if (vault.credentialRevision(job.connectionId) !== revision) fail('A_MICROSOFT_CONNECTION_CHANGED'); }
        catch { fail('A_MICROSOFT_CONNECTION_CHANGED'); }
      };
      const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
      const request = async (target, options) => {
        checkCancelled();checkAuthorization();
        let response;
        try { response = await fetchImpl(target, { ...options, redirect: 'error', signal: requestSignal() }); }
        catch { checkCancelled();checkAuthorization();fail('A_MICROSOFT_NETWORK_UNAVAILABLE'); }
        checkCancelled();checkAuthorization();return response;
      };
      return await vault.withCredentials(job.connectionId, async (credentials, metadata) => {
        if (metadata.connectorId !== contract.connectorId || metadata.authMethod !== 'oauth2' || !metadata.scopes?.includes(contract.scope)
          || !fields.every(key => typeof credentials[key] === 'string' && credentials[key].trim())
          || !/^(common|organizations|consumers|[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})$/u.test(credentials.tenantId)
          || (job.provider === 'teams-chat' && ['common', 'consumers'].includes(credentials.tenantId))) fail('A_MICROSOFT_CREDENTIALS_INVALID');
        let credentialHash = digest(fields.map(key => credentials[key]));
        const assertCurrent = async () => {
          checkCancelled();
          checkAuthorization();
          if (digest(connection(job, contract)) !== initialHash) fail('A_MICROSOFT_CONNECTION_CHANGED');
          const currentHash = await vault.withCredentials(job.connectionId, current => digest(fields.map(key => current[key])));
          if (currentHash !== credentialHash) fail('A_MICROSOFT_CONNECTION_CHANGED');
          checkCancelled();
          checkAuthorization();
          if (digest(connection(job, contract)) !== initialHash) fail('A_MICROSOFT_CONNECTION_CHANGED');
          if (revision !== null) checkSnapshot();
        };
        await assertCurrent();
        const refreshed = await request(`https://login.microsoftonline.com/${credentials.tenantId}/oauth2/v2.0/token`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: credentials.clientId, client_secret: credentials.clientSecret,
            refresh_token: credentials.refreshToken, scope: `https://graph.microsoft.com/${contract.scope}` }) });
        if (!refreshed.ok) fail(refreshed.status === 400 || refreshed.status === 401 ? 'A_MICROSOFT_REAUTH_REQUIRED' : 'A_MICROSOFT_TOKEN_UNAVAILABLE');
        const token = await body(refreshed);
        if (typeof token.access_token !== 'string' || token.access_token.length > 16384 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token.access_token)
          || (token.token_type !== undefined && String(token.token_type).toLowerCase() !== 'bearer')
          || !Number.isFinite(token.expires_in) || token.expires_in <= 0
          || !String(token.scope ?? '').split(' ').some(scope => scope === contract.scope || scope === `https://graph.microsoft.com/${contract.scope}`)) fail('A_MICROSOFT_TOKEN_INVALID');
        await assertCurrent();
        if (token.refresh_token !== undefined) {
          if (typeof token.refresh_token !== 'string' || !token.refresh_token.trim() || token.refresh_token.length > 16384
            || /[\u0000-\u001f\u007f]/u.test(token.refresh_token)) fail('A_MICROSOFT_TOKEN_INVALID');
          if (token.refresh_token !== credentials.refreshToken) {
            if (typeof vault.rotateOAuthRefreshToken !== 'function') fail('A_MICROSOFT_REFRESH_STORAGE_UNAVAILABLE');
            try {
              const updated = vault.rotateOAuthRefreshToken(job.connectionId, { expectedConnection: initial,
                expectedCredentials: credentials, refreshToken: token.refresh_token });
              initialHash = digest(updated);
              revision = typeof vault.credentialRevision === 'function' ? vault.credentialRevision(job.connectionId) : null;
              credentialHash = digest(fields.map(key => key === 'refreshToken' ? token.refresh_token : credentials[key]));
            } catch { fail('A_MICROSOFT_REFRESH_STORAGE_UNAVAILABLE'); }
            await assertCurrent();
          }
        }
        const response = await request(url, { method: 'GET', headers: { authorization: `Bearer ${token.access_token}` } });
        if (!response.ok) fail(response.status === 401 ? 'A_MICROSOFT_REAUTH_REQUIRED' : response.status === 403 ? 'A_MICROSOFT_SCOPE_REJECTED' : response.status === 429 ? 'A_MICROSOFT_RATE_LIMITED' : 'A_MICROSOFT_PAGE_UNAVAILABLE');
        const result = await body(response); await assertCurrent();
        if (!Array.isArray(result.value) || result.value.length > 500) fail('A_MICROSOFT_PAGE_INVALID');
        const items = result.value.map(row => {
          if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 500 || /[\u0000-\u001f]/u.test(row.id)) fail('A_MICROSOFT_ITEM_INVALID');
          if (row.subject != null && (typeof row.subject !== 'string' || row.subject.length > 2000 || /[\u0000-\u001f]/u.test(row.subject))) fail('A_MICROSOFT_ITEM_INVALID');
          return { id: row.id, title: row.subject?.trim() || (job.provider === 'outlook' ? '(제목 없음)' : '(Teams 메시지)'), start: null,
            withdrawn: job.provider === 'teams-chat' && row.deletedDateTime != null };
        });
        if (new Set(items.map(item => item.id)).size !== items.length) fail('A_MICROSOFT_PAGE_INVALID');
        const nextCursor = result['@odata.nextLink'] ?? null;
        if (nextCursor !== null) jobContract({ ...job, cursor: nextCursor });
        const page = { provider: job.provider, account: job.connectionId, scope: job.provider === 'outlook' ? contract.scope : `${contract.scope}:${job.chatId}`,
          cursor: job.cursor ?? null, nextCursor, observedAt: clock().toISOString(), items,
          metadataOnly: true, contentImported: false, executionAuthority: false };
        checkCancelled();
        if (revision !== null) checkSnapshot();
        pageProofs.set(page,{hash:digest(page),check:checkSnapshot});
        return page;
      });
      } finally { activeConnections.delete(job.connectionId); }
    }
  });
  return reader;
}
