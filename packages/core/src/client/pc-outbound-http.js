import { pcTaskOptions,pcTaskLabels } from './pc-task-options.js';
import { readJsonBody, sendJson } from '../../../shared/src/http.js';

/** Invoked only after Core's loopback boundary and route-specific admin authorization. */
export async function handlePcOutboundAdministration(request, response, { path, controller, tasks, missions=null,executionConfiguration=null }) {
  if (!controller) return sendJson(response, 503, { error: { code: 'A_PC_OUTBOUND_NOT_CONFIGURED' },
    nextAction: '상시 노드의 장치 연결을 준비한 후 사용하세요.' });
  try {
    if(path==='/pc-nodes/task-options'&&request.method==='GET'){controller.authorityGuard();return sendJson(response,200,pcTaskOptions(tasks,new URL(request.url,'http://127.0.0.1').searchParams,missions));}
    if (path === '/pc-nodes' && request.method === 'GET') return sendJson(response, 200, {...controller.status(),...(executionConfiguration?{executionConfiguration:executionConfiguration()}: {})});
    const query = new URL(request.url, 'http://127.0.0.1').search;
    if (query) throw new Error('A_PC_OUTBOUND_INPUT_INVALID');
    if (request.method === 'POST') {
      if (request.headers['content-type']?.split(';')[0] !== 'application/json' || request.headers['content-encoding']) {
        return sendJson(response, 415, { error: { code: 'A_PC_OUTBOUND_JSON_REQUIRED' } });
      }
      const input = await readJsonBody(request, { maximumBytes: path==='/pc-nodes/task-labels'?524288:131072 });
      if(path==='/pc-nodes/task-labels'){controller.authorityGuard();return sendJson(response,200,pcTaskLabels(tasks,input,missions));}
      if (path === '/pc-nodes/certificate') return sendJson(response,200,controller.previewCertificate(input));
      if (path === '/pc-nodes') return sendJson(response, 201, controller.enroll(input));
      const matches = /^\/pc-nodes\/([a-zA-Z0-9._-]{1,128})\/(revoke|observations|command-scope)$/u.exec(path);
      if(matches?.[2]==='command-scope')return sendJson(response,200,controller.updateCommandScope(matches[1],input));
      if (matches?.[2] === 'revoke') return sendJson(response, 200, controller.revoke(matches[1], input));
      if (matches?.[2] === 'observations') return sendJson(response, 202, controller.enqueue(matches[1], input));
    }
    const observation = /^\/pc-nodes\/observations\/([a-zA-Z0-9._-]{1,128})$/u.exec(path);
    const commandScope=/^\/pc-nodes\/([a-zA-Z0-9._-]{1,128})\/command-scope$/u.exec(path);
    if(commandScope&&request.method==='GET')return sendJson(response,200,controller.commandScope(commandScope[1]));
    const scope = /^\/pc-nodes\/([a-zA-Z0-9._-]{1,128})\/scope$/u.exec(path);
    if (scope && request.method === 'GET') return sendJson(response,200,controller.scope(scope[1]));
    if (observation && request.method === 'GET') {
      const result = controller.result(observation[1]);
      return sendJson(response, result ? 200 : 404, result ?? { error: { code: 'A_PC_OUTBOUND_RESULT_NOT_FOUND' } });
    }
    return sendJson(response, 405, { error: { code: 'A_PC_OUTBOUND_METHOD_NOT_ALLOWED' } });
  } catch (error) {
    const code = /^A_PC_(?:OUTBOUND|COMMAND)_[A-Z_]+$/u.test(error?.message ?? '') ? error.message : 'A_PC_OUTBOUND_REQUEST_FAILED';
    const status = [400,413].includes(error?.statusCode) ? error.statusCode : 409;
    return sendJson(response, status, { error: { code } });
  }
}
