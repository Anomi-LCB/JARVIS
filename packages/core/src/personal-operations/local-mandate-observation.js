import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {validateWorkflowSpec} from '../mission/workflow-ir.js';
import {selectedSourceMandateRef} from './selected-source-stream.js';
import {lifecycleCaseMandateRef} from './lifecycle-case-read.js';
import {microsoftCollectionMandateRef} from './microsoft-collection-request.js';

function fail(code) { throw Object.assign(new Error(code), { code, notDispatched: true }); }
/** Match the physical identity, including the existing parent of a new file. */
export function localMandateFileRef(path, workspaceRoot) {
  if (typeof path !== 'string' || !path.trim() || /[\u0000-\u001f]/u.test(path)
      || typeof workspaceRoot !== 'string' || !workspaceRoot) fail('A_MANDATE_FILE_IDENTITY_INVALID');
  let cursor = resolve(workspaceRoot, path), suffix = [];
  while (true) {
    try {
      const physical = resolve(realpathSync(cursor), ...suffix);
      return `file:${process.platform === 'win32' ? physical.toLowerCase() : physical}`;
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor)); cursor = dirname(cursor);
    }
  }
}

/** Explicit recursive metadata permission, never permission to read file bytes. */
export function localMandateTreeRef(path,workspaceRoot){return localMandateFileRef(path,workspaceRoot).replace(/^file:/u,'file-tree:');}

export function observeLocalMandateDataRefs(action, workspaceRoot) {
  if(action?.toolName==='source.collectMicrosoftMetadata')return [microsoftCollectionMandateRef(action.arguments)];
  if(action?.toolName==='source.readSelectedInbox')return [selectedSourceMandateRef(action.arguments)];
  if(action?.toolName==='case.readLocalRecord')return [lifecycleCaseMandateRef(action.arguments)];
  if(action?.toolName==='workflow.execute')return observeWorkflowRefs(action.arguments,workspaceRoot);
  // Only reviewed argument semantics are mapped. A model-supplied dataRefs is
  // never accepted as an observation of what the adapter will actually access.
  const fields = {
    'filesystem.createTextFile': ['path', 'content', 'allowOverwrite', 'expectedSha256', 'rawText'],
    'filesystem.readText': ['path', 'offset', 'maxChars', 'rawText'],
    'filesystem.listFiles': ['directory', 'path', 'offset', 'maxItems', 'expectedListingSha256', 'rawText']
  }[action?.toolName];
  const args = action?.arguments;
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args)
      || Object.keys(args).some(key => !fields.includes(key))) fail('A_MANDATE_TOOL_OBSERVATION_UNSUPPORTED');
  const path=action.toolName==='filesystem.listFiles'?(args.directory??args.path):args.path;
  return [localMandateFileRef(path, workspaceRoot)];
}

function observeWorkflowRefs(args,workspaceRoot){
  if(!args||typeof args!=='object'||Array.isArray(args)
      ||Object.keys(args).some(key=>!['spec','workspaceRoot','allowOverwrite','rawText'].includes(key))
      ||!Object.hasOwn(args,'spec'))fail('A_MANDATE_WORKFLOW_OBSERVATION_UNSUPPORTED');
  if(args.workspaceRoot!==undefined&&localMandateFileRef(args.workspaceRoot,workspaceRoot)!==localMandateFileRef(workspaceRoot,workspaceRoot))
    fail('A_MANDATE_WORKFLOW_ROOT_UNSUPPORTED');
  const spec=validateWorkflowSpec(args.spec),refs=[];
  // Explicit reviewed IO operations only. Process/SQLite/content search need
  // their own contracts; typed paths are fenced again at actual adapter IO.
  for(const node of spec.nodes){
    if(!['data.readJson','data.readCsv','text.read','write.json','write.csv','write.text','assert.count','assert.equals','fs.inventory','data.filter','text.extractFields','safety.simulation'].includes(node.op))
      fail('A_MANDATE_WORKFLOW_OPERATION_UNSUPPORTED');
    if(['data.readJson','data.readCsv','text.read','write.json','write.csv','write.text','fs.inventory'].includes(node.op)){
      if(typeof node.args.path==='string')refs.push(node.op==='fs.inventory'?localMandateTreeRef(node.args.path,workspaceRoot):localMandateFileRef(node.args.path,workspaceRoot));
      else if(!node.args.path?.$ref||Object.keys(node.args.path).length!==1)fail('A_MANDATE_WORKFLOW_DYNAMIC_PATH_UNSUPPORTED');
      // Typed references are observed at their actual IO boundary by a private
      // adapter hook. They do not inherit file-content permission from a tree.
    }
  }
  return [...new Set(refs)].sort();
}
