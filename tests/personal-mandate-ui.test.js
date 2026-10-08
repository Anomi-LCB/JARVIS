import test from 'node:test';
import assert from 'node:assert/strict';
import {createPersonalMandatePanel} from '../src/ui/personal-mandates.js';
import {escape} from '../src/ui/connections/connection-center.js';

test('unobserved and failed mandate lists are never represented as an empty successful observation',async()=>{
 let response={items:[]},failure=false;
 const p=createPersonalMandatePanel({request:async()=>{if(failure)throw Error('offline');return response;},changed:()=>{},escape,initialOpen:true});
 assert.match(p.render(),/목록 미확인/);assert.doesNotMatch(p.render(),/등록 0개/);
 await p.refresh();assert.match(p.render(),/등록 0개/);assert.match(p.render(),/등록한 위임이 없습니다/);
 response={items:[{id:'test',action:'read',target:'<img src=x>',validFrom:'2098-01-01',expiresAt:'2099-01-01',currency:'KRW',maxAmountMinor:10}]};
 await p.refresh();assert.match(p.render(),/시작 전/);assert.match(p.render(),/&lt;img src=x&gt;/);assert.doesNotMatch(p.render(),/<img/);
 failure=true;await p.refresh();assert.match(p.render(),/목록 미확인/);assert.match(p.render(),/관리 인증/);assert.doesNotMatch(p.render(),/data-mandate-id=/);
});

test('a registered quota exposes target, expiry, limits and revocation without claiming provider execution',async()=>{
 const item={id:'quota-id',action:'mission.run',target:'jarvis:missions',validFrom:'2020-01-01',expiresAt:'2099-01-01',maxAmountMinor:0,currency:'KRW',revoked:true,budget:{totalMinor:0,usedOrHeldCalls:2,maxCalls:10,remainingCalls:8}};
 const p=createPersonalMandatePanel({request:async()=>({items:[item]}),changed:()=>{},escape});await p.refresh();
 const html=p.render();for(const text of ['철회됨','jarvis:missions','사용·예약 2 / 10회','남은 8회','실제 결제나 AI 사용료가 무료라는 의미는 아닙니다'])assert.ok(html.includes(text));
 assert.doesNotMatch(html,/data-mandate-revoke=/);
 p.invalidate();assert.match(p.render(),/목록 미확인/);assert.doesNotMatch(p.render(),/data-mandate-id=/);
});
