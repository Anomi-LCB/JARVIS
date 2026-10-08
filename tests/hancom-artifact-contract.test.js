import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { HwpCreateToolAdapter } from '../apps/pc-agent/src/pc-agent-runtime.js';
import { hancomActualOutputPaths, hancomPublicationPaths } from '../apps/pc-agent/src/adapters/hwpx/artifact-contract.js';

test('Hancom manifest fixes document, render intent and bounded reservations without claiming unused pages', () => {
  const adapter = new HwpCreateToolAdapter(), path = join(tmpdir(), 'document.hwpx');
  const prepared = adapter.preparePublication({ path, title: '원래 요구', verifyRendering: true, blocks: [{type:'paragraph',text:'내용'}] });
  assert.equal(prepared.paths.length, 54);
  const result = { nativeRendering: { status: 'passed', actualRenderingExecuted: true, pageCount: 2,
    outputDirectory: prepared.renderDirectory, manifestPath: join(prepared.renderDirectory, 'manifest.json') } };
  assert.deepEqual(hancomActualOutputPaths(prepared, result), [path,join(prepared.renderDirectory,'manifest.json'),
    join(prepared.renderDirectory,'document.pdf'),join(prepared.renderDirectory,'page-1.png'),join(prepared.renderDirectory,'page-2.png'),join(prepared.renderDirectory,'structure.hwpx')]);
  for (const count of [0,51,-1,1.5,'1',null]) assert.throws(() => hancomActualOutputPaths(prepared, {nativeRendering:{...result.nativeRendering,pageCount:count}}));
  for (const patch of [{paths:[path]},{maxRenderPages:51},{verifyRendering:false},{manifestVersion:'other'}])
    assert.throws(() => hancomActualOutputPaths({...prepared,...patch},result));
  assert.deepEqual(hancomPublicationPaths(path,null),[path]);
});

for (const format of ['hwp','hwpx']) test(`${format} binds full manifest before authoring and blocks a rejected plan without files`, async t => {
  const root = await mkdtemp(join(tmpdir(),'jarvis-hancom-manifest-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const adapter = new HwpCreateToolAdapter({allowedRoots:[root]}),args={path:join(root,`document.${format}`),verifyRendering:true,title:'원래 요청'};
  let calls=0;
  const result=await adapter.execute(args,{}, {beforeArtifactWrite(plan){calls++;assert.deepEqual(plan,{paths:adapter.preparePublication(args).paths,prepared:adapter.preparePublication(args)});throw Error('original-plan-changed');}});
  assert.equal(calls,1);assert.equal(result.status,'blocked');assert.equal(result.error,'original-plan-changed');assert.deepEqual(await readdir(root),[]);
});

for (const format of ['hwp','hwpx']) test(`${format} malformed document returns a structured preflight denial`, async t => {
  const root=await mkdtemp(join(tmpdir(),'jarvis-hancom-bad-block-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const result=await new HwpCreateToolAdapter({allowedRoots:[root]}).execute({path:join(root,`document.${format}`),blocks:[{type:'unknown',text:'unsupported'}]});
  assert.equal(result.status,'blocked');assert.match(result.error,/B_DOCUMENT_BLOCK_TYPE_UNSUPPORTED/);assert.deepEqual(await readdir(root),[]);
});
