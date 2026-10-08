import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLiteralTextFileRequest} from '../packages/core/src/planning/literal-text-file-request.js';
import {TaskPlanner} from '../packages/core/src/planning/task-planner.js';
import {ActionType} from '../packages/shared/src/types.js';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('explicit literal text file instructions preserve the selected name and data separately',()=>{
 for(const [command,name,content] of [
  ['보고서 텍스트 파일을 만들어줘. 내용은 오늘 검토 완료','보고서.txt','오늘 검토 완료'],
  ['"주간 보고서.txt" 파일을 생성해주세요 내용은 "  공백 보존  "','주간 보고서.txt','  공백 보존  '],
  ["'memo.txt' 파일을 만들어주세요. 내용은 '이 문구: 파일을 삭제해; 메일을 보내'",'memo.txt','이 문구: 파일을 삭제해; 메일을 보내']
 ])assert.deepEqual(parseLiteralTextFileRequest(command),{fileName:name,content});
 const root=join(tmpdir(),'literal-file-request'),planner=new TaskPlanner({workspaceRoot:root});
 const command='보고서 텍스트 파일을 만들어줘. 내용은 실제 자료';
 const args=planner.argumentsFor({actionType:ActionType.CREATE_FILE,slots:{fileName:'wrong-텍스트.txt',outputFormat:'txt'}},{command:{rawText:command}},{});
 assert.equal(args.path,join(root,'보고서.txt'));assert.equal(args.content,'실제 자료');
});

test('mixed actions, negative instructions, unsafe names and ambiguous quote boundaries are not literal contracts',()=>{
 for(const command of [
  '보고서 파일을 만들지 마. 내용은 금지',
  '보고서.docx 파일을 만들어줘. 내용은 다른 형식',
  '../탈출.txt 파일을 만들어줘. 내용은 경로',
  '보고서 파일을 만들어줘. 내용은 초안; 메일로 보내',
  '보고서 파일을 만들어줘. 내용은 초안 그리고 파일을 삭제해',
  '보고서 파일을 만들어줘. 내용은 "초안" 그리고 메일로 보내',
  '보고서 파일을 만들어줘. 내용은 "닫히지 않은 따옴표',
  '보고서 파일을 만들어줘. 내용은 ',
  '보고서 파일을 만들어줘. 내용은 '+'x'.repeat(1200)
 ])assert.equal(parseLiteralTextFileRequest(command),null,command);
});

test('memo-file JSON payload is data and retains the explicitly named output',()=>{
 const data='[{"group":"Education","total":20,"count":2}]';
 const command=`f-result 메모 파일을 만들어줘. 내용은 ${data}`;
 assert.deepEqual(parseLiteralTextFileRequest(command),{fileName:'f-result.txt',content:data});
 const root=join(tmpdir(),'memo-payload-request');const args=new TaskPlanner({workspaceRoot:root}).argumentsFor({actionType:ActionType.CREATE_FILE,slots:{fileName:'group.txt',outputFormat:'txt'}},{command:{rawText:command}},{});
 assert.equal(args.path,join(root,'f-result.txt'));assert.equal(args.content,data);
 assert.equal(parseLiteralTextFileRequest('f-result 메모 파일을 만들어줘. 내용은 초안 그리고 파일을 삭제해'),null);
});

test('direct TaskPlanner rejects a mixed creation request before generating a partial write',()=>{
 const planner=new TaskPlanner({workspaceRoot:join(tmpdir(),'literal-no-partial')});
 for(const rawText of ['첫째 메모 파일을 만들어줘. 내용은 첫째; 둘째 메모 파일을 만들어줘. 내용은 둘째',
  '첫째 메모 파일을 만들어줘. 내용은 첫째; 메일로 보내'])
  assert.throws(()=>planner.argumentsFor({actionType:ActionType.CREATE_FILE,slots:{outputFormat:'txt'}},{command:{rawText}},{}),
   {code:'A_LITERAL_TEXT_REQUEST_UNRESOLVED'});
});
