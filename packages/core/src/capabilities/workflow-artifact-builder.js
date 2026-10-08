import {createHash} from 'node:crypto';
import {readFile, realpath} from 'node:fs/promises';
import {isAbsolute, relative, resolve, sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const sha = value => createHash('sha256').update(value).digest('hex');
const reject = code => { throw Object.assign(new Error(code), {code}); };
const builtRuntimeArtifacts = new WeakMap();
const admittedDefinitions = new WeakSet();

/** Build-time only. No runtime dependency installation, account access or activation. */
export async function buildWorkflowEvaluationArtifact({projectRoot, esbuildPath, mode='evaluation'}) {
  if(!['evaluation','runtime'].includes(mode)) reject('WORKFLOW_BUILD_MODE_INVALID');
  const root = await realpath(projectRoot);
  const {build, version} = await import(pathToFileURL(resolve(esbuildPath)).href);
  if (version !== '0.25.11') reject('WORKFLOW_BUILD_TOOL_VERSION_MISMATCH');
  const snapshots = new Map();
  const withinRoot = async file => {
    const actual = await realpath(file), name = relative(root, actual);
    if (name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) reject('WORKFLOW_BUILD_SOURCE_OUTSIDE_PROJECT');
    return {actual, name: name.split(sep).join('/')};
  };
  const result = await build({
    absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node24',
    write: false, metafile: true, minify: false, treeShaking: false, logLevel: 'silent',
    stdin: {resolveDir: root, sourcefile: 'workflow-evaluation-entry.mjs', contents: mode==='runtime' ? `
      import {createLocalWorkflowCapabilityPackage} from './apps/runtime-compose/src/workflow-capability-package.js';
      export {createLocalWorkflowCapabilityPackage};
      export function createAdapter(context = {}) { return createLocalWorkflowCapabilityPackage().createAdapter(context); }
    ` : `
      import {LocalWorkflowToolAdapter} from './apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js';
      import {mkdtemp, readFile} from 'node:fs/promises';
      import {createHash} from 'node:crypto';
      export {LocalWorkflowToolAdapter};
      // Evaluation projection only: actual adapter and actual scratch-file bytes.
      // This does not represent Core/E/G/F, rollback, or a live Windows session.
      export function createAdapter() {
        return {async execute(args, packet = {}) {
          const root = await mkdtemp('/tmp/workflow-evaluation-');
          const adapter = new LocalWorkflowToolAdapter({allowedRoots:[root], clock:()=>new Date('2026-10-06T00:00:00.000Z')});
          const result = await adapter.execute({...args, workspaceRoot:root}, packet);
          if(result.status !== 'success') return {status:result.status, errorCode:result.error?.code ?? null};
          const files = [];
          for(const item of result.evidence.manifest) {
            const bytes = await readFile(item.path);
            const digest = createHash('sha256').update(bytes).digest('hex');
            if(digest !== item.sha256 || bytes.length !== item.size) throw new Error('EVALUATION_PUBLICATION_CHANGED');
            files.push({name:item.path.slice(root.length+1), text:bytes.toString('utf8'), sha256:digest, size:bytes.length});
          }
          files.sort((a,b)=>a.name.localeCompare(b.name));
          return {status:result.status, nodeCount:result.evidence.workflow.nodeCount,
            receiptCount:result.evidence.workflow.receipts.length, files};
        }};
      }
    `},
    plugins: [{name: 'snapshot-exact-project-inputs', setup(builder) {
      builder.onLoad({filter:/\.[cm]?js$/}, async ({path}) => {
        const file = await withinRoot(path), bytes = await readFile(file.actual);
        const prior = snapshots.get(file.name);
        if(prior && prior.sha256 !== sha(bytes)) reject('WORKFLOW_BUILD_SOURCE_CHANGED');
        snapshots.set(file.name, {path:file.name, sha256:sha(bytes), size:bytes.length});
        return {contents:bytes.toString('utf8'), loader:'js', resolveDir:resolve(file.actual, '..')};
      });
    }}]
  });
  for(const name of Object.keys(result.metafile.inputs)) {
    if(name === 'workflow-evaluation-entry.mjs') continue;
    const file = await withinRoot(resolve(root,name));
    if(!snapshots.has(file.name)) reject('WORKFLOW_BUILD_INPUT_NOT_SNAPSHOTTED');
  }
  for(const file of snapshots.values()) if(sha(await readFile(resolve(root,file.path))) !== file.sha256) reject('WORKFLOW_BUILD_SOURCE_CHANGED');
  for(const output of Object.values(result.metafile.outputs)) for(const dependency of output.imports) {
    if(!dependency.external || !dependency.path.startsWith('node:')) reject('WORKFLOW_BUILD_UNBUNDLED_DEPENDENCY');
  }
  const sourceManifest = [...snapshots.values()].sort((a,b)=>a.path.localeCompare(b.path));
  if(!sourceManifest.some(f=>f.path==='apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js')) reject('WORKFLOW_BUILD_ADAPTER_MISSING');
  const artifactSource = result.outputFiles[0].text;
  const artifact = {schemaVersion:'jarvis-workflow-evaluation-artifact-v1', mode, buildTool:{name:'esbuild',version},
    artifactSource, artifactSha256:sha(artifactSource), sourceManifest, sourceManifestSha256:sha(JSON.stringify(sourceManifest)),
    scope:mode==='runtime' ? 'Exact bundled runtime package and adapter factory; activation requires source revalidation.' : 'Actual local workflow adapter with scratch-file result projection; not active runtime admission or full Core/E/G/F proof.'};
  if(mode==='runtime') builtRuntimeArtifacts.set(artifact,{root,snapshot:structuredClone(artifact)});
  return artifact;
}

/** Only local bytes built here from the fixed reviewed entry can be admitted. */
export async function loadBuiltWorkflowCapability(artifact) {
  const proof=builtRuntimeArtifacts.get(artifact);
  if(!proof || JSON.stringify(proof.snapshot)!==JSON.stringify(artifact)) reject('WORKFLOW_RUNTIME_BUILD_NOT_ADMITTED');
  await verifyWorkflowEvaluationSources(proof.snapshot,proof.root);
  const module=await import(`data:text/javascript;base64,${Buffer.from(proof.snapshot.artifactSource).toString('base64')}`);
  const definition=module.createLocalWorkflowCapabilityPackage();
  definition.createAdapter=module.createAdapter;
  definition.artifactSource=proof.snapshot.artifactSource;
  definition.artifactSha256=proof.snapshot.artifactSha256;
  definition.sourceManifestSha256=proof.snapshot.sourceManifestSha256;
  const freeze=value=>{if(value && typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
  freeze(definition); admittedDefinitions.add(definition);
  return definition;
}

export function assertBuiltWorkflowCapability(definition) {
  if(!admittedDefinitions.has(definition)) reject('WORKFLOW_RUNTIME_DEFINITION_NOT_ADMITTED');
  return definition;
}

/** Host release identity only. Both execution and retained judge must already
 * be admitted fixed-entry bundles; this cannot admit caller-supplied functions. */
export function identifyBuiltWorkflowCapability(definition, {packageId,version,skillId}, verifierDefinition=definition) {
  assertBuiltWorkflowCapability(definition);assertBuiltWorkflowCapability(verifierDefinition);
  if(typeof packageId!=='string'||!packageId.trim()||!/^\d+\.\d+\.\d+$/u.test(version??'')||typeof skillId!=='string'||!skillId.trim())reject('WORKFLOW_RUNTIME_IDENTITY_INVALID');
  if(definition.verifierId!==verifierDefinition.verifierId||definition.verifierFingerprint!==verifierDefinition.verifierFingerprint
    ||JSON.stringify(definition.evidenceSchema)!==JSON.stringify(verifierDefinition.evidenceSchema))reject('WORKFLOW_RUNTIME_VERIFIER_CONTRACT_CHANGED');
  const result=Object.freeze({...definition,packageId,version,verifyEvidence:verifierDefinition.verifyEvidence,
    skill:Object.freeze({...definition.skill,skillId,version})});
  admittedDefinitions.add(result);return result;
}

export async function verifyWorkflowEvaluationSources(artifact, projectRoot) {
  if(!Array.isArray(artifact?.sourceManifest) || artifact.sourceManifest.length<1
    || new Set(artifact.sourceManifest.map(f=>f?.path)).size!==artifact.sourceManifest.length
    || artifact.sourceManifest.some(f=>typeof f?.path!=='string'||!f.path||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/.test(f.sha256??''))) reject('WORKFLOW_BUILD_MANIFEST_INVALID');
  if(sha(artifact.artifactSource) !== artifact.artifactSha256 || sha(JSON.stringify(artifact.sourceManifest)) !== artifact.sourceManifestSha256) reject('WORKFLOW_BUILD_MANIFEST_MISMATCH');
  const root = await realpath(projectRoot);
  for(const file of artifact.sourceManifest) {
    const actual = await realpath(resolve(root,file.path)), name = relative(root,actual);
    if(name==='..'||name.startsWith(`..${sep}`)||isAbsolute(name)) reject('WORKFLOW_BUILD_SOURCE_OUTSIDE_PROJECT');
    const bytes = await readFile(actual);
    if(bytes.length!==file.size || sha(bytes)!==file.sha256) reject('WORKFLOW_BUILD_SOURCE_CHANGED');
  }
  return true;
}
