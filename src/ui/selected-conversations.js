import {convertChatGptExportDocument,selectConversationDocument} from '../../packages/shared/src/chatgpt-export-conversion.js';
import {readChatGptExportFile,exportFileLimits} from '../../packages/shared/src/chatgpt-export-file.js';
/** Selected local documents stay in memory; nothing is uploaded until explicit preview. */
export function createSelectedConversationPanel({ request, changed, escape }) {
  const state = { open: false, busy: false, document: null, sourceRef: '', selected: new Set(), preview: null, items: [], query: '', searchedQuery: '', nextCursor: null, page: 0, cursors: [null], message: '', choicePage:0, choiceQuery:'', fileName:'' };
  const scope = { userId: 'local_user', conversationId: null };
  let host;
  const input = () => {
    const conversion=Array.isArray(state.document)?convertChatGptExportDocument(state.document,[...state.selected]):null;
    return {...scope,document:conversion?.document??selectConversationDocument(state.document,[...state.selected]),sourceRef:state.sourceRef,selectedConversationIds:[...state.selected],conversion};
  };
  const choices=()=>Array.isArray(state.document)?state.document:(state.document?.conversations??[]);
  const filteredChoices=()=>choices().map((conversation,index)=>({conversation,index})).filter(({conversation})=>String(conversation.title??conversation.id).toLocaleLowerCase().includes(state.choiceQuery.toLocaleLowerCase()));
  const disabled = () => state.busy ? 'disabled' : '';
  function render() {
    const filtered=filteredChoices(),visible=filtered.slice(state.choicePage*50,state.choicePage*50+50);
    return `<details class="personal-inbox panel" data-selected-conversations ${state.open ? 'open' : ''}>
      <summary><strong>선택한 대화 기억</strong><span>다른 대화의 필요한 부분만 연결</span></summary>
      <div class="personal-inbox-content"><p>ChatGPT에서 내보낸 ZIP 또는 대화 JSON을 선택하세요. ZIP은 이 PC 안에서 대화 JSON만 읽습니다. 파일 전체는 전송하지 않으며 선택한 대화의 현재 텍스트 흐름만 가져옵니다. 가져온 말은 참고 자료이며 실행 승인이나 검증된 결과로 바뀌지 않습니다.</p>
      <label>대화 파일 <input id="selected-conversation-file" type="file" accept=".json,.zip,application/json,application/zip" data-archive-file ${disabled()}></label>
      ${state.document?`<p>읽은 파일: ${escape(state.fileName)} · 이 PC에서 대화를 선택하는 중입니다.</p>`:''}
      ${state.document?`<form data-archive-choice-search><label>대화 제목으로 찾기 <input name="title" value="${escape(state.choiceQuery)}" maxlength="512" ${disabled()}></label><button type="submit" ${disabled()}>대화 찾기</button></form><p>전체 ${choices().length}개 · 검색 ${filtered.length}개 · 선택 ${state.selected.size}개 (최대 20개)</p>`:''}
      <div class="personal-inbox-grid">${visible.map(({conversation:c,index:i}) => `<label class="personal-inbox-item"><input id="selected-conversation-pick-${i}" type="checkbox" data-archive-select="${i}" ${state.selected.has(c.id) ? 'checked' : ''} ${state.busy||!state.selected.has(c.id)&&state.selected.size>=20?'disabled':''}> ${escape(typeof c.title==='string'?c.title:c.id)}${Array.isArray(c.messages)?` · ${c.messages.length}개 메시지`:''}</label>`).join('')}</div>
      <div class="archive-page-navigation">${state.choicePage>0?`<button type="button" data-archive-choice-previous ${disabled()}>이전 대화</button>`:''}${(state.choicePage+1)*50<filtered.length?`<button type="button" data-archive-choice-next ${disabled()}>다음 대화</button>`:''}</div>
      <button type="button" data-archive-preview ${state.busy || !state.selected.size ? 'disabled' : ''}>선택 내용 확인</button>
      ${state.preview ? `<p>선택한 ${state.preview.selectedMessages}개 메시지를 참고 기억으로 저장합니다.${state.preview.excludedCount?` 시스템·도구·숨겨진 메시지 ${state.preview.excludedCount}개는 제외합니다.`:''}</p><button type="button" data-archive-commit ${disabled()}>선택한 대화 저장</button>` : ''}
      <p role="status">${escape(state.busy ? '처리 중입니다.' : state.message)}</p>
      <form data-archive-search><label>가져온 대화에서 찾기 <input id="selected-conversation-query" name="query" required maxlength="4000" value="${escape(state.query)}" ${disabled()}></label><button type="submit" ${disabled()}>찾기</button></form>
      <p>관련 단어가 있는 기록을 실제 발화 시각 순서로 보여줍니다. 긴 기록은 일치 구간을 표시합니다. 철회하면 이후 검색과 계획의 참고에서 제외됩니다.</p>
      <div class="personal-inbox-grid">${state.items.map(item => `<article class="personal-inbox-item"><h3>${item.speaker === 'user' ? '사용자 발언' : 'AI 발언'} · ${escape(item.sourceConversationId)}</h3><p>${escape(item.text)}${item.truncated ? '…' : ''}</p><small>${escape(item.observedAt)}</small><button type="button" data-archive-withdraw="${escape(item.memoryId)}" ${disabled()}>이 기억 철회</button></article>`).join('')}</div>
      <div class="archive-page-navigation">${state.page>0 ? `<button type="button" data-archive-previous ${disabled()}>이전 결과 보기</button>` : ''}
      ${state.nextCursor ? `<button type="button" data-archive-more ${disabled()}>다음 결과 보기</button>` : ''}</div></div></details>`;
  }
  async function run(action) {
    if (state.busy) return;
    state.open = host?.querySelector('[data-selected-conversations]')?.open ?? state.open;
    state.busy = true; state.message = ''; changed();
    try { await action(); }
    catch (error) {
      const code = error?.code ?? error?.payload?.error?.code ?? error?.message ?? '';
      state.message = /SENSITIVE/u.test(code) ? '민감한 정보가 감지되었습니다. 해당 부분을 제거한 파일로 다시 시도하세요.'
        : /PAGE_CHANGED|CURSOR_INVALID/u.test(code) ? '기록이 변경되었거나 연결이 다시 시작됐습니다. 찾기를 눌러 최신 기록부터 다시 확인하세요.'
        : /DOCUMENT_CHANGED|REVISION_CONFLICT/u.test(code) ? '파일 내용이 달라졌습니다. 다시 선택하고 확인하세요.'
        : /SELECTION_REQUIRED/u.test(code) ? '한 번에 1~20개 대화를 선택하세요.'
        : /CONTENT_UNSUPPORTED|MESSAGE_UNSUPPORTED/u.test(code) ? '이 대화에는 지원하지 않는 이미지·음성 또는 메시지가 있습니다. 다른 텍스트 대화를 선택하세요.'
        : /BRANCH|TIME_REQUIRED/u.test(code) ? '대화의 답변 흐름이나 원래 날짜를 확인할 수 없습니다. 다른 파일을 선택하세요.'
        : /FILE_TOO_LARGE|IMPORT_TOO_LARGE/u.test(code) ? 'ZIP은 64MB, 대화 JSON 합계는 32MB까지 읽을 수 있습니다. 더 작은 공식 내보내기 파일을 선택하세요.'
        : /ZIP_BROWSER_UNSUPPORTED/u.test(code) ? '이 브라우저는 압축 읽기를 지원하지 않습니다. ZIP을 풀어 대화 JSON을 선택하세요.'
        : /ZIP_/u.test(code) ? '대화 JSON을 확인할 수 없는 ZIP입니다. 원래 내보내기 ZIP을 다시 선택하거나 압축을 풀어 JSON을 선택하세요.'
        : '처리하지 못했습니다. Core 연결·인증과 파일 형식을 확인하세요.';
      state.preview = null;
      if (/PAGE_CHANGED|CURSOR_INVALID/u.test(code)) { state.items = []; state.nextCursor = null; state.page=0; state.cursors=[null]; }
    } finally { state.busy = false; changed(); }
  }
  const query = async (direction = 0) => {
    const target=direction===0 ? 0 : state.page+direction;
    if (!direction) { state.items = []; state.nextCursor = null; state.searchedQuery = state.query; state.page=0; state.cursors=[null]; }
    const cursor=direction===1 ? state.nextCursor : state.cursors[target];
    const page = await request('/memory/selected-conversations/page', { method:'POST', body:{...scope,query:state.searchedQuery,pageSize:20,cursor} });
    state.items = page.items; state.page=target;
    state.cursors[target]=cursor;
    state.nextCursor = page.nextCursor;
    const from=state.items.length ? target*20+1 : 0,to=target*20+state.items.length;
    state.message = state.items.length
      ? `${from}~${to}번째 검색 결과 · ${target+1}페이지${page.hasMore ? ' · 다음 결과가 있습니다.' : ' · 마지막 결과입니다.'}`
      : '검색 결과가 없습니다.';
  };
  function attach(root) {
    host = root;
    root.addEventListener('toggle', event => { if (event.target.isConnected && event.target.matches?.('[data-selected-conversations]')) state.open = event.target.open; }, true);
    root.addEventListener('input', event => { if (event.target.matches?.('[data-archive-search] input')) state.query = event.target.value; });
    root.addEventListener('change', event => {
      if (event.target.matches?.('[data-archive-select]')) {
        if (state.busy) return;
        const id = choices()[Number(event.target.dataset.archiveSelect)]?.id;
        state.open = event.target.closest('[data-selected-conversations]').open;
        if (event.target.checked) state.selected.add(id); else state.selected.delete(id);
        state.preview = null; changed();
      }
      if (event.target.matches?.('[data-archive-file]')) {
        const file = event.target.files?.[0];
        if (!file || state.busy) return;
        void run(async () => {
          state.document = null; state.selected.clear(); state.preview = null;
          state.sourceRef='';state.choicePage=0;state.choiceQuery='';state.fileName='';
          if (file.size > exportFileLimits.archiveBytes) throw new Error('FILE_TOO_LARGE');
          const bytes=await file.arrayBuffer();
          const result=await readChatGptExportFile(bytes,{name:file.name});
          state.document = result.document; state.fileName=file.name; state.sourceRef = `selected-file:${file.name}:export-sha256:${result.sourceBytesHash}`; state.message = '저장할 대화를 선택하세요.';
        });
      }
    });
    root.addEventListener('click', event => {
      if(event.target.closest('[data-archive-choice-next]')&&!state.busy){state.choicePage++;changed();}
      if(event.target.closest('[data-archive-choice-previous]')&&!state.busy){state.choicePage--;changed();}
      if (event.target.closest('[data-archive-more]') && state.nextCursor) void run(() => query(1));
      if (event.target.closest('[data-archive-previous]') && state.page>0) void run(() => query(-1));
      if (event.target.closest('[data-archive-preview]')) void run(async () => {
        const {conversion,...body}=input();
        state.preview = await request('/memory/selected-conversations/preview', { method: 'POST', body });
        state.preview.excludedCount=Object.values(conversion?.excludedMessageCounts??{}).reduce((sum,count)=>sum+count,0);
      });
      if (event.target.closest('[data-archive-commit]') && state.preview) void run(async () => {
        const {conversion,...body}=input();
        const result = await request('/memory/selected-conversations/commit', { method: 'POST', body: { ...body, expectedDocumentHash: state.preview.documentHash } });
        state.preview = null; state.document = null; state.selected.clear(); state.sourceRef = '';state.fileName='';
        state.items = []; state.nextCursor = null; state.page=0; state.cursors=[null];
        state.message = `${result.imported}개 저장 · ${result.replayed}개 이미 저장 · ${result.withdrawn}개 철회 유지`;
      });
      const withdrawal = event.target.closest('[data-archive-withdraw]');
      if (withdrawal) void run(async () => {
        const result = await request('/memory/selected-conversations/withdraw', { method: 'POST', body: { ...scope, id: withdrawal.dataset.archiveWithdraw } });
        await query(); state.message = result.withdrawn ? '이 기억을 철회했습니다.' : '이미 제외되었거나 현재 범위에 없는 기억입니다.';
      });
    });
    root.addEventListener('submit', event => {
      if(event.target.matches?.('[data-archive-choice-search]')){event.preventDefault();if(!state.busy){state.choiceQuery=String(new FormData(event.target).get('title')??'');state.choicePage=0;changed();}return;}
      if (!event.target.matches?.('[data-archive-search]')) return;
      event.preventDefault(); state.query = new FormData(event.target).get('query');
      void run(() => query());
    });
  }
  return { render, attach };
}
