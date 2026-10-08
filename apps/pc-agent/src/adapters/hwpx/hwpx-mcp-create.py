"""Create an HWPX through the installed, policy-allowlisted MCP surface, offline."""
import importlib.util, json, os, sys
from pathlib import Path
from datetime import timedelta
import anyio
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT=Path(__file__).resolve().parents[5]
spec=importlib.util.spec_from_file_location('hwpx_policy',ROOT/'scripts/hwpx-mcp-smoke.py')
policy_tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(policy_tools)
oracle_spec=importlib.util.spec_from_file_location('hwpx_content_oracle',Path(__file__).with_name('hwpx-content-verifier.py'))
oracle=importlib.util.module_from_spec(oracle_spec);oracle_spec.loader.exec_module(oracle)
guard_spec=importlib.util.spec_from_file_location('hwpx_process_guard',Path(__file__).with_name('process-job-guard.py'))
process_guard=importlib.util.module_from_spec(guard_spec);guard_spec.loader.exec_module(process_guard)

async def create(payload):
    policy=policy_tools.load_json(ROOT/'config/hwpx-mcp-policy.json')
    config_path=policy_tools.default_mcp_config(policy)
    server=policy_tools.select_server(policy_tools.load_json(config_path))
    policy_tools.validate_policy(policy,server)
    target=Path(payload['outputPath']).resolve(); root=target.parent
    if target.suffix.lower()!='.hwpx' or target.exists(): raise RuntimeError('new-hwpx-output-required')
    blocks=payload['document']['blocks']
    if len(blocks)>40: raise RuntimeError('hwpx-block-limit-exceeded')
    # Reuse pinned cached packages; do not install or refresh packages during a command.
    args=[]; it=iter(server['args'])
    for arg in it:
        if arg=='--refresh-package': next(it);continue
        args.append(arg)
    env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','USERPROFILE','LOCALAPPDATA','APPDATA','TEMP','TMP','COMSPEC','PATHEXT'}}
    env.update(server.get('env',{}))
    env.update({'UV_OFFLINE':'1','HWPX_AUTOMATION_WORKSPACE_ROOTS':json.dumps([str(root)]),'HWPX_AUTOMATION_WORKFLOW_STORE':str(root/'workflow.sqlite3'),'HWPX_AUTOMATION_ADVANCED':'0','LOG_LEVEL':'ERROR'})
    params=StdioServerParameters(command=server['command'],args=['--offline',*args],env=env,cwd=root)
    receipts=[]
    async with stdio_client(params,errlog=sys.stderr) as (reader,writer):
        async with ClientSession(reader,writer) as session:
            await session.initialize()
            async def call(name,args):
                if name not in policy['routing']['allowedTools']: raise RuntimeError('tool-not-allowlisted:'+name)
                result=policy_tools.structured(await session.call_tool(name,args,read_timeout_seconds=timedelta(seconds=40)))
                if result.get('openSafety',{}).get('ok') is False: raise RuntimeError('hwpx-open-safety-failed')
                receipts.append(name)
                return result
            health=await call('mcp_server_health',{})
            if health.get('toolSurface',{}).get('status')!='ok' or not health.get('capability',{}).get('ok'): raise RuntimeError('hwpx-capability-not-ready')
            await call('create_document',{'filename':str(target),'title':payload['document'].get('title',''),'author':'JARVIS'})
            title=payload['document'].get('title')
            if title: await call('add_paragraph',{'filename':str(target),'text':title,'idempotency_key':'title'})
            for index,block in enumerate(blocks):
                if block.get('type')=='table':
                    data=[block['columns'],*block['rows']]
                    if not data: raise RuntimeError('empty-table')
                    await call('add_table',{'filename':str(target),'rows':len(data),'cols':max(map(len,data)),'data':[[str(v) for v in row] for row in data],'idempotency_key':f'block-{index}'})
                elif block.get('type')=='bullets':
                    for item_index,item in enumerate(block['items']):
                        await call('add_paragraph',{'filename':str(target),'text':'• '+item,'idempotency_key':f'block-{index}-item-{item_index}'})
                elif block.get('type') in {'paragraph','heading'}:
                    await call('add_paragraph',{'filename':str(target),'text':str(block.get('text','')),'idempotency_key':f'block-{index}'})
                else: raise RuntimeError('hwpx-block-type-unsupported')
    verified=oracle.verify_document(target,payload['document'])
    if target.stat().st_size>policy['limits']['maximumOutputBytes']: raise RuntimeError('hwpx-size-limit-exceeded')
    return {'engine':'policy-allowlisted-hwpx-mcp','status':'verified','toolCalls':receipts,**verified,'coreVersion':health['pythonHwpxVersion']}

async def bounded_create(payload):
    with anyio.fail_after(75):
        return await create(payload)

if __name__=='__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    try:
        payload=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
        guard=process_guard.install_process_guard()
        Path(payload['outputPath']).parent.joinpath('process-guard.json').write_text(json.dumps(guard),encoding='utf-8')
        print(json.dumps({**anyio.run(bounded_create,payload),'processGuard':guard},ensure_ascii=False))
    except Exception as error:
        print(json.dumps({'status':'failed','error':str(error)},ensure_ascii=False));sys.exit(1)
