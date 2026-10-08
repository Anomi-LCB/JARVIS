import { createHash, randomUUID } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * In-process staged release lifecycle for already-admitted local modules.
 * The isolated evaluator and reviewer are mandatory trust authorities supplied
 * by the host. This class never loads source text or treats a model response as
 * approval. Recovery requires a signed lifecycle, a host-owned persisted
 * evaluator receipt and renewed admission of an already-loaded definition.
 */
export class CapabilityPackagePromotionManager {
  #staged = new Map();
  #history = new Map();

  constructor({ registry, targets, authorizeArtifact, evaluateInIsolation, restoreEvaluation, authorizeReview, assertReviewCurrent, journal = null, journalUnavailableReason = null, journalRequired = false, protectImprovementContract = false, clock = () => new Date(), adapterContext = {} } = {}) {
    if (!registry || !targets) throw new TypeError('registry and runtime targets are required');
    this.registry = registry;
    this.targets = targets;
    this.authorizeArtifact = authorizeArtifact;
    this.evaluateInIsolation = evaluateInIsolation;
    this.restoreEvaluation = restoreEvaluation;
    this.authorizeReview = authorizeReview;
    this.assertReviewCurrent = assertReviewCurrent;
    this.journal = journal;
    this.journalUnavailableReason = journalUnavailableReason;
    this.journalRequired = journalRequired;
    this.clock = clock;
    this.adapterContext = adapterContext;
    Object.defineProperty(this, 'protectImprovementContract', { value: protectImprovementContract === true });
  }

  stage(definition) {
    this.#assertJournalReady();
    const entry=this.#admit(definition);
    this.#record('stage_created', {
      stageId: entry.id, toolName:entry.toolName, packageId:entry.definition.packageId, version:entry.definition.version,
      packageDigest:entry.packageDigest, artifactSha256:entry.artifactSha256, admissionRefDigest:entry.admissionRef?digest(entry.admissionRef):null,
      baseActiveDigest:entry.baseActiveDigest,status:entry.status
    });
    this.#staged.set(entry.id,entry);
    return publicEntry(entry);
  }

  #admit(definition) {
    // Admission callbacks must not be able to change the object that was
    // checked, evaluated and subsequently installed. Snapshot before invoking
    // any authority, including when that authority closes over caller input.
    definition = snapshotDefinition(definition);
    const toolName = String(definition?.skill?.toolName ?? '');
    const active = this.registry.activations.get(toolName);
    if (!active) throw promotionError('A_CAPABILITY_PACKAGE_ACTIVE_REQUIRED', 'Only an existing active tool can be replaced through this promotion path.');
    const priorDefinition = this.registry.packages.get(active.packageId)?._definition;
    if (this.protectImprovementContract) {
      assertImprovementBoundary(priorDefinition, definition);
      // The candidate may replace execution code, but cannot supply its own judge.
      definition = { ...definition, verifyEvidence: priorDefinition.verifyEvidence };
    }
    if (typeof this.evaluateInIsolation !== 'function') throw promotionError('A_CAPABILITY_PACKAGE_ISOLATOR_REQUIRED', 'An isolated package evaluator is not configured.');
    if (typeof this.authorizeReview !== 'function') throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_AUTHORITY_REQUIRED', 'A trusted human-review authority is not configured.');
    if (typeof this.authorizeArtifact !== 'function') throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_AUTHORITY_REQUIRED', 'A trusted package-admission authority is not configured.');
    if (typeof definition?.artifactSource !== 'string' || !definition.artifactSource.trim()) {
      throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_REQUIRED', 'Staged packages must include the exact admitted source artifact.');
    }
    const artifactSha256 = digest(definition.artifactSource);
    if (!/^[a-f0-9]{64}$/iu.test(String(definition.artifactSha256 ?? '')) || definition.artifactSha256 !== artifactSha256) {
      throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_DIGEST_MISMATCH', 'The executable artifact digest does not match its exact source bytes.');
    }
    const artifactAuthorization = this.authorizeArtifact(Object.freeze({
      toolName,
      packageId: definition.packageId,
      version: definition.version,
      artifactSha256,
      artifactSource: definition.artifactSource,
      createAdapter: definition.createAdapter,
      verifyEvidence: definition.verifyEvidence,
      verifierFingerprint: definition.verifierFingerprint
    }));
    if (artifactAuthorization?.approved !== true
      || artifactAuthorization.artifactSha256 !== artifactSha256
      || typeof artifactAuthorization?.admissionRef !== 'string'
      || !artifactAuthorization.admissionRef.trim()) {
      throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_NOT_ADMITTED', 'The trusted package authority did not bind this source artifact to the loaded adapter and verifier.');
    }
    const definitionSnapshot = deepFreeze({
      ...definition,
      skill: clone(definition.skill),
      argumentSchema: clone(definition.argumentSchema),
      evidenceSchema: clone(definition.evidenceSchema),
      artifactSource: definition.artifactSource,
      artifactSha256
    });
    const adapter = {
      contract: {
        toolName,
        evidence: [...(definitionSnapshot.skill?.adapterContract?.evidence ?? definitionSnapshot.evidenceSchema?.adapterEvidence ?? [])],
        modes: [...(definitionSnapshot.skill?.capability?.allowedModes ?? ['shadow'])]
      },
      shadow() {},
      execute() {}
    };
    const validation = this.registry.validate(definitionSnapshot, { adapter });
    if (!validation.valid) throw promotionError('A_CAPABILITY_PACKAGE_INVALID', validation.errors.join(' | '), { errors: validation.errors });
    const id = randomUUID();
    const entry = {
      id,
      definition: definitionSnapshot,
      toolName,
      priorDefinition,
      baseActiveDigest: active.packageDigest,
      packageDigest: validation.packageDigest,
      artifactSha256,
      admissionRef: typeof artifactAuthorization.admissionRef === 'string' ? artifactAuthorization.admissionRef : null,
      evaluation: null,
      review: null,
      status: 'staged',
      stagedAt: new Date().toISOString()
    };
    return entry;
  }

  restoreStage(stageId, definition) {
    this.#assertJournalReady();
    if(typeof this.journal?.stageHistory!=='function'||typeof this.restoreEvaluation!=='function')
      throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_AUTHORITY_REQUIRED','Signed history and a persisted host evaluation reader are required.');
    if(this.#staged.has(stageId))throw promotionError('A_CAPABILITY_PACKAGE_STAGE_ALREADY_PRESENT','Stage is already present.');
    const history=this.journal.stageHistory(stageId),created=history.filter(r=>r.eventType==='stage_created');
    this.#assertJournalReady();
    const terminal=history.filter(r=>['evaluation_started','evaluation_passed','evaluation_failed'].includes(r.eventType)).at(-1);
    const started=history.filter(r=>r.eventType==='evaluation_started').at(-1);
    if(created.length!==1||!terminal||!started||started.sequence>=terminal.sequence||!['evaluation_passed','evaluation_failed'].includes(terminal.eventType)
      ||history.some(r=>r.eventType.startsWith('promotion_')))
      throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_INCOMPLETE','An unambiguous completed evaluation without promotion is required.');
    const original=created[0].payload,entry=this.#admit(definition);
    if(entry.toolName!==original.toolName||entry.definition.packageId!==original.packageId||entry.definition.version!==original.version
      ||entry.packageDigest!==original.packageDigest||entry.artifactSha256!==original.artifactSha256
      ||entry.baseActiveDigest!==original.baseActiveDigest||digest(entry.admissionRef)!==original.admissionRefDigest
      ||started.payload.packageDigest!==entry.packageDigest||started.payload.artifactSha256!==entry.artifactSha256
      ||terminal.payload.packageDigest!==entry.packageDigest||terminal.payload.artifactSha256!==entry.artifactSha256)
      throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_IDENTITY_CHANGED','Re-admitted definition differs from signed staging identity.');
    const evidence=this.restoreEvaluation(Object.freeze({stageId,toolName:entry.toolName,packageDigest:entry.packageDigest,
      artifactSha256:entry.artifactSha256,artifactSource:entry.definition.artifactSource,
      manifest:{packageId:entry.definition.packageId,version:entry.definition.version}}));
    if(!evidence||!['passed','failed'].includes(evidence.status)||evidence.actualIsolatedExecution!==true
      ||evidence.packageDigest!==entry.packageDigest||evidence.artifactSha256!==entry.artifactSha256
      ||evidence.receipt?.isolationEnforced!==true||evidence.receipt.packageDigest!==entry.packageDigest||evidence.receipt.artifactSha256!==entry.artifactSha256
      ||evidence.receipt.status!==evidence.status||evidence.receipt.schemaVersion!=='a-capability-package-isolated-evaluation-v1'
      ||evidence.evidenceRef!==`sha256:${digest(evidence.receipt.comparison?.schemaVersion==='a-capability-comparison-v1'?JSON.stringify(evidence.receipt):canonical(evidence.receipt))}`
      ||digest(evidence.evidenceRef)!==terminal.payload.evidenceRefDigest
      ||(terminal.eventType==='evaluation_passed')!==(evidence.status==='passed'))
      throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_RECEIPT_INVALID','Historical receipt differs from signed evaluation evidence.');
    entry.id=stageId;entry.evaluation=deepFreeze(clone(evidence));entry.review=null;
    entry.status=evidence.status==='passed'?'evaluated':'evaluation_failed';
    entry.recoveredEvaluationSequence=terminal.sequence;
    this.#assertUnchanged(entry);
    this.#staged.set(stageId,entry);
    return {...publicEntry(entry),restored:true,executedNow:false,reviewRestored:false};
  }

  async evaluate(stageId) {
    this.#assertJournalReady();
    const entry = this.#entry(stageId);
    this.#assertUnchanged(entry);
    this.#record('evaluation_started',{stageId:entry.id,packageDigest:entry.packageDigest,artifactSha256:entry.artifactSha256});
    entry.recoveredEvaluationSequence=null;
    // A new evaluation invalidates any earlier human review, including a failed rerun.
    entry.review = null;
    entry.evaluation = null;
    let evidence;
    try {
      evidence = await this.evaluateInIsolation(Object.freeze({
        stageId: entry.id,
        toolName: entry.toolName,
        packageDigest: entry.packageDigest,
        artifactSha256: entry.artifactSha256,
        admissionRef: entry.admissionRef,
        artifactSource: entry.definition.artifactSource,
        manifest: clone({
          packageId: entry.definition.packageId,
          version: entry.definition.version,
          skill: entry.definition.skill,
          argumentSchema: entry.definition.argumentSchema,
          evidenceSchema: entry.definition.evidenceSchema,
          verifierId: entry.definition.verifierId,
          verifierFingerprint: entry.definition.verifierFingerprint
        })
      }));
    } catch (error) {
      entry.status = 'evaluation_failed';
      this.#record('evaluation_failed', { stageId: entry.id, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256, errorCode: error?.code ?? 'A_CAPABILITY_PACKAGE_EVALUATION_FAILED' });
      throw error;
    }
    if (evidence?.status !== 'passed'
      || evidence?.actualIsolatedExecution !== true
      || evidence?.packageDigest !== entry.packageDigest
      || evidence?.artifactSha256 !== entry.artifactSha256
      || typeof evidence?.evidenceRef !== 'string'
      || !evidence.evidenceRef.trim()) {
      entry.status = 'evaluation_failed';
      const boundFailure=evidence?.status==='failed' && evidence?.actualIsolatedExecution===true
        && evidence?.packageDigest===entry.packageDigest && evidence?.artifactSha256===entry.artifactSha256
        && typeof evidence?.evidenceRef==='string' && evidence.evidenceRef.trim();
      // Preserve measured failures for reporting; they never authorize review or promotion.
      if(boundFailure) entry.evaluation=Object.freeze(clone(evidence));
      this.#record('evaluation_failed', { stageId: entry.id, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256, errorCode: 'A_CAPABILITY_PACKAGE_ISOLATION_FAILED',
        ...(boundFailure ? {evidenceRefDigest:digest(evidence.evidenceRef)} : {}) });
      throw promotionError('A_CAPABILITY_PACKAGE_ISOLATION_FAILED', 'The isolated evaluator did not return a passing receipt bound to the staged package and artifact.');
    }
    this.#record('evaluation_passed', { stageId: entry.id, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256, evidenceRefDigest: digest(evidence.evidenceRef) });
    entry.evaluation = Object.freeze(clone(evidence));
    entry.status = 'evaluated';
    return publicEntry(entry);
  }

  async review(stageId, reviewContext = {}) {
    this.#assertJournalReady();
    const entry = this.#entry(stageId);
    this.#assertUnchanged(entry);
    if (entry.evaluation?.status!=='passed') throw promotionError('A_CAPABILITY_PACKAGE_EVALUATION_REQUIRED', 'A passing isolated evaluation is required before review.');
    const authorization = await this.authorizeReview(Object.freeze({
      action: 'review',
      stageId: entry.id,
      toolName: entry.toolName,
      packageDigest: entry.packageDigest,
      artifactSha256: entry.artifactSha256,
      evaluation: clone(entry.evaluation),
      reviewContext: clone(reviewContext)
    }));
    if (authorization?.approved !== true
      || typeof authorization?.reviewerId !== 'string'
      || !authorization.reviewerId.trim()
      || authorization.packageDigest !== entry.packageDigest
      || authorization.artifactSha256 !== entry.artifactSha256) {
      throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_DENIED', 'A trusted reviewer did not approve this exact evaluated artifact.');
    }
    const review = Object.freeze({
      reviewerId: authorization.reviewerId,
      approvedAt: new Date().toISOString(),
      packageDigest: entry.packageDigest,
      artifactSha256: entry.artifactSha256,
      evidenceRef: entry.evaluation.evidenceRef
    });
    const sanitizedContext = sanitizeReviewContext(reviewContext);
    this.#record('owner_reviewed', {
      stageId: entry.id, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256,
      reviewerFingerprint: digest(authorization.reviewerId), approvedAt: review.approvedAt,
      evidenceRefDigest: digest(entry.evaluation.evidenceRef)
    });
    entry.review = review;
    entry.reviewContext = sanitizedContext;
    entry.status = 'reviewed';
    return publicEntry(entry);
  }

  async promote(stageId) {
    this.#assertJournalReady();
    const entry = this.#entry(stageId);
    this.#assertUnchanged(entry);
    if (!entry.review || entry.review.packageDigest !== entry.packageDigest || entry.review.artifactSha256 !== entry.artifactSha256) {
      throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_REQUIRED', 'Explicit review of this exact package is required before promotion.');
    }
    await this.#reauthorize(entry, 'promote', entry.reviewContext);
    this.#assertReviewCurrent(entry, 'promote', entry.reviewContext);
    const active = this.registry.activations.get(entry.toolName);
    if (active?.packageDigest !== entry.baseActiveDigest) throw promotionError('A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION', 'The active tool changed after staging; stage and review the replacement again.');
    this.#record('promotion_started', { stageId: entry.id, toolName: entry.toolName, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256, baseActiveDigest: entry.baseActiveDigest });
    let activation;
    try {
      activation = this.registry.replace(entry.definition, {
        ...this.targets,
        adapterContext: this.adapterContext,
        expectedActiveDigest: entry.baseActiveDigest
      });
    } catch (error) {
      this.#record('promotion_failed', { stageId: entry.id, packageDigest: entry.packageDigest, artifactSha256: entry.artifactSha256, errorCode: error?.code ?? 'A_CAPABILITY_PACKAGE_PROMOTION_FAILED' });
      throw error;
    }
    const rollbackId = randomUUID();
    this.#history.set(rollbackId, {
      rollbackId,
      toolName: entry.toolName,
      priorDefinition: entry.priorDefinition,
      priorDigest: entry.baseActiveDigest,
      promotedDigest: activation.packageDigest,
      promotedDefinition: entry.definition,
      artifactSha256: entry.artifactSha256,
      review: entry.review,
      promotedAt: new Date().toISOString()
    });
    entry.status = 'promoted';
    entry.activation = activation;
    entry.rollbackId = rollbackId;
    try {
      this.#record('promotion_committed', { stageId: entry.id, rollbackId, toolName: entry.toolName, packageDigest: activation.packageDigest, artifactSha256: entry.artifactSha256 });
    } catch (error) {
      this.registry.replace(entry.priorDefinition, { ...this.targets, adapterContext: this.adapterContext, expectedActiveDigest: activation.packageDigest });
      entry.status = 'journal_failed';
      throw error;
    }
    return { ...publicEntry(entry), activation, rollbackId };
  }

  async createLimitedAdapter(stageId) {
    this.#assertJournalReady();const entry=this.#entry(stageId);this.#assertUnchanged(entry);
    if(!entry.review||entry.evaluation?.status!=='passed')throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_REQUIRED','Limited application requires the exact evaluated owner-reviewed artifact.');
    await this.#reauthorize(entry,'promote',entry.reviewContext);this.#assertReviewCurrent(entry,'promote',entry.reviewContext);
    if(this.registry.activations.get(entry.toolName)?.packageDigest!==entry.baseActiveDigest)
      throw promotionError('A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION','The baseline changed before limited application.');
    const adapter=entry.definition.createAdapter(this.adapterContext);
    const checked=this.registry.validate(entry.definition,{adapter});
    if(!checked.valid||checked.packageDigest!==entry.packageDigest)throw promotionError('A_CAPABILITY_PACKAGE_INVALID','Limited adapter contract differs from the reviewed package.');
    return {adapter,packageDigest:entry.packageDigest,baseActiveDigest:entry.baseActiveDigest,artifactSha256:entry.artifactSha256,
      assertCurrent:()=>{this.#assertJournalReady();this.#assertUnchanged(entry);this.#assertReviewCurrent(entry,'promote',entry.reviewContext);
        if(this.registry.activations.get(entry.toolName)?.packageDigest!==entry.baseActiveDigest)throw promotionError('A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION','Limited baseline changed.');},
      assertExpandedCurrent:()=>{this.#assertJournalReady();this.#assertUnchanged(entry);
        if(this.registry.activations.get(entry.toolName)?.packageDigest!==entry.packageDigest)throw promotionError('A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION','Expanded candidate changed.');},
      rollbackReviewed:rollbackId=>this.rollback(rollbackId,entry.reviewContext)};
  }

  restoreRollback(rollbackId, priorDefinition, promotedDefinition) {
    this.#assertJournalReady();
    if(typeof this.journal?.rollbackHistory!=='function')throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_AUTHORITY_REQUIRED','Verified signed promotion history is required.');
    if(this.#history.has(rollbackId))throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_ALREADY_PRESENT','Rollback is already loaded.');
    const records=this.journal.rollbackHistory(rollbackId);
    this.#assertJournalReady();
    const committed=records.filter(r=>r.eventType==='promotion_committed'&&r.payload.rollbackId===rollbackId);
    if(committed.length!==1||records.some(r=>r.eventType==='rollback_committed'&&r.payload.rollbackId===rollbackId))
      throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_INCOMPLETE','An unambiguous unrolled committed promotion is required.');
    const commit=committed[0],stageId=commit.payload.stageId;
    const created=records.filter(r=>r.eventType==='stage_created'&&r.payload.stageId===stageId);
    const started=records.filter(r=>r.eventType==='promotion_started'&&r.payload.stageId===stageId);
    if(created.length!==1||started.length!==1||created[0].sequence>=started[0].sequence||started[0].sequence>=commit.sequence
      ||started[0].payload.packageDigest!==commit.payload.packageDigest||started[0].payload.artifactSha256!==commit.payload.artifactSha256
      ||created[0].payload.packageDigest!==commit.payload.packageDigest||created[0].payload.artifactSha256!==commit.payload.artifactSha256
      ||created[0].payload.baseActiveDigest!==started[0].payload.baseActiveDigest)
      throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_INCOMPLETE','Signed promotion identity is inconsistent.');
    const admit=definition=>{
      const copy=deepFreeze(snapshotDefinition(definition));
      const artifactSha256=typeof copy.artifactSource==='string'?digest(copy.artifactSource):null;
      if(!artifactSha256||copy.artifactSha256!==artifactSha256||typeof this.authorizeArtifact!=='function')
        throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_NOT_ADMITTED','Recovery requires the exact reviewed loaded artifact.');
      const decision=this.authorizeArtifact(Object.freeze({toolName:copy.skill?.toolName,packageId:copy.packageId,version:copy.version,
        artifactSource:copy.artifactSource,artifactSha256,createAdapter:copy.createAdapter,verifyEvidence:copy.verifyEvidence,verifierFingerprint:copy.verifierFingerprint}));
      if(decision?.approved!==true||decision.artifactSha256!==artifactSha256||typeof decision.admissionRef!=='string'||!decision.admissionRef.trim())
        throw promotionError('A_CAPABILITY_PACKAGE_ARTIFACT_NOT_ADMITTED','Recovery artifact authority refused the loaded functions.');
      const validation=this.registry.validate(copy,{adapter:{contract:{toolName:copy.skill?.toolName,
        evidence:copy.skill?.adapterContract?.evidence??[],modes:copy.skill?.capability?.allowedModes??[]},shadow(){},execute(){}}});
      if(!validation.valid)throw promotionError('A_CAPABILITY_PACKAGE_INVALID','Recovery package contract is invalid.');
      return {definition:copy,packageDigest:validation.packageDigest};
    };
    const prior=admit(priorDefinition),promoted=admit(promotedDefinition);
    if(this.protectImprovementContract)assertImprovementBoundary(prior.definition,promoted.definition);
    const toolName=commit.payload.toolName,active=this.registry.activations.get(toolName);
    const activeDefinition=this.registry.packages.get(active?.packageId)?._definition;
    if(prior.packageDigest!==created[0].payload.baseActiveDigest||promoted.packageDigest!==commit.payload.packageDigest
      ||promoted.definition.artifactSha256!==commit.payload.artifactSha256||prior.definition.skill.toolName!==toolName
      ||promoted.definition.skill.toolName!==toolName||active?.packageDigest!==promoted.packageDigest
      ||activeDefinition?.createAdapter!==promoted.definition.createAdapter||activeDefinition?.verifyEvidence!==promoted.definition.verifyEvidence)
      throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_MISMATCH','The current activation or prior executable differs from the signed promotion.');
    this.#history.set(rollbackId,{rollbackId,toolName,priorDefinition:prior.definition,priorDigest:prior.packageDigest,
      promotedDefinition:promoted.definition,promotedDigest:promoted.packageDigest,artifactSha256:promoted.definition.artifactSha256,
      promotedAt:commit.recordedAt,recoveredCommitSequence:commit.sequence});
    return {status:'rollback_ready',rollbackId,toolName,priorDigest:prior.packageDigest,promotedDigest:promoted.packageDigest,ownerAuthorizationRestored:false};
  }

  async rollback(rollbackId, reviewContext = {}) {
    this.#assertJournalReady();
    const history = this.#history.get(rollbackId);
    if (!history) throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_NOT_FOUND', 'No in-process rollback record exists for this promotion.');
    if(history.recoveredCommitSequence){
      const records=this.journal.rollbackHistory(rollbackId);
      if(records.some(r=>r.eventType==='rollback_committed'&&r.payload.rollbackId===rollbackId)
        ||!records.some(r=>r.eventType==='promotion_committed'&&r.sequence===history.recoveredCommitSequence&&r.payload.rollbackId===rollbackId))
        throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_SUPERSEDED','The recovered rollback has changed since restoration.');
    }
    if (!history.priorDefinition) throw promotionError('A_CAPABILITY_PACKAGE_PRIOR_VERSION_UNAVAILABLE', 'The previous executable package definition is unavailable in this process.');
    await this.#reauthorize({ ...history, id: rollbackId, evaluation: null }, 'rollback', reviewContext);
    this.#assertReviewCurrent(history, 'rollback', reviewContext);
    if(history.recoveredCommitSequence){
      const records=this.journal.rollbackHistory(rollbackId);
      this.#assertJournalReady();
      if(records.some(r=>r.eventType==='rollback_committed'&&r.payload.rollbackId===rollbackId))
        throw promotionError('A_CAPABILITY_PACKAGE_ROLLBACK_RECOVERY_SUPERSEDED','The rollback committed during authorization.');
    }
    const active = this.registry.activations.get(history.toolName);
    if (active?.packageDigest !== history.promotedDigest) throw promotionError('A_CAPABILITY_PACKAGE_STALE_ACTIVE_VERSION', 'The active tool changed after promotion; rollback would overwrite a newer release.');
    this.#record('rollback_started', { rollbackId, toolName: history.toolName, promotedDigest: history.promotedDigest, artifactSha256: history.artifactSha256, priorDigest: history.priorDigest });
    let activation;
    try {
      activation = this.registry.replace(history.priorDefinition, {
        ...this.targets,
        adapterContext: this.adapterContext,
        expectedActiveDigest: history.promotedDigest
      });
    } catch (error) {
      this.#record('rollback_failed', { rollbackId, promotedDigest: history.promotedDigest, errorCode: error?.code ?? 'A_CAPABILITY_PACKAGE_ROLLBACK_FAILED' });
      throw error;
    }
    history.rolledBackAt = new Date().toISOString();
    history.rollbackDigest = activation.packageDigest;
    try {
      this.#record('rollback_committed', { rollbackId, toolName: history.toolName, rollbackDigest: activation.packageDigest, restoredPriorDigest: activation.packageDigest === history.priorDigest });
    } catch (error) {
      this.registry.replace(history.promotedDefinition, { ...this.targets, adapterContext: this.adapterContext, expectedActiveDigest: activation.packageDigest });
      history.rolledBackAt = null;
      history.rollbackDigest = null;
      throw error;
    }
    return { status: 'rolled_back', activation, rollbackId, restoredPriorDigest: activation.packageDigest === history.priorDigest };
  }

  getStage(stageId) {
    return publicEntry(this.#entry(stageId));
  }
  improvementPolicy(){return clone(this.evaluateInIsolation?.improvementPolicy?.()??null);}
  improvementBudgetStatus(){return clone(this.evaluateInIsolation?.persistentBudgetStatus?.()??null);}
  prepareImprovement(id){
    if(typeof this.evaluateInIsolation?.prepareImprovement!=='function')throw promotionError('A_IMPROVEMENT_EVALUATION_POLICY_REQUIRED','Persistent preparation budgeting is unavailable.');
    return this.evaluateInIsolation.prepareImprovement(id);
  }
  attachImprovementPreparation(stageId,ticket){this.evaluateInIsolation.attachImprovementPreparation(stageId,ticket);}
  abandonImprovementPreparation(ticket){this.evaluateInIsolation.abandonImprovementPreparation(ticket);}

  status() {
    return {
      promotionManagerVersion: 'a-capability-package-promotion-manager-status-v1',
      inMemoryStageCount: this.#staged.size,
      inMemoryRollbackCount: this.#history.size,
      lifecycleJournal: this.journal?.status() ?? {
        available: false,
        integrity: this.journalUnavailableReason ? 'unavailable' : 'not-configured',
        reasonCode: this.journalUnavailableReason,
        automaticExecutableRecovery: false
      },
      checkedAt: this.clock().toISOString()
    };
  }

  #entry(stageId) {
    const entry = this.#staged.get(stageId);
    if (!entry) throw promotionError('A_CAPABILITY_PACKAGE_STAGE_NOT_FOUND', 'Staged package was not found.');
    return entry;
  }

  #assertUnchanged(entry) {
    if(entry.recoveredEvaluationSequence){
      const history=this.journal.stageHistory(entry.id);
      const latest=history.filter(r=>['evaluation_started','evaluation_passed','evaluation_failed'].includes(r.eventType)).at(-1);
      if(latest?.sequence!==entry.recoveredEvaluationSequence||history.some(r=>r.eventType.startsWith('promotion_')))
        throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_SUPERSEDED','Historical evaluation has changed since recovery.');
    }
    const current = this.registry.validate(entry.definition, {
      adapter: {
        contract: {
          toolName: entry.toolName,
          evidence: [...(entry.definition.skill?.adapterContract?.evidence ?? entry.definition.evidenceSchema?.adapterEvidence ?? [])],
          modes: [...(entry.definition.skill?.capability?.allowedModes ?? ['shadow'])]
        },
        shadow() {}, execute() {}
      }
    });
    if (current.packageDigest !== entry.packageDigest
      || digest(entry.definition.artifactSource) !== entry.artifactSha256
      || entry.definition.artifactSha256 !== entry.artifactSha256) {
      throw promotionError('A_CAPABILITY_PACKAGE_STAGE_TAMPERED', 'Staged package data changed after evaluation.');
    }
  }

  async #reauthorize(entry, action, reviewContext) {
    const authorization = await this.authorizeReview(Object.freeze({
      action,
      stageId: entry.id,
      toolName: entry.toolName,
      packageDigest: action === 'rollback' ? entry.promotedDigest : entry.packageDigest,
      artifactSha256: entry.artifactSha256 ?? entry.priorDefinition?.artifactSha256,
      evaluation: clone(entry.evaluation),
      reviewContext: clone(reviewContext)
    }));
    const expectedPackageDigest = action === 'rollback' ? entry.promotedDigest : entry.packageDigest;
    const expectedArtifactSha256 = entry.artifactSha256 ?? entry.priorDefinition?.artifactSha256;
    if (authorization?.approved !== true
      || (action === 'promote' && authorization.reviewerId !== entry.review?.reviewerId)
      || authorization.packageDigest !== expectedPackageDigest
      || authorization.artifactSha256 !== expectedArtifactSha256) {
      throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED', `Owner authorization is no longer valid for ${action}.`);
    }
  }

  #assertReviewCurrent(entry, action, reviewContext) {
    if (typeof this.assertReviewCurrent !== 'function') return;
    const decision = this.assertReviewCurrent(Object.freeze({
      action,
      stageId: entry.id ?? entry.rollbackId,
      toolName: entry.toolName,
      packageDigest: action === 'rollback' ? entry.promotedDigest : entry.packageDigest,
      artifactSha256: entry.artifactSha256 ?? entry.priorDefinition?.artifactSha256,
      reviewContext: clone(reviewContext)
    }));
    const expectedPackageDigest = action === 'rollback' ? entry.promotedDigest : entry.packageDigest;
    const expectedArtifactSha256 = entry.artifactSha256 ?? entry.priorDefinition?.artifactSha256;
    if (decision?.allowed !== true
      || decision.action !== action
      || decision.packageDigest !== expectedPackageDigest
      || decision.artifactSha256 !== expectedArtifactSha256
      || (action === 'promote' && decision.reviewerId !== entry.review?.reviewerId)) {
      throw promotionError('A_CAPABILITY_PACKAGE_REVIEW_AUTHORIZATION_EXPIRED', `Owner authorization expired immediately before ${action}.`);
    }
  }

  #assertJournalReady() {
    if (this.journalRequired && !this.journal) throw promotionError('A_CAPABILITY_PACKAGE_JOURNAL_UNAVAILABLE', 'Required signed promotion journal is unavailable.', { reasonCode: this.journalUnavailableReason });
    if (this.journal?.fault) throw promotionError('A_CAPABILITY_PACKAGE_JOURNAL_UNAVAILABLE', 'Signed promotion journal is unavailable.');
    if (this.journal?.status().pendingTransitions.length) throw promotionError('A_CAPABILITY_PACKAGE_RECOVERY_REQUIRED', 'An interrupted promotion transition requires operator recovery before further changes.');
  }

  #record(eventType, payload) {
    this.journal?.append(eventType, payload);
  }
}

function sanitizeReviewContext(context = {}) {
  return {
    ownerSessionId: typeof context.ownerSessionId === 'string' ? context.ownerSessionId : null,
    deviceId: typeof context.deviceId === 'string' ? context.deviceId : null,
    remoteAddress: typeof context.remoteAddress === 'string' ? context.remoteAddress : null
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function protectedSkill(skill = {}) {
  const { skillId, version, title, description, ...contract } = skill;
  return contract;
}

function snapshotDefinition(definition) {
  const snapshot = { ...definition };
  return {
    ...snapshot,
    skill: clone(snapshot.skill),
    argumentSchema: clone(snapshot.argumentSchema),
    evidenceSchema: clone(snapshot.evidenceSchema)
  };
}

function assertImprovementBoundary(prior, candidate) {
  if (!prior || typeof prior.verifyEvidence !== 'function') throw promotionError('A_CAPABILITY_PACKAGE_BASE_CONTRACT_REQUIRED', 'The active trusted verifier is unavailable.');
  const unchanged = prior.verifierId === candidate.verifierId
    && prior.verifierFingerprint === candidate.verifierFingerprint
    && canonical(prior.evidenceSchema) === canonical(candidate.evidenceSchema)
    && canonical(prior.argumentSchema) === canonical(candidate.argumentSchema)
    && canonical(protectedSkill(prior.skill)) === canonical(protectedSkill(candidate.skill));
  if (!unchanged) throw promotionError('A_CAPABILITY_PACKAGE_PROTECTED_CONTRACT_CHANGED', 'Improvement candidates cannot change the active evaluator, argument contract, evidence requirements or execution permission contract.');
}

function publicEntry(entry) {
  return {
    stageId: entry.id,
    toolName: entry.toolName,
    packageDigest: entry.packageDigest,
    artifactSha256: entry.artifactSha256,
    admissionRef: entry.admissionRef,
    baseActiveDigest: entry.baseActiveDigest,
    status: entry.status,
    evaluation: clone(entry.evaluation),
    review: clone(entry.review),
    rollbackId: entry.rollbackId ?? null
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function promotionError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}
