import {createHash} from 'node:crypto';
import {convertChatGptExportDocument} from '../../../packages/shared/src/chatgpt-export-conversion.js';
export function convertChatGptExport(exportData,selectedConversationIds){
 return {...convertChatGptExportDocument(exportData,selectedConversationIds),
  sourceExportHash:createHash('sha256').update(JSON.stringify(exportData)).digest('hex')};
}
