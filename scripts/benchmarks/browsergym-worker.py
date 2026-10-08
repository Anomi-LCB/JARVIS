"""Local pinned MiniWoB worker. Typed DOM actions only; no arbitrary Python/JS."""
import argparse,json,os,re,subprocess,sys,uuid
from pathlib import Path
import gymnasium as gym
import browsergym.miniwob
from browsergym.core.action.highlevel import HighLevelActionSet
p=argparse.ArgumentParser();p.add_argument('--miniwob',required=True);p.add_argument('--chrome',required=True);p.add_argument('--state',required=True);args=p.parse_args()
root=Path(args.miniwob).resolve();state=Path(args.state).resolve();env=None;episode=None;revision=0;receipts={};current=None
if subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()!='7fd85d71a4b60325c6585396ec4f48377d049838':raise ValueError('TASK_VERSION_MISMATCH')
if subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True).strip():raise ValueError('TASK_CHECKOUT_DIRTY')
def snapshot(obs):
 page=env.unwrapped.page
 elements=page.locator('button,input').evaluate_all('(es)=>es.filter(e=>e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0).map(e=>({bid:e.getAttribute("bid"),role:e.tagName==="BUTTON"?"button":"textbox",name:e.tagName==="BUTTON"?e.textContent:"",value:e.tagName==="INPUT"?e.value:""}))')
 return {'episodeId':episode,'revision':revision,'goal':obs['goal'],'elements':elements,'url':page.url}
def save(value):
 tmp=state.with_suffix('.pending');tmp.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8');os.replace(tmp,state)
try:
 for line in sys.stdin:
  rpc=None
  try:
   if len(line)>64000:raise ValueError('REQUEST_TOO_LARGE')
   rpc=json.loads(line);op=rpc.get('op')
   if op=='close':break
   if op=='reset':
    if set(rpc)!={'id','op','task','seed'} or rpc['task'] not in ['click-test','click-button','enter-text'] or rpc['seed'] not in [17,43,89]:raise ValueError('RESET_INVALID')
    if env:env.close()
    episode=str(uuid.uuid4());revision=0;receipts={}
    env=gym.make('browsergym/miniwob.'+rpc['task'],headless=True,task_kwargs={'base_url':(root/'miniwob/html/miniwob').as_uri()+'/'},action_mapping=HighLevelActionSet(subsets=['bid'],strict=True,multiaction=False).to_python_code,pw_chromium_kwargs={'executable_path':str(Path(args.chrome).resolve())})
    obs,_=env.reset(seed=rpc['seed']);env.unwrapped.context.route('**/*',lambda route:route.continue_() if route.request.url.startswith('file:') else route.abort())
    current={'version':'browsergym-worker-state-v1','public':snapshot(obs),'receipt':None};save(current);result=current['public']
   elif op=='step':
    if set(rpc)!={'id','op','request'}:raise ValueError('RPC_INVALID')
    request=rpc['request'];key=request.get('requestId');encoded=json.dumps(request,sort_keys=True,ensure_ascii=False)
    if key in receipts:
     old,value=receipts[key]
     if old!=encoded:raise ValueError('IDEMPOTENCY_CONFLICT')
     result=value
    else:
     if not env or not current or current.get('receipt',{} ) and current['receipt']['terminated']:raise ValueError('EPISODE_TERMINATED')
     if request.get('episodeId')!=episode or request.get('expectedRevision')!=revision:raise ValueError('STATE_REVISION_CHANGED')
     if set(request)!={'requestId','episodeId','expectedRevision','action'} or not isinstance(key,str) or not re.fullmatch('[A-Za-z0-9_-]{1,120}',key):raise ValueError('REQUEST_INVALID')
     action=request['action'];kind=action.get('kind')
     if kind=='noop' and set(action)=={'kind'}:code='noop()'
     elif kind in ['click','fill'] and set(action)==({'kind','bid'} if kind=='click' else {'kind','bid','text'}):
      bid=action['bid']
      if not isinstance(bid,str) or not re.fullmatch('[a-zA-Z0-9_-]{1,64}',bid):raise ValueError('BID_INVALID')
      if kind=='fill' and (not isinstance(action['text'],str) or len(action['text'])>1024):raise ValueError('TEXT_INVALID')
      code=f'click({bid!r})' if kind=='click' else f'fill({bid!r}, {action["text"]!r})'
     else:raise ValueError('ACTION_UNSUPPORTED')
     expected=(root/'miniwob/html/miniwob'/ (env.unwrapped.task.subdomain+'.html')).as_uri()
     if env.unwrapped.page.url!=expected:raise ValueError('PAGE_SCOPE_CHANGED')
     obs,reward,terminated,truncated,_=env.step(code);revision+=1
     if env.unwrapped.page.url!=expected:raise ValueError('PAGE_SCOPE_CHANGED')
     result={'version':'browsergym-action-receipt-v1','request':request,'postState':snapshot(obs),'reward':float(reward),'terminated':bool(terminated),'truncated':bool(truncated)}
     current={'version':'browsergym-worker-state-v1','public':result['postState'],'receipt':result};save(current);receipts[key]=(encoded,result)
   elif op=='reconcile':
    if set(rpc)!={'id','op','request'}:raise ValueError('RPC_INVALID')
    request=rpc['request'];key=request.get('requestId');encoded=json.dumps(request,sort_keys=True,ensure_ascii=False)
    if request.get('episodeId')!=episode:result={'status':'unresolved','reason':'episode-changed'}
    elif key not in receipts:result={'status':'unresolved','reason':'receipt-unavailable'}
    else:
     old,value=receipts[key]
     if old!=encoded:raise ValueError('IDEMPOTENCY_CONFLICT')
     result={'status':'matched','receipt':value}
   elif op=='observe':
    if set(rpc)!={'id','op'}:raise ValueError('RPC_INVALID')
    result=current['public'] if current else None
   else:raise ValueError('OP_UNSUPPORTED')
   print(json.dumps({'id':rpc['id'],'result':result},ensure_ascii=False),flush=True)
  except Exception as exc:print(json.dumps({'id':rpc.get('id') if isinstance(rpc,dict) else None,'error':{'code':str(exc)[:1000],'type':type(exc).__name__}}),flush=True)
finally:
 if env:env.close()
