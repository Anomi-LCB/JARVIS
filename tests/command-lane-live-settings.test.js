import assert from 'node:assert/strict';
import test from 'node:test';
import {classifyCommandLane} from '../packages/shared/src/command-lane.js';
import {CoreFacade} from '../packages/core/src/core-facade.js';
import {createCoreServer} from '../packages/core/src/main.mjs';
import {listenOnFetchSafePort} from '../packages/shared/src/http.js';
for(const command of [
  '이번 주 캘린더를 조회하고 겹친 약속을 알려줘.',
  '연결된 캘린더를 읽어줘.',
  '캘린더에 임시 일정을 등록해.',
  '이미 등록된 캘린더 항목을 취소해.',
  '조회해줘, 이번 주 캘린더를.',
  '브라우저 앱 설정을 열어 알림을 끄고 저장된 상태를 확인해.',
  '앱 설정에서 알림을 꺼줘.',
  '프로그램 설정을 변경해서 자동 저장을 켜줘.'
])test(`live setting/account action enters Mission: ${command}`,()=>{
  const route=classifyCommandLane(command);
  assert.equal(route.lane,'mission');
  assert.equal(route.asynchronous,true);
  assert.ok(route.reasonCodes.includes('long-running-or-privileged-stage'));
});
for(const command of [
  '캘린더 초안 한 문장을 작성해줘.',
  '다음 주 행사 일정을 캘린더에 등록할 초안으로 작성해줘.',
  '주일 행사 일정의 초안을 문장으로 작성해줘. 캘린더에 등록하지는 마.',
  '브라우저의 장점을 한 문장으로 설명해줘.',
  '앱 이름 세 가지 제안해줘.',
  '인사말을 번역해줘.'
])test(`simple draft/explanation remains task: ${command}`,()=>assert.equal(classifyCommandLane(command).lane,'task'));
test('lane escalation does not manufacture execution permission or tool actions',()=>{
  const route=classifyCommandLane('캘린더에 새 일정을 등록해.');
  assert.equal(route.lane,'mission');
  assert.equal('executionAuthority' in route,false);
  assert.equal('allowed' in route,false);
  assert.equal('actions' in route,false);
});
test('a negated registration does not suppress a real calendar read or later correction',()=>{
  for(const rawText of ['캘린더에 등록하지 말고 기존 약속을 조회해.', '캘린더에 등록하지 마. 정정할게. 캘린더에 오후 두 시로 등록해.']){
    assert.equal(classifyCommandLane(rawText).lane,'mission');
  }
});
test('actual Core HTTP denies quick-task planning for live calendar and settings requests',async()=>{
  const facade=new CoreFacade();
  let taskCalls=0;
  facade.createTask=()=>{taskCalls++;throw new Error('quick-task planning must not execute');};
  const server=createCoreServer(facade),address=await listenOnFetchSafePort(server);
  try{
    for(const rawText of ['이번 주 캘린더를 조회하고 겹친 약속을 알려줘.','브라우저 앱 설정을 열어 알림을 끄고 저장된 상태를 확인해.']){
      const response=await fetch(`http://127.0.0.1:${address.port}/tasks`,{
        method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rawText})
      });
      const body=await response.json();
      assert.equal(response.status,409);
      assert.equal(body.error.code,'A_COMMAND_REQUIRES_MISSION');
      assert.equal(body.recommendedEndpoint,'/missions');
      assert.equal(body.routing.lane,'mission');
    }
    assert.equal(taskCalls,0);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
