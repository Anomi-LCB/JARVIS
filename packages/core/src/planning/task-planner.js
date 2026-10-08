import { basename, isAbsolute, relative, resolve } from 'node:path';
import { sanitizeMissionArguments } from './mission-action-arguments.js';
import {parseLiteralTextFileRequest,isLiteralTextFileAttempt} from './literal-text-file-request.js';
import {parseSearchDirectoryRequest} from './search-directory-request.js';
import { ActionType, createPlanStep, createPolicyCheckRequest, createTaskPlan, stableId } from '../../../shared/src/types.js';

export class TaskPlanner {
  constructor({ workspaceRoot = './workspace' } = {}) {
    this.configureWorkspaceRoot(workspaceRoot);
  }

  configureWorkspaceRoot(workspaceRoot = './workspace') {
    this.workspaceRoot = resolve(workspaceRoot);
    return this;
  }

  createPlan(taskRequest, intent, {
    contextSnapshot,
    route,
    planningContext = null,
    deterministicArgumentsOnly = false,
    preparedMissionArguments = null
  } = {}) {
    const createdAt = taskRequest.createdAt;
    const planId = stableId('plan', taskRequest.requestId, createdAt);
    const skill = route?.skill ?? {
      skillId: 'jarvis.local.mvp',
      toolName: 'pcAgent.safeLocalTool'
    };
    // A trusted upstream planner can already have selected a deterministic route. In that
    // narrow case use the base parser directly so subclasses do not repeat an external
    // model call merely to extract arguments that are already explicit in the command.
    let suppliedArguments = sanitizeMissionArguments(skill.toolName, preparedMissionArguments);
    // Bind the exact relative read target to the task workspace, not the
    // process working directory. Never strip or reinterpret absolute paths;
    // E/B still enforce lexical and physical allowed-root checks.
    if (skill.toolName === 'filesystem.readText' && typeof suppliedArguments?.path === 'string'
      && !isAbsolute(suppliedArguments.path)) {
      suppliedArguments = {...suppliedArguments,path:resolve(this.workspaceRoot,suppliedArguments.path)};
    }
    const actionArguments = suppliedArguments ? { ...suppliedArguments, rawText: taskRequest.command.rawText } : deterministicArgumentsOnly
      ? TaskPlanner.prototype.argumentsFor.call(this, intent, taskRequest, contextSnapshot)
      : this.argumentsFor(intent, taskRequest, contextSnapshot);
    const planningGuardrails = this.planningGuardrailsFor(planningContext);
    const planSteps = [
      createPlanStep({ order: 1, description: '사용자 요청을 표준 TaskRequest로 저장합니다.', module: 'A_CORE', postconditions: ['TaskRequest.valid'] }),
      createPlanStep({ order: 2, description: 'IntentCandidate와 모호성 여부를 계산합니다.', module: 'A_CORE', preconditions: ['TaskRequest.valid'], postconditions: ['IntentCandidate.selected'] }),
      createPlanStep({ order: 3, description: 'ContextSnapshot을 생성합니다.', module: 'A_CORE', preconditions: ['IntentCandidate.selected'], postconditions: ['ContextSnapshot.valid'] }),
      createPlanStep({ order: 4, description: `${skill.label ?? skill.toolName} 스킬 계약으로 라우팅합니다.`, module: 'A_CORE', postconditions: ['SkillRoute.routable'] }),
      createPlanStep({ order: 5, description: 'E PolicyCheckRequest로 위험 등급을 평가합니다.', module: 'E_POLICY_SECURITY', preconditions: ['TaskPlan.draft'], postconditions: ['PolicyResult.available'] }),
      createPlanStep({ order: 6, description: '승인 후 CapabilityRequest와 ExecutionPacket을 생성할 준비를 합니다.', module: 'A_CORE', preconditions: ['ApprovalDecision.approved'], postconditions: ['ExecutionPacket.ready'], rollbackHint: '승인 전에는 B 모듈 쓰기 작업을 호출하지 않습니다.' })
    ];
    const affectedItems = this.affectedItemsFor(intent, actionArguments);
    const action = {
      actionType: intent.actionType,
      skillId: skill.skillId,
      toolName: skill.toolName,
      skillVersion: skill.version,
      arguments: actionArguments,
      capability: route?.requiredCapability,
      safety: {
        ...(route?.safety ?? {}),
        planningGuardrails: planningGuardrails.map((guardrail) => ({
          adapterId: guardrail.adapterId,
          sourceFailureId: guardrail.sourceFailureId,
          applyMode: guardrail.applyMode,
          severity: guardrail.severity,
          checklist: guardrail.checklist
        }))
      },
      adapterContract: route?.adapterContract
    };
    // A mission has already decomposed its goal into tool-bound atomic actions.
    // Re-splitting the description duplicates the full argument payload (and writes).
    const graphIntent = suppliedArguments ? { ...intent, complexity: { ...intent.complexity, needsPlanDecomposition: false } } : intent;
    const planGraph = this.planGraphFor({ taskRequest, intent: graphIntent, planSteps, action, affectedItems, skill, planningGuardrails });
    const failureBranches = this.failureBranchesFor({ intent, action, affectedItems, planGraph });
    const compensationPlan = this.compensationPlanFor({ intent, action, affectedItems, planGraph, failureBranches });
    const policyCheckRequest = createPolicyCheckRequest({
      checkId: stableId('policycheck', planId, createdAt),
      taskId: taskRequest.taskId,
      planId,
      action,
      contextSnapshot,
      createdAt
    });
    const plan = createTaskPlan({
      planId,
      taskId: taskRequest.taskId,
      title: intent.title ?? intent.label,
      interpretedIntent: `${taskRequest.command.rawText} 요청을 ${intent.title ?? intent.label} 작업으로 해석했습니다.`,
      action,
      planSteps,
      planGraph,
      failureBranches,
      compensationPlan,
      affectedItems,
      contextSnapshotId: contextSnapshot?.snapshotId,
      route,
      policyCheckRequest,
      assumptions: this.assumptionsFor(intent, taskRequest),
      riskNotes: this.riskNotesFor(intent, planningGuardrails),
      planningGuardrails,
      guardrailAudit: this.guardrailAuditFor(planningGuardrails),
      createdAt
    });
    if (planningContext?.cognition) plan.cognitiveContext = planningContext.cognition;
    return plan;
  }

  planningGuardrailsFor(planningContext) {
    return (planningContext?.planningGuardrails ?? [])
      .filter((guardrail) => guardrail?.adapterId && guardrail.disabled !== true)
      .map((guardrail) => ({
        adapterId: guardrail.adapterId,
        sourceFailureId: guardrail.sourceFailureId,
        injectBefore: guardrail.injectBefore ?? 'A.TaskPlanner.createPlan',
        severity: guardrail.severity ?? 'medium',
        condition: guardrail.condition ?? {},
        checklist: guardrail.checklist ?? [],
        recommendation: guardrail.recommendation ?? '이전 실패 조건을 계획 전에 확인한다.',
        applyMode: guardrail.applyMode ?? 'preflight_warning',
        planningWeight: Number(guardrail.planningWeight ?? 1)
      }))
      .sort((a, b) => b.planningWeight - a.planningWeight)
      .slice(0, 5);
  }

  guardrailAuditFor(planningGuardrails) {
    if (planningGuardrails.length === 0) {
      return {
        adapterId: 'f-failure-memory-planning-guardrail-v1',
        injected: false,
        sourceFailureIds: []
      };
    }
    return {
      adapterId: 'f-failure-memory-planning-guardrail-v1',
      injected: true,
      injectBefore: 'A.TaskPlanner.createPlan',
      sourceFailureIds: planningGuardrails.map((guardrail) => guardrail.sourceFailureId),
      strongestApplyMode: planningGuardrails[0].applyMode,
      checklist: [...new Set(planningGuardrails.flatMap((guardrail) => guardrail.checklist))]
    };
  }

  argumentsFor(intent, taskRequest, contextSnapshot) {
    if(intent.slots?.workflow==='export-existing-xlsx-pdf'){
      const requestedPath=value=>value?(isAbsolute(value)?resolve(value):resolve(this.workspaceRoot,value.replace(/\\/g,'/').replace(/^(?:\.\/)?workspace\//iu,''))):null;
      return {inputPath:requestedPath(intent.slots.inputPath),outputPath:requestedPath(intent.slots.outputPath)};
    }
    if (intent.actionType === ActionType.BROWSER_SEARCH) {
      if (intent.slots?.workflow === 'publisher-news-feed') {
        return { feedUrl: intent.slots?.feedUrl ?? '', maxResults: intent.slots?.maxResults ?? 5, readOnly: true };
      }
      if (intent.slots?.workflow === 'news-headlines') {
        return {
          query: intent.slots?.newsQuery ?? intent.slots?.query ?? '',
          category: intent.slots?.newsCategory ?? 'top',
          maxResults: intent.slots?.maxResults ?? 5,
          readOnly: true
        };
      }
      return { query: intent.slots?.query ?? taskRequest.command.rawText, searchEngine: 'duckduckgo', maxResults: 5, readOnly: true };
    }
    if (intent.actionType === ActionType.LIST_FILES) {
      return { directory: this.workspaceRoot, maxItems: 1000 };
    }
    if (intent.actionType === ActionType.SEARCH_FILES) {
      const rawText = taskRequest.command.rawText;
      if(intent.slots?.workflow==='read-xlsx-file'&&intent.slots?.fileName)return {path:this.readTextPathFor(rawText,intent.slots.fileName),range:intent.slots.range??'A1:J100',...(intent.slots.sheetName!==undefined?{sheetName:intent.slots.sheetName}:{})};
      if(intent.slots?.workflow==='read-pdf-file'&&intent.slots?.fileName) return {path:this.readTextPathFor(rawText,intent.slots.fileName),firstPage:1,maxPages:10};
      if (intent.label === '텍스트 파일 읽기' && intent.slots?.fileName) {
        return {
          path: this.readTextPathFor(rawText, intent.slots.fileName),
          offset: 0,
          maxChars: 12000
        };
      }
      const normalized=rawText.replaceAll('\\','/'),root=this.workspaceRoot.replaceAll('\\','/');
      const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      // An exact, explicitly named configured root remains scoped on both OSes.
      // A sibling/subdirectory prefix is not silently interpreted as this root.
      const explicitRoot=new RegExp(`(?:^|[\\s"'“”])${escapePattern(root)}(?=$|[\\s"'“”])`,process.platform==='win32'?'i':'');
      const workspaceScoped = /(?:작업\s*폴더|워크스페이스|workspace)/iu.test(rawText)||explicitRoot.test(normalized);
      const { declarations: folderDeclarations } = parseSearchDirectoryRequest(rawText);
      const directories = [...new Set(folderDeclarations.map(item => resolve(this.workspaceRoot, item.path)))];
      return {
        query: intent.slots?.fileName ?? rawText,
        extensions: [],
        modifiedWithinDays: null,
        contentQuery: '',
        scope: directories.length || workspaceScoped ? 'workspace' : 'home',
        ...(directories.length === 1 ? { directory: directories[0] } : directories.length > 1 ? { directories } : {})
      };
    }
    if (intent.actionType === ActionType.DESKTOP_CONTROL) {
      return {
        rawText: taskRequest.command.rawText,
        target: intent.slots?.windowTitle ? { titleContains: intent.slots.windowTitle } : {},
        operations: [],
        verification: []
      };
    }
    if (intent.actionType === ActionType.CREATE_FILE) {
      const explicitlyInWorkspace = taskRequest.command.rawText.toLowerCase().replaceAll('\\', '/').includes(this.workspaceRoot.toLowerCase().replaceAll('\\', '/'));
      const targetDirectoryHint = explicitlyInWorkspace ? 'workspace' : intent.slots?.targetDirectoryHint ?? 'workspace';
      const outputFormat = intent.slots?.outputFormat ?? 'txt';
      const literalText=outputFormat==='txt'?parseLiteralTextFileRequest(taskRequest.command.rawText):null;
      if(literalText)return {path:this.workspacePathFor(literalText.fileName),content:literalText.content,
        rawText:taskRequest.command.rawText,outputFormat:'txt',fileName:literalText.fileName,targetDirectoryHint:'workspace'};
      if(outputFormat==='txt'&&isLiteralTextFileAttempt(taskRequest.command.rawText))
        throw Object.assign(new Error('파일명·내용·추가 지시를 모두 해석해야 합니다. 복합 파일 요청은 Mission으로 실행하세요.'),
          {code:'A_LITERAL_TEXT_REQUEST_UNRESOLVED'});
      if (intent.slots?.workflow === 'weekly-weather-hwp-report') {
        const rawText = taskRequest.command.rawText;
        const explicitFileName = rawText.match(/(?:파일명|이름)\s*[:：=]\s*["'“”]?([^\]\[;,\n"'“”]+\.hwpx?)/iu)?.[1]?.trim();
        return {
          rawText,
          workflow: 'weekly-weather-hwp-report',
          location: intent.slots?.weatherLocation ?? '',
          period: 'next-7-days',
          outputFormat: 'hwp',
          fileName: explicitFileName || undefined,
          targetDirectoryHint
        };
      }
      const locationArguments = targetDirectoryHint === 'workspace'
        ? (outputFormat === 'xlsx' ? { outputPath: this.outputPathFor(intent) } : { path: this.outputPathFor(intent) })
        : {};
      if (outputFormat !== 'xlsx') {
        return {
          ...locationArguments,
          content: taskRequest.command.rawText.match(/내용(?:으로|은|에|을)?\s*[:：]?\s*["“]([^"”]+)["”]/u)?.[1] ?? taskRequest.command.rawText,
          rawText: taskRequest.command.rawText,
          outputFormat,
          fileName: intent.slots?.fileName,
          targetDirectoryHint
        };
      }
      return {
        ...locationArguments,
        sheetName: 'JARVIS',
        columns: ['요청', '상태'],
        rows: [[taskRequest.command.rawText, 'planned']],
        rawText: taskRequest.command.rawText,
        outputFormat: 'xlsx',
        fileName: intent.slots?.fileName,
        targetDirectoryHint
      };
    }
    if (intent.actionType === ActionType.SEND_EMAIL) {
      const rawText = taskRequest.command.rawText;
      const explicitAddress = rawText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/iu)?.[0] ?? '';
      const attachmentRef = parseJarvisArtifactReference(rawText);
      const attachmentSha256 = parseAttachmentSha256(rawText);
      const weatherReport = /(?:날씨|기상|예보)/iu.test(rawText) && /(?:통계|보고서|표)/iu.test(rawText);
      const selfRecipient = !explicitAddress && /(?:내|제)\s*(?:구글\s*)?(?:이|e)?메일|나(?:에게|한테)|본인(?:에게)?/iu.test(rawText);
      return {
        rawText,
        destination: 'email',
        to: explicitAddress,
        name: intent.slots?.recipientHint ?? '',
        recipientMode: selfRecipient ? 'self' : 'explicit',
        subject: weatherReport
          ? '주간 날씨 통계 보고서'
          : intent.slots?.topic ? `${intent.slots.topic} 자료` : 'JARVIS 작업 결과',
        body: weatherReport
          ? '요청하신 향후 7일 날씨 통계 한글 보고서를 첨부합니다.'
          : '요청하신 작업 결과를 보냅니다.',
        attachmentQuery: attachmentRef?.name ?? intent.slots?.fileName ?? '',
        attachmentRef: attachmentRef ? {
          rootIndex: attachmentRef.rootIndex,
          relativePath: attachmentRef.relativePath
        } : null,
        attachmentSha256,
        externalTransfer: true
      };
    }
    return {
      path: this.outputPathFor(intent),
      content: taskRequest.command.rawText,
      rawText: taskRequest.command.rawText,
      outputFormat: intent.slots?.outputFormat ?? 'txt',
      fileName: intent.slots?.fileName
    };
  }

  outputPathFor(intent) {
    if (intent.slots?.fileName) return this.workspacePathFor(intent.slots.fileName);
    if (intent.slots?.outputFormat === 'xlsx') return this.workspacePathFor('jarvis-output.xlsx');
    return this.workspacePathFor('jarvis-output.txt');
  }

  readTextPathFor(rawText, fileName) {
    const folderRequest = parseSearchDirectoryRequest(rawText ?? '');
    const directories = [...new Set(folderRequest.declarations.map(item => resolve(this.workspaceRoot, item.path)))];
    if (directories.length > 1) return null;
    const text = folderRequest.remainingText;
    const baseDirectory = directories[0] ?? this.workspaceRoot;
    const resolveSource = source => {
      const normalized = source.replace(/\\/g, '/');
      const candidate = isAbsolute(source) ? resolve(source)
        : resolve(baseDirectory, directories.length ? normalized : normalized.replace(/^(?:\.\/)?workspace\//i, ''));
      const scoped = relative(baseDirectory, candidate);
      return directories.length && (scoped === '..' || scoped.startsWith('..\\') || scoped.startsWith('../') || isAbsolute(scoped)) ? null : candidate;
    };
    const textExtension = /\.(?:txt|csv|json|jsonl|md|html?|xml|ya?ml|log|xlsx|pdf)$/iu;
    const quoted = [...text.matchAll(/"([^"\n]+)"|'([^'\n]+)'|“([^”\n]+)”|‘([^’\n]+)’/gu)]
      .map(match => match.slice(1).find(Boolean)?.trim()).filter(value => textExtension.test(value ?? ''));
    const explicit = quoted.length ? quoted
      : text.match(/(?:[a-z]:[\\/]|\\\\|\/)[^\s"'<>]*\.(?:txt|csv|json|jsonl|md|html?|xml|ya?ml|log|xlsx|pdf)\b/giu) ?? [];
    const candidates = [...new Set(explicit)];
    if (candidates.length > 1) return null;
    if (!candidates.length) {
      // Parser slots can contain an explicit unquoted relative/absolute source.
      // Read requests must never substitute another file to fit the workspace.
      const source = String(fileName ?? '').trim();
      return source ? resolveSource(source) : null;
    }
    const path = candidates[0];
    // Keep the requested source intact. E/B enforce allowed roots; substituting a
    // same-named workspace file would read different data while appearing successful.
    return resolveSource(path);
  }

  workspacePathFor(pathHint = '') {
    const raw = String(pathHint ?? '').trim();
    if (!raw || /^(?:\.\/)?workspace[\\\/]?$/i.test(raw)) return this.workspaceRoot;
    const normalized = raw.replace(/\\/g, '/');
    const withoutWorkspaceAlias = normalized.replace(/^(?:\.\/)?workspace\//i, '');
    const candidate = isAbsolute(raw)
      ? resolve(raw)
      : resolve(this.workspaceRoot, withoutWorkspaceAlias);
    const scoped = relative(this.workspaceRoot, candidate);
    if (scoped === '' || (!scoped.startsWith('..') && !isAbsolute(scoped))) return candidate;
    return resolve(this.workspaceRoot, basename(raw));
  }

  workspaceDirectoryFor(pathHint = '') {
    const raw = String(pathHint ?? '').trim();
    if (!raw || /^(?:\.|(?:\.\/)?workspace[\\\/]?|작업\s*폴더)$/iu.test(raw)) return this.workspaceRoot;
    const normalized = raw.replace(/\\/g, '/').replace(/^(?:\.\/)?workspace\//i, '');
    const candidate = isAbsolute(raw)
      ? resolve(raw)
      : resolve(this.workspaceRoot, normalized);
    const scoped = relative(this.workspaceRoot, candidate);
    if (scoped === '' || (!scoped.startsWith('..') && !isAbsolute(scoped))) return candidate;
    // A model-provided absolute path is advisory, never authority. For a list command,
    // falling back to the approved root is useful and safer than inventing root/basename.
    return this.workspaceRoot;
  }

  affectedItemsFor(intent, actionArguments) {
    if (intent.actionType === ActionType.BROWSER_SEARCH) return [{ type: 'read_only_web', query: actionArguments.query }];
    if (intent.actionType === ActionType.LIST_FILES) return [{ type: 'directory_listing', path: actionArguments.directory }];
    if (intent.actionType === ActionType.SEND_EMAIL) {
      return [{
        type: 'external_transfer',
        destination: 'email',
        recipient: actionArguments.to || actionArguments.name || (actionArguments.recipientMode === 'self' ? 'self' : 'unspecified'),
        recipientMode: actionArguments.recipientMode ?? 'unspecified',
        subject: actionArguments.subject || null,
        attachmentQuery: actionArguments.attachmentQuery || null,
        attachmentRef: actionArguments.attachmentRef || null,
        attachmentSha256: actionArguments.attachmentSha256 || null
      }];
    }
    if (intent.actionType === ActionType.DESKTOP_CONTROL) {
      return [{
        type: 'desktop_interaction',
        target: actionArguments.target ?? {},
        operationCount: actionArguments.operations?.length ?? 0
      }];
    }
    if (intent.actionType === ActionType.MOVE_FILE) {
      const firstMove = actionArguments.moves?.[0] ?? actionArguments;
      return [{
        type: 'planned_move',
        path: firstMove.from ?? './workspace',
        from: firstMove.from ?? null,
        to: firstMove.to ?? null
      }];
    }
    return [{ type: 'planned_output', path: actionArguments.path ?? actionArguments.outputPath }];
  }

  assumptionsFor(intent, taskRequest) {
    const assumptions = [];
    if (!intent.slots?.fileName && intent.actionType === ActionType.CREATE_FILE) {
      assumptions.push('파일명이 명시되지 않아 기본 jarvis-output 이름을 사용합니다.');
    }
    if (intent.unknown) {
      assumptions.push('명령 의도가 불명확하여 안전한 로컬 산출물 생성으로 대기합니다.');
    }
    if (taskRequest.attachments?.length === 0) {
      assumptions.push('첨부 파일 없이 텍스트 명령만 기준으로 계획합니다.');
    }
    return assumptions;
  }

  riskNotesFor(intent, planningGuardrails = []) {
    const notes = [];
    if (intent.entities?.hasPhoneNumber) notes.push('전화번호 형태의 민감정보가 포함될 수 있습니다.');
    if (intent.entities?.mentionsExternalDestination) notes.push('외부 전송 목적지가 언급되었습니다.');
    if (intent.complexity?.needsPlanDecomposition) notes.push('복합 명령이므로 단계 분해 확인이 필요합니다.');
    for (const guardrail of planningGuardrails) {
      notes.push(`[F 실패기억] ${guardrail.recommendation}`);
    }
    return notes;
  }

  planGraphFor({ taskRequest, intent, planSteps, action, affectedItems, skill, planningGuardrails = [] }) {
    const nodes = planSteps.map((step) => ({
      nodeId: `step_${step.order}`,
      order: step.order,
      module: step.module,
      description: step.description,
      preconditions: step.preconditions,
      postconditions: step.postconditions,
      rollbackHint: step.rollbackHint
    }));
    const actionNodes = this.actionNodesFor({ taskRequest, intent, action, affectedItems, skill });
    const allNodes = [...nodes, ...actionNodes];
    const edges = [];
    for (let index = 0; index < nodes.length - 1; index += 1) {
      edges.push({ from: nodes[index].nodeId, to: nodes[index + 1].nodeId, condition: 'success' });
    }
    const anchor = nodes[nodes.length - 1]?.nodeId;
    for (const node of actionNodes) {
      edges.push({ from: anchor, to: node.nodeId, condition: 'approval_granted' });
    }
    const actionDependencyCondition = this.actionDependencyConditionFor(taskRequest.command.rawText, intent);
    for (let index = 0; index < actionNodes.length - 1; index += 1) {
      edges.push({
        from: actionNodes[index].nodeId,
        to: actionNodes[index + 1].nodeId,
        condition: actionDependencyCondition,
        dependencyType: actionDependencyCondition === 'success' ? 'hard_dependency' : 'order_hint'
      });
    }
    const scheduler = this.planGraphScheduleFor({
      nodes: allNodes,
      edges,
      executionMode: actionDependencyCondition === 'success' ? 'sequential_safe' : 'parallel_ready'
    });
    return {
      graphId: stableId('plangraph', `${taskRequest.taskId}:${intent.intentId ?? intent.label}`, taskRequest.createdAt),
      createdAt: taskRequest.createdAt,
      strategy: actionNodes.length > 1 ? 'multi_action_dag' : 'single_action_linear',
      rootNodeId: allNodes[0]?.nodeId,
      terminalNodeIds: actionNodes.length ? [actionNodes[actionNodes.length - 1].nodeId] : [nodes[nodes.length - 1]?.nodeId],
      nodes: allNodes,
      edges,
      scheduler,
      invariants: [
        'No B module mutation before approval.',
        'Every mutating action requires a scoped capability token.',
        'Every completed mutating action must emit execution evidence.',
        ...planningGuardrails.map((guardrail) => `F failure guardrail ${guardrail.sourceFailureId}: ${guardrail.applyMode}`)
      ]
    };
  }

  actionDependencyConditionFor(rawText, intent) {
    if (!intent.complexity?.needsPlanDecomposition) return 'success';
    return /동시에|병렬|parallel|각각/i.test(String(rawText)) ? 'order_hint' : 'success';
  }

  planGraphScheduleFor({ nodes, edges, executionMode }) {
    const actionNodeIds = nodes
      .filter((node) => node.nodeId?.startsWith('action_'))
      .map((node) => node.nodeId);
    const hardDependencyEdges = edges
      .filter((edge) => edge.from?.startsWith('action_') && edge.to?.startsWith('action_') && edge.condition === 'success')
      .map((edge) => ({ from: edge.from, to: edge.to }));
    const orderHintEdges = edges
      .filter((edge) => edge.from?.startsWith('action_') && edge.to?.startsWith('action_') && edge.condition !== 'success')
      .map((edge) => ({ from: edge.from, to: edge.to, condition: edge.condition }));
    const dependencyMap = Object.fromEntries(actionNodeIds.map((nodeId) => [
      nodeId,
      hardDependencyEdges.filter((edge) => edge.to === nodeId).map((edge) => edge.from)
    ]));
    const remaining = new Set(actionNodeIds);
    const completed = new Set();
    const waves = [];
    while (remaining.size > 0) {
      const ready = [...remaining].filter((nodeId) => dependencyMap[nodeId].every((dependency) => completed.has(dependency)));
      if (ready.length === 0) {
        waves.push({
          waveIndex: waves.length + 1,
          nodeIds: [...remaining],
          status: 'blocked_by_cycle',
          parallelizable: false
        });
        break;
      }
      const waveNodeIds = executionMode === 'parallel_ready' ? ready : ready.slice(0, 1);
      for (const nodeId of waveNodeIds) {
        remaining.delete(nodeId);
        completed.add(nodeId);
      }
      waves.push({
        waveIndex: waves.length + 1,
        nodeIds: waveNodeIds,
        status: 'ready',
        parallelizable: waveNodeIds.length > 1
      });
    }
    return {
      scheduleVersion: 'a-plan-parallel-dag-scheduler-v1',
      mode: executionMode,
      maxParallelism: Math.max(1, ...waves.map((wave) => wave.nodeIds.length)),
      waves,
      dependencyMap,
      hardDependencyEdges,
      orderHintEdges,
      schedulerContract: 'Hard success dependencies serialize execution; order_hint edges keep user-facing order while allowing independent action nodes to share a wave.'
    };
  }

  actionNodesFor({ taskRequest, intent, action, affectedItems, skill }) {
    const parts = this.decomposeActions(taskRequest.command.rawText, intent);
    return parts.map((part, index) => ({
      nodeId: `action_${index + 1}`,
      order: 100 + index + 1,
      module: skill.module ?? 'B_PC_AGENT',
      actionType: action.actionType,
      toolName: action.toolName,
      description: part.description,
      arguments: {
        ...action.arguments,
        rawText: part.text,
        ...(['source.readSelectedInbox','case.readLocalRecord','source.collectMicrosoftMetadata'].includes(action.toolName) ? {} : { sequenceIndex: index })
      },
      affectedItems,
      preconditions: ['ApprovalDecision.approved', 'CapabilityToken.valid'],
      postconditions: ['ExecutionEvidence.available'],
      compensationRef: action.actionType === ActionType.BROWSER_SEARCH || action.actionType === ActionType.LIST_FILES
        ? null
        : `compensate_action_${index + 1}`
    }));
  }

  decomposeActions(rawText, intent) {
    // A desktop plan already contains an ordered, postcondition-bound operation list.
    // Splitting its natural-language sentence would duplicate the complete transaction
    // on every action node and could repeat irreversible clicks.
    if (intent.actionType === ActionType.DESKTOP_CONTROL) {
      return [{ text: rawText, description: `${intent.title ?? intent.label} 실행` }];
    }
    const separators = /\s*(?:그리고|그 다음|다음으로|후에|,|;)\s*/;
    const parts = String(rawText)
      .split(separators)
      .map((text) => text.trim())
      .filter((text) => text.length > 0);
    if (!intent.complexity?.needsPlanDecomposition || parts.length <= 1) {
      return [{ text: rawText, description: `${intent.title ?? intent.label} 실행` }];
    }
    return parts.slice(0, 5).map((text, index) => ({
      text,
      description: `복합 작업 ${index + 1}: ${text}`
    }));
  }

  failureBranchesFor({ intent, action, affectedItems, planGraph }) {
    const branches = [
      {
        branchId: 'failure_policy_block',
        trigger: 'PolicyResult.block',
        ownerModule: 'E_POLICY_SECURITY',
        nextStatus: 'blocked',
        userMessage: '정책 차단 사유를 승인 카드에 표시하고 실행을 시작하지 않습니다.',
        compensationRequired: false
      },
      {
        branchId: 'failure_capability_invalid',
        trigger: 'CapabilityToken.invalid_or_expired',
        ownerModule: 'A_CORE',
        nextStatus: 'waiting_approval',
        userMessage: '권한 토큰을 재발급하고 승인/확인을 다시 요구합니다.',
        compensationRequired: false
      },
      {
        branchId: 'failure_execution_partial',
        trigger: 'BExecution.partial_failure',
        ownerModule: 'B_PC_AGENT',
        nextStatus: 'failed',
        userMessage: '부분 실행 증거와 되돌림 가능 여부를 결과 카드에 표시합니다.',
        compensationRequired: action.actionType !== ActionType.BROWSER_SEARCH && action.actionType !== ActionType.LIST_FILES,
        affectedItems
      }
    ];
    if (intent.complexity?.needsPlanDecomposition || planGraph.strategy === 'multi_action_dag') {
      branches.push({
        branchId: 'failure_dag_node_failed',
        trigger: 'PlanGraph.node_failed',
        ownerModule: 'A_CORE',
        nextStatus: 'failed',
        userMessage: '실패 노드 이후의 dependent node를 실행하지 않고 compensation 후보를 생성합니다.',
        compensationRequired: true,
        blockedNodePolicy: 'skip_descendants'
      });
    }
    return branches;
  }

  compensationPlanFor({ action, affectedItems, planGraph, failureBranches }) {
    const compensatingActions = planGraph.nodes
      .filter((node) => node.compensationRef)
      .map((node) => ({
        compensationId: node.compensationRef,
        targetNodeId: node.nodeId,
        action: node.actionType === ActionType.MOVE_FILE ? 'reverse_move'
          : node.actionType === ActionType.CREATE_FILE ? 'delete_created_output'
            : 'record_manual_review',
        affectedItems,
        requiresEvidence: true,
        safeMode: 'approval_required_before_compensation'
      }));
    return {
      compensationPlanId: stableId('compensation', planGraph.graphId, planGraph.createdAt),
      strategy: compensatingActions.length ? 'rollback_or_manual_review' : 'no_mutation_no_compensation',
      failureBranchIds: failureBranches.filter((branch) => branch.compensationRequired).map((branch) => branch.branchId),
      compensatingActions,
      evidenceRequired: ['ExecutionEvidence', 'UndoJournal', 'VerificationResult'],
      userVisibleSummary: compensatingActions.length
        ? '실패 시 생성/변경된 항목을 증거 기반으로 되돌리거나 수동 검토로 보냅니다.'
        : '읽기 전용 작업은 로컬 변경이 없어 보상 실행이 필요하지 않습니다.'
    };
  }
}

function parseJarvisArtifactReference(value) {
  const match = String(value ?? '').match(/jarvis-artifact:\/\/(\d+)\/([^\s"'<>]+)/i);
  if (!match) return null;
  try {
    const relativePath = decodeURIComponent(match[2]).replaceAll('\\', '/').replace(/^\/+/, '');
    if (!relativePath) return null;
    return {
      rootIndex: Number(match[1]),
      relativePath,
      name: basename(relativePath)
    };
  } catch {
    return null;
  }
}

function parseAttachmentSha256(value) {
  const match = String(value ?? '').match(/(?:첨부\s*)?SHA\s*-?\s*256\s*[:：]?\s*([a-f0-9]{64})/iu);
  return match?.[1]?.toLowerCase() ?? null;
}
