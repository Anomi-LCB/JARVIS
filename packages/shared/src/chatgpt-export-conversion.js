const fail=code=>{throw Object.assign(new Error(code),{code});};
const id=value=>typeof value==='string'&&value.length>0&&value.length<=512&&!/[\u0000-\u001f\u007f]/u.test(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)
 &&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);

/** Preserve validation-visible fields, but never transfer unselected message bodies. */
export function selectConversationDocument(document,selectedConversationIds){
 if(!plain(document)||document.format!=='jarvis-selected-conversations-v1'||!['chatgpt','jarvis'].includes(document.provider)
  ||!Array.isArray(document.conversations)||document.conversations.length>500)fail('F_CONVERSATION_FORMAT_UNSUPPORTED');
 if(!Array.isArray(selectedConversationIds)||selectedConversationIds.length<1||selectedConversationIds.length>20
  ||selectedConversationIds.some(value=>!id(value))||new Set(selectedConversationIds).size!==selectedConversationIds.length)
  fail('F_CONVERSATION_SELECTION_REQUIRED');
 const ids=document.conversations.map(conversation=>conversation?.id);
 if(ids.some(value=>!id(value))||new Set(ids).size!==ids.length||selectedConversationIds.some(value=>!ids.includes(value)))
  fail('F_CONVERSATION_SELECTION_INVALID');
 return {...document,conversations:document.conversations.filter(conversation=>selectedConversationIds.includes(conversation.id))};
}

/** Local conversion of an explicit export selection; no network, execution or inferred dates. */
export function convertChatGptExportDocument(exportData,selectedConversationIds){
 if(!Array.isArray(exportData)||exportData.length>10000)fail('F_CONVERSATION_EXPORT_FORMAT_UNSUPPORTED');
 if(!Array.isArray(selectedConversationIds)||selectedConversationIds.length<1||selectedConversationIds.length>20
  ||selectedConversationIds.some(value=>!id(value))||new Set(selectedConversationIds).size!==selectedConversationIds.length)
  fail('F_CONVERSATION_SELECTION_REQUIRED');
 const byId=new Map();
 for(const conversation of exportData){
  if(!plain(conversation)||!id(conversation.id)||byId.has(conversation.id))fail('F_CONVERSATION_EXPORT_ID_INVALID');
  byId.set(conversation.id,conversation);
 }
 const excludedMessageCounts={systemOrTool:0,hidden:0,nonFinalChannel:0,toolRecipient:0};
 const conversations=selectedConversationIds.map(conversationId=>{
  const conversation=byId.get(conversationId);
  if(!conversation)fail('F_CONVERSATION_SELECTION_INVALID');
  if(!plain(conversation.mapping)||Object.keys(conversation.mapping).length>5000||!id(conversation.current_node))
   fail('F_CONVERSATION_EXPORT_BRANCH_REQUIRED');
  const chain=[],seen=new Set();let nodeId=conversation.current_node;
  while(nodeId!==null){
   if(!id(nodeId)||seen.has(nodeId)||!own(conversation.mapping,nodeId))fail('F_CONVERSATION_EXPORT_BRANCH_INVALID');
   seen.add(nodeId);
   const node=conversation.mapping[nodeId];
   if(!plain(node)||node.id!==nodeId||!(node.parent===null||id(node.parent)))fail('F_CONVERSATION_EXPORT_BRANCH_INVALID');
   chain.push(node);nodeId=node.parent;
  }
  const messages=[];
  for(const node of chain.reverse()){
   if(node.message===null)continue;
   const message=node.message;
   if(!plain(message)||!id(message.id)||!plain(message.author))fail('F_CONVERSATION_EXPORT_MESSAGE_INVALID');
   const speaker=message.author.role;
   // System/tool/hidden channels are not human conversation reference content.
   if(['system','tool','developer'].includes(speaker)){excludedMessageCounts.systemOrTool++;continue;}
   if(!['user','assistant'].includes(speaker))fail('F_CONVERSATION_EXPORT_MESSAGE_UNSUPPORTED');
   if(message.metadata?.is_visually_hidden_from_conversation===true){excludedMessageCounts.hidden++;continue;}
   if(message.channel!=null&&message.channel!=='final'){excludedMessageCounts.nonFinalChannel++;continue;}
   if(message.recipient!=null&&message.recipient!=='all'){excludedMessageCounts.toolRecipient++;continue;}
   if(!plain(message.content)||message.content.content_type!=='text'||!Array.isArray(message.content.parts)
    ||message.content.parts.length<1||message.content.parts.some(part=>typeof part!=='string'))
    fail('F_CONVERSATION_EXPORT_CONTENT_UNSUPPORTED');
   const text=message.content.parts.join('\n');
   if(!text.trim()||text.length>20000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text))
    fail('F_CONVERSATION_TEXT_INVALID');
   if(typeof message.create_time!=='number'||!Number.isFinite(message.create_time)||message.create_time<0
    ||message.create_time*1000>8640000000000000)fail('F_CONVERSATION_TIME_REQUIRED');
   const spokenAt=new Date(message.create_time*1000).toISOString();
   if(messages.some(item=>item.id===message.id))fail('F_CONVERSATION_MESSAGE_DUPLICATE');
   messages.push({id:message.id,speaker,text,spokenAt});
   if(messages.length>500)fail('F_CONVERSATION_MESSAGES_INVALID');
  }
  if(!messages.length)fail('F_CONVERSATION_MESSAGES_INVALID');
  return {id:conversationId,messages};
 });
 return {document:{format:'jarvis-selected-conversations-v1',provider:'chatgpt',conversations},
  adapterVersion:'chatgpt-export-text-branch-v1',excludedMessageCounts,executionAuthority:false};
}
