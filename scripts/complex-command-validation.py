import json,re
from pathlib import Path
root=Path(__file__).resolve().parents[1]
out=root/'artifacts/complex-command-audit/2026-09-03-report'
review=json.loads((out/'independent-review.json').read_text(encoding='utf-8'))
log=(out/'regression.log').read_text(encoding='utf-8')
runtime=json.loads((out/'runtime-status.json').read_text(encoding='utf-8-sig'))
journals=json.loads((out/'production-journal-after.json').read_text(encoding='utf-8-sig'))
browser=json.loads((out/'browser-review.json').read_text(encoding='utf-8'))
latest_results=[json.loads(Path(item['attempts'][-1]['resultPath']).read_text(encoding='utf-8')) for item in review]
match=re.search(r'tests\s+(\d+).*?pass\s+(\d+).*?fail\s+(\d+)',log,re.S)
validation={
 'validationVersion':'jarvis-complex-command-validation-v1',
 'commandResults':{status:sum(x['final']==status for x in review) for status in ['성공','예상된 중단','부분 완료','실패','미실행']},
 'regression':{'tests':int(match[1]),'passed':int(match[2]),'failed':int(match[3])} if match else {'parseError':True},
 'buildPassed':'Built static JARVIS executive console into dist/.' in (out/'build.log').read_text(encoding='utf-8'),
 'runtime':{'status':runtime['status'],'operational':runtime['operational'],'mutatingExecutionAllowed':runtime['mutatingExecutionAllowed'],'services':[{'id':s['id'],'healthy':s['healthy'],'identityVerified':s['identityVerified']} for s in runtime['services']]},
 'productionJournalsUnchanged':all(x['Unchanged'] for x in journals),
 'interaction':{
   'approvalGates':sum(g.get('type')=='action_approval' for item in latest_results for g in item.get('mission',{}).get('gates',[])),
   'clarificationGates':sum(g.get('type')=='clarification' for item in latest_results for g in item.get('mission',{}).get('gates',[])),
   'clarificationCase':'18'
 },
 'browserChecks':browser['checks'],
 'browserErrors':browser['errors']
}
(out/'validation.json').write_text(json.dumps(validation,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(validation,ensure_ascii=False,indent=2))
if validation['commandResults']!={'성공':19,'예상된 중단':1,'부분 완료':0,'실패':0,'미실행':0} or validation['regression'].get('failed')!=0 or not validation['buildPassed'] or runtime['status']!='ready' or not validation['productionJournalsUnchanged'] or not all(c['pass'] for c in browser['checks']): raise SystemExit(1)
