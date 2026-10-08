import test from 'node:test';import assert from 'node:assert/strict';
import {renderNotificationInbox} from '../src/ui/workspace/notification-inbox.js';
test('notification UI separates acknowledgement, escapes external fields and distinguishes unavailable from empty',()=>{
 const snapshot={unread:1,nextCursor:'cursor',items:[{eventId:'<event>',kind:'commitment-due-soon',dueAt:'<date>',createdAt:'now',seenAt:null},{eventId:'seen',kind:'mission-blocked',missionId:'<mission>',blockerCode:'<script>',seenAt:'now'}]};
 for(const language of ['ko','en']){const html=renderNotificationInbox({snapshot,language});assert.match(html,/data-notification-seen="&lt;event&gt;"/);assert.match(html,/data-notifications-more/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.equal((html.match(/data-notification-seen/g)||[]).length,1);}
 assert.match(renderNotificationInbox({}),/data-notifications-unavailable/);
 assert.match(renderNotificationInbox({snapshot:{items:[],unread:0}}),/현재 알림이 없습니다/);
 assert.match(renderNotificationInbox({loading:true}),/알림 확인 중/);
 const detailHtml=renderNotificationInbox({snapshot,detail:{title:'<script>secret()</script>',dueAt:'2026-10-05T01:00:00Z',sourceRef:'javascript:bad',state:'open',followUpState:'pending'}});
 assert.match(detailHtml,/data-notification-detail-panel/);assert.match(detailHtml,/&lt;script&gt;/);assert.doesNotMatch(detailHtml,/<script>|href="javascript:/);
});

test('replan controls require a stale terminal link and escape the prior request',()=>{
 const detail={eventId:'notice',title:'연결 작업',dueAt:'2026-10-05T01:00:00Z',sourceRef:'fixture',state:'open',followUpState:'pending',followUpId:'followup',revision:2,linkedWork:{dependencyCurrent:false,replanAllowed:true,status:'CANCELLED',request:{objective:'<script>bad()</script>',successCriteria:['원본 보존']}}};
 const html=renderNotificationInbox({snapshot:{items:[],unread:0},detail});assert.match(html,/data-followup-replan="followup"/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);assert.match(html,/계획 생성만 하며 실행하지 않습니다/);
 assert.doesNotMatch(renderNotificationInbox({snapshot:{items:[],unread:0},detail:{...detail,linkedWork:{...detail.linkedWork,dependencyCurrent:true}}}),/data-followup-replan=/);
 assert.doesNotMatch(renderNotificationInbox({snapshot:{items:[],unread:0},detail:{...detail,linkedWork:{...detail.linkedWork,replanAllowed:false}}}),/data-followup-replan=/);
});

test('replan draft follows only its selected followup and current revision',()=>{
 const detail={eventId:'notice',commitmentId:'commitment',title:'연결 작업',dueAt:'2026-10-05T01:00:00Z',sourceRef:'fixture',state:'open',followUpState:'pending',followUpId:'followup',revision:2,linkedWork:{dependencyCurrent:false,replanAllowed:true,status:'CANCELLED',request:{objective:'old objective',successCriteria:['old criterion']}}};
 const render=replanDraft=>renderNotificationInbox({snapshot:{items:[],unread:0},detail,replanDraft});
 const draft={followUpId:'followup',expectedRevision:2,objective:'새 요청 <script>',criteria:'보존 조건'};
 assert.match(render(draft),/새 요청 &lt;script&gt;/);assert.match(render(draft),/보존 조건/);
 assert.doesNotMatch(render({...draft,followUpId:'other'}),/새 요청/);assert.doesNotMatch(render({...draft,expectedRevision:1}),/새 요청/);
});

test('routine notices distinguish six outcomes without claiming acknowledgement is execution',()=>{
 const kinds=['routine-completed','routine-failed','routine-blocked','routine-needs-attention','routine-cancelled','routine-missed'];
 for(const language of ['ko','en']){
  const html=renderNotificationInbox({language,snapshot:{unread:6,items:kinds.map((kind,i)=>({eventId:'event-'+i,kind,occurrence:'2026-10-06T00:00:00Z',createdAt:'2026-10-06T00:00:00Z',seenAt:null}))}});
  assert.equal((html.match(/data-notification-seen=/g)||[]).length,6);assert.equal((html.match(/<time>/g)||[]).length,6);
  for(const word of language==='ko'?['예약 작업이 완료','예약 작업이 실패','준비 조건','추가 조치','실행 전 예약을 취소','실행 시기를 놓쳤']:['task completed','task failed','prerequisites','needs attention','cancelled before execution','time was missed'])assert.ok(html.includes(word));
  assert.doesNotMatch(html,/data-notification-detail=|data-task=/);
 }
});
