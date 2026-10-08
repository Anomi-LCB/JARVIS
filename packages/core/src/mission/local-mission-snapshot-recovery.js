import { createHash } from 'node:crypto';
import { openSync, closeSync, fstatSync, readSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => {
  const delta = relative(root, path);
  return delta !== '..' && !delta.startsWith('..\\') && !delta.startsWith('../') && !isAbsolute(delta);
};
const sameFile=(a,b)=>a.isFile()&&b.isFile()&&a.dev===b.dev&&a.ino===b.ino
  &&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;

/** Reconstruct evidence from the local store. Never dispatch, recreate a remote
 * session, overwrite a live Mission, or treat a recovered snapshot as completion. */
export function createLocalMissionSnapshotRecovery({ store, allowedRoots }) {
  const roots = allowedRoots.map(root => resolve(root));
  return ({ missionId }) => {
    const matches = (store.load?.() ?? []).filter(item => item.missionId === missionId);
    if (matches.length !== 1) return { status: 'unavailable', snapshotSha256: null, missingArtifactIds: [] };
    const mission = matches[0];
    const artifacts = (mission.observations ?? []).flatMap(observation => observation.artifacts ?? []);
    const missing = new Set();
    let verifiedArtifacts = 0;
    for (const [index, artifact] of artifacts.entries()) {
      const artifactId = artifact?.pathHash ?? `observation-artifact-${index}`;
      let fd;
      try {
        if (artifact?.outsideAllowedRoots !== false || !Number.isInteger(artifact.rootIndex)
          || !roots[artifact.rootIndex] || typeof artifact.relativePath !== 'string'
          || !/^[a-f0-9]{64}$/u.test(artifact.contentSha256 ?? '')) throw new Error('unverified reference');
        const root = roots[artifact.rootIndex];
        const path = resolve(root, artifact.relativePath);
        const physicalRoot=realpathSync(root),actual=realpathSync(path);
        if (!inside(root, path) || hash(path) !== artifact.pathHash
          || !inside(physicalRoot, actual)) throw new Error('outside root');
        fd = openSync(actual, 'r');
        const before = fstatSync(fd,{bigint:true});
        if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw new Error('invalid file');
        const assertPublished=()=>{
          if(realpathSync(root)!==physicalRoot||realpathSync(path)!==actual
            ||!sameFile(before,statSync(path,{bigint:true})))throw new Error('changed artifact identity');
        };
        // An opened handle can retain an old file after rename/replacement.
        // Reject changed publication/root identity before reading any bytes.
        assertPublished();
        const digest=createHash('sha256'),buffer=Buffer.alloc(64*1024);let offset=0;
        while(true){
          const count=readSync(fd,buffer,0,Math.min(buffer.length,Number(before.size)-offset+1),offset);
          if(count===0)break;
          offset+=count;if(offset>Number(before.size))throw new Error('artifact grew');
          digest.update(buffer.subarray(0,count));
        }
        const after = fstatSync(fd,{bigint:true});
        assertPublished();
        if (!sameFile(before,after)||offset!==Number(before.size)
          ||digest.digest('hex')!==artifact.contentSha256) throw new Error('changed artifact');
        verifiedArtifacts += 1;
      } catch { missing.add(String(artifactId)); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    return { status: 'restored', snapshotSha256: hash(JSON.stringify(mission)),
      missingArtifactIds: [...missing], verifiedArtifacts, evidenceOnly: true, automaticResume: false };
  };
}
