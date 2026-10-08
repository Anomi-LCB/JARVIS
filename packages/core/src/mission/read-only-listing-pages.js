import { readdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const localConstraints = new Set([
  '허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.',
  '외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.'
]);
const grammar = /^(작업 폴더의 파일 목록을 (?:보여줘|확인해줘)\.)\s*(파일을 생성하거나 수정하지 마\.)$/u;
const same = (a,b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const reject = reason => ({applicable:true,passed:false,status:'unverified',reasons:[reason],checks:[]});

function inspectTrace(mission, allowedRoots) {
  const source = grammar.exec(mission?.objective ?? '');
  if (!source) return {applicable:false};
  const contract = mission.goalContract;
  if (contract?.objective !== mission.objective || contract.requirements?.length !== 2
    || !contract.requirements.every((r,i) => r.text.trim() === source[i+1])
    || contract.contradictions?.length || contract.revisionChange || contract.referenceSubstitutionApplied)
    return reject('listing-source-contract-unbound');
  if ((mission.constraints ?? []).some(c => !localConstraints.has(c.statement ?? c))) return reject('listing-constraint-unsupported');
  const actions = (mission.waves ?? []).flatMap(w => w.actions ?? []);
  if (!actions.length || actions.length > 20 || new Set(actions.map(a => a.actionId)).size !== actions.length)
    return reject('listing-action-scope-not-exclusive');
  if (!allowedRoots.length) return reject('listing-root-missing');
  const root = resolve(allowedRoots[0]), receipts = [];
  for (const action of actions) {
    const dispatch = action.operation?.dispatch;
    const observation = (mission.observations ?? []).find(o => o.observationId === action.observationId);
    if (action.status !== 'succeeded' || action.actualToolName !== 'filesystem.listFiles'
      || dispatch?.toolName !== action.actualToolName || dispatch.taskId !== action.taskId
      || observation?.actionId !== action.actionId || observation.taskId !== action.taskId
      || observation.toolName !== action.actualToolName || observation.outcome !== 'success'
      || observation.verification?.status !== 'passed' || observation.verification.failedCheckIds?.length
      || !observation.evidenceId || !observation.verification.verificationId) return reject('listing-receipt-unbound');
    if (typeof dispatch.arguments?.directory !== 'string') return reject('listing-root-missing');
    const args = dispatch.arguments;
    if (!same(root, resolve(root,args.directory))
      || Object.keys(args).some(k => !['directory','maxItems','offset','expectedListingSha256','rawText'].includes(k))
      || args.rawText !== undefined && args.rawText !== action.command)
      return reject('listing-target-or-arguments-mismatch');
    receipts.push({action, observation, args});
  }
  return {applicable:true,root,contract,receipts};
}

function collectPages(trace) {
  const last = trace.receipts.at(-1), data = last.observation.data;
  const finalItems = data?.listingItems ?? data?.items;
  if (!Array.isArray(finalItems)) return reject('listing-result-missing');
  // Legacy receipts may only prove a single full independent listing.
  if (!data.listingSnapshotSha256) {
    if (data.listingTruncated === true || (last.args.offset ?? 0) !== 0) return reject('listing-truncated');
    return {items:finalItems,evidence:[last.action.actionId],complete:true};
  }
  const total = data.listingTotalEntries, snapshot = data.listingSnapshotSha256;
  if (!Number.isSafeInteger(total) || total < 0 || total > 10000 || !/^[a-f0-9]{64}$/.test(snapshot))
    return reject('listing-page-metadata-invalid');
  const pages = new Map();
  for (const receipt of trace.receipts) {
    const d = receipt.observation.data;
    if (d?.listingSnapshotSha256 !== snapshot) continue;
    const items = d.listingItems, offset = d.listingOffset;
    const limit = Math.max(1,Math.min(1000,Number.isInteger(receipt.args.maxItems) ? receipt.args.maxItems : 100));
    if (!Array.isArray(items) || !Number.isSafeInteger(offset) || offset < 0 || offset !== (receipt.args.offset ?? 0)
      || d.listingTotalEntries !== total || items.length !== Math.min(limit,total-offset)
      || d.listingTruncated !== (items.length < total)
      || d.listingHasMore !== (offset+items.length < total)
      || offset > 0 && receipt.args.expectedListingSha256 !== snapshot
      || receipt.args.expectedListingSha256 && receipt.args.expectedListingSha256 !== snapshot)
      return reject('listing-page-metadata-invalid');
    pages.set(offset,receipt);
  }
  let end = 0;
  const items = [], evidence = [];
  for (const [offset, receipt] of [...pages].sort((a,b) => a[0]-b[0])) {
    if (offset !== end) return reject('listing-page-gap-or-overlap');
    items.push(...receipt.observation.data.listingItems);
    evidence.push(receipt.action.actionId);
    end += receipt.observation.data.listingItems.length;
  }
  if (new Set(items.map(i => i.name)).size !== items.length) return reject('listing-page-duplicate');
  return {items,evidence,total,snapshot,end,complete:end===total};
}

/** Source-bound continuation; every page still crosses ordinary E/B/G. */
export function planReadOnlyListingContinuation({mission,allowedRoots=[],maxActions=4}) {
  const trace = inspectTrace(mission,allowedRoots);
  if (!trace.applicable || trace.reasons) return null;
  const pages = collectPages(trace);
  if (pages.reasons) return {decision:'blocked',blockedReason:pages.reasons[0],summary:'목록 조회 기록을 다시 확인해야 합니다.',actions:[],criteriaAssessment:[]};
  if (pages.complete) return null;
  const count = Math.min(Math.max(1,Math.min(4,maxActions)),Math.ceil((pages.total-pages.end)/1000));
  return {decision:'continue',summary:'전체 목록의 남은 페이지를 조회합니다.',
    planning:{mode:'source-bound-listing-pagination',modelRoundTrips:0},criteriaAssessment:[],
    actions:Array.from({length:count},(_,i) => ({id:`listing-page-${pages.end+i*1000}`,
      title:'파일 목록 다음 페이지',command:'작업 폴더 파일 목록 보여줘',expectedToolName:'filesystem.listFiles',
      arguments:{directory:trace.root,maxItems:1000,offset:pages.end+i*1000,expectedListingSha256:pages.snapshot},
      dependencies:[],successSignal:'같은 목록 버전의 페이지 조회',
      requirementIds:trace.contract.requirements.map(r => r.requirementId)}))};
}

/** Re-enumerates the root. Full receipts are withheld from model context. */
export function verifyReadOnlyListing({mission,allowedRoots=[],evidenceActionIds=null,statement=null}) {
  const trace = inspectTrace(mission,allowedRoots);
  if (!trace.applicable || trace.reasons) return trace;
  if (statement !== null && statement !== `${mission.objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`)
    return {applicable:false};
  const pages = collectPages(trace);
  if (pages.reasons) return pages;
  if (!pages.complete) return reject('listing-pages-incomplete');
  if (evidenceActionIds && pages.evidence.some(id => !evidenceActionIds.includes(id))) return reject('listing-final-receipt-unbound');
  try {
    if (!same(realpathSync(trace.root),trace.root)) return reject('listing-physical-root-mismatch');
    const current = readdirSync(trace.root,{withFileTypes:true}).map(e => ({name:e.name,type:e.isDirectory()?'directory':'file'}))
      .sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (current.length > 10000 || pages.items.length !== current.length) return reject('listing-incomplete-or-changed');
    const known = new Map(current.map(e => [e.name,e.type]));
    if (new Set(pages.items.map(i => i.name)).size !== pages.items.length
      || pages.items.some(i => typeof i.name !== 'string' || known.get(i.name) !== i.type)) return reject('listing-incomplete-or-changed');
    if (pages.snapshot && createHash('sha256').update(JSON.stringify(current)).digest('hex') !== pages.snapshot)
      return reject('listing-incomplete-or-changed');
  } catch { return reject('listing-independent-read-failed'); }
  return {applicable:true,passed:true,status:'passed',reasons:[],
    checks:[{checkId:'listing-dispatch-root-and-current-entries',passed:true},{checkId:'exclusive-read-only-action-trace',passed:true}],
    coveredRequirementIds:trace.contract.requirements.map(r => r.requirementId),evidenceActionIds:pages.evidence,itemCount:pages.items.length};
}
