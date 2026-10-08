export const mcpInstallationReasons=Object.freeze({
 A_MCP_INSTALL_REVIEWED_CODE_MISSING:'검토된 설치 코드가 없거나 버전이 바뀌었습니다. 일치하는 패키지를 준비해야 합니다.',
 A_MCP_INSTALL_CONTRACT_CHANGED:'서버 도구의 검증 계약이 바뀌었습니다. 새 계약을 검토해야 합니다.',
 A_MCP_INSTALL_CATALOG_MISMATCH:'선택한 패키지와 도구 계약이 일치하지 않습니다.',
 A_MCP_NOT_FOUND:'등록한 서버가 없어 복원하지 못했습니다.',
 A_MCP_INSTALL_ACTIVATION_FAILED:'패키지를 활성화하지 못했습니다. 설치 상태를 다시 확인하세요.'
});
export function renderMcpPackageSetup(state,connections,{escape,auth=false,busy=false}={}){
 if(!state)return '<section data-mcp-packages><h2>업무 기능 설치</h2><p>설치 목록을 확인하지 못했습니다. 상태 새로고침으로 다시 확인하세요.</p></section>';
 const catalog=state.availableCatalog??[],installations=state.installations??[];
 const rows=connections.flatMap(connection=>(connection.capabilityReadiness??[]).map(readiness=>{
  const installed=installations.find(i=>i.connectionId===connection.id&&i.tool===readiness.tool);
  const choices=readiness.contractCurrent?catalog.filter(c=>c.tool===readiness.tool&&c.packageId===readiness.contract?.packageId&&c.version===readiness.contract?.version):[];
  return `<article data-mcp-package-row><h3>${escape(connection.label)} · ${escape(readiness.tool)}</h3>${installed?`<p data-mcp-install-status>${installed.status==='installed'&&readiness.packageInstalled?'설치됨 · 현재 계약으로 확인했습니다.':escape(mcpInstallationReasons[installed.reasonCode]??'현재 계약의 설치 여부를 확인해야 합니다.')}</p>`:''}${choices.length?`<form data-mcp-install="${escape(connection.id)}" data-tool="${escape(readiness.tool)}"><label>검토된 업무 패키지<select name="catalogId">${choices.map(c=>`<option value="${escape(c.id)}">${escape(c.label??c.packageId)} · ${escape(c.version)}</option>`).join('')}</select></label><button ${!auth||busy||readiness.packageInstalled?'disabled':''}>업무 기능 설치</button></form>`:'<p>이 도구에 맞는 검토된 패키지가 없습니다. 서버 설명이나 임의 설치 파일로 대신 활성화하지 않습니다.</p>'}</article>`;
 })).join('');
 return `<section data-mcp-packages><h2>업무 기능 설치</h2><p>검토된 패키지를 설치하면 도구와 결과 검증기가 함께 준비됩니다. 도구 실행 허용과 작업 완료 검증은 별도로 진행합니다.</p>${!catalog.length?'<p>현재 배포에 설치할 수 있는 검토된 패키지가 없습니다.</p>':''}${rows||'<p>서버를 등록하고 도구 목록을 확인하면 맞는 패키지를 선택할 수 있습니다.</p>'}</section>`;
}
