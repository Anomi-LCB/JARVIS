"""Pinned BrowserGym environment controls. Never reports JARVIS agent performance."""
import argparse,datetime,hashlib,importlib.metadata,json,platform,re,subprocess,time
from pathlib import Path
import gymnasium as gym
import browsergym.miniwob
from browsergym.core.action.highlevel import HighLevelActionSet
PIN='7fd85d71a4b60325c6585396ec4f48377d049838'
def run(args):
 root=Path(args.miniwob).resolve();output=Path(args.output).resolve()
 if output.exists():raise ValueError('OUTPUT_ALREADY_EXISTS')
 commit=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True).strip()
 if commit!=PIN:raise ValueError('MINIWOB_VERSION_MISMATCH')
 # A dirty task/evaluator changes the benchmark even when HEAD matches.
 if subprocess.check_output(['git','-C',str(root),'status','--porcelain'],text=True).strip():raise ValueError('MINIWOB_DIRTY')
 versions={p:importlib.metadata.version(p) for p in ['browsergym-core','browsergym-miniwob','playwright','gymnasium','numpy','greenlet']}
 if versions['browsergym-core']!='0.14.3' or versions['browsergym-miniwob']!='0.14.3':raise ValueError('BROWSERGYM_VERSION_MISMATCH')
 output.mkdir(parents=True,exist_ok=False);rows=[]
 for task in ['click-test','click-button','enter-text']:
  for seed in [17,43,89]:
   for driver in ['scripted-positive-control','scripted-negative-control']:
    start=time.monotonic();env=None;actions=[];reward=None;status='failed';error=None;terminated=False;truncated=False
    try:
     env=gym.make('browsergym/miniwob.'+task,headless=True,task_kwargs={'base_url':(root/'miniwob/html/miniwob').as_uri()+'/'},
      action_mapping=HighLevelActionSet(subsets=['bid'],strict=True,multiaction=False).to_python_code,
      pw_chromium_kwargs={'executable_path':str(Path(args.chrome).resolve())})
     obs,info=env.reset(seed=seed);page=env.unwrapped.page;goal=obs['goal'];negative=driver=='scripted-negative-control'
     if task=='enter-text':
      match=re.fullmatch('Enter "(.+)" into the text field and press Submit[.]',goal)
      if not match:raise ValueError('CONTROL_GOAL_UNRECOGNIZED')
      text='deliberately incorrect' if negative else match.group(1)
      bid=page.get_by_role('textbox').get_attribute('bid');action=f'fill({bid!r}, {text!r})'
      obs,reward,terminated,truncated,info=env.step(action);actions.append(action)
      bid=page.get_by_role('button',name='Submit',exact=True).get_attribute('bid');action=f'click({bid!r})'
     elif negative:
      action='noop()'
     else:
      name='Click Me!' if task=='click-test' else re.fullmatch('Click on the "(.+)" button[.]',goal).group(1)
      bid=page.get_by_role('button',name=name,exact=True).first.get_attribute('bid');action=f'click({bid!r})'
     obs,reward,terminated,truncated,info=env.step(action);actions.append(action)
     # No-op controls deliberately stop without completing; never count them as solved.
     status='completed' if reward==1 and terminated else 'failed'
     env.unwrapped.page.screenshot(path=str(output/f'{task}-{seed}-{driver}.png'))
    except Exception as exc:error={'type':type(exc).__name__,'message':str(exc)[:1000]}
    finally:
     if env:env.close()
    rows.append({'taskId':task,'seed':seed,'driver':driver,'status':status,'reward':reward,'terminated':bool(terminated),'truncated':bool(truncated),'actions':actions,'elapsedMs':round((time.monotonic()-start)*1000,3),'error':error,'actualCost':None,'jarvisAgentExecuted':False})
 report={'schemaVersion':'external-benchmark-controls-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z'),
  'benchmark':'BrowserGym/MiniWoB','taskCommit':commit,'versions':versions,'python':platform.python_version(),'os':platform.platform(),'chromeSha256':hashlib.sha256(Path(args.chrome).read_bytes()).hexdigest(),
  'runnerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'plannedSlots':18,'rows':rows,'jarvisPerformance':None,'officialLeaderboardScore':None,'realLifeCompletionRate':None}
 (output/'report.json').open('x',encoding='utf-8').write(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps({'slots':len(rows),'positivePassed':sum(r['status']=='completed' for r in rows if r['driver']=='scripted-positive-control'),'negativeSolved':sum(r['status']=='completed' for r in rows if r['driver']=='scripted-negative-control'),'errors':sum(r['error'] is not None for r in rows),'jarvisPerformance':None}))
 return 0 if all(r['error'] is None and (r['status']=='completed')==(r['driver']=='scripted-positive-control') for r in rows) else 1
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--miniwob',required=True);p.add_argument('--chrome',required=True);p.add_argument('--output',required=True);raise SystemExit(run(p.parse_args()))
