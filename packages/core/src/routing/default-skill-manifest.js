import { ActionType, ModuleId, TrustBoundary } from '../../../shared/src/types.js';

export const defaultSkillManifest = Object.freeze([
  {
    skillId: 'excel_workbook_skill',
    version: '1.0.0',
    label: 'Excel Workbook Create',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'excel.createWorkbook',
    match: {
      outputFormats: ['xlsx'],
      keywords: ['엑셀', 'xlsx', '스프레드시트']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['user_text'],
      blockedWhen: ['externalTransfer=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'workbook.sheetName', 'rowCount']
    }
  },
  {
    skillId: 'text_file_create_skill',
    version: '1.0.0',
    label: 'Text File Create',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'filesystem.createTextFile',
    match: {
      outputFormats: ['txt', 'docx', 'pdf'],
      keywords: ['보고서', '안내문', '문서', '메모', '작성', '생성']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['user_text'],
      blockedWhen: ['externalTransfer=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['outputPath', 'sha256']
    }
  },
  {
    skillId: 'file_list_skill',
    version: '1.0.0',
    label: 'File List',
    module: ModuleId.PC_AGENT,
    category: 'filesystem',
    actionType: ActionType.LIST_FILES,
    toolName: 'filesystem.listFiles',
    match: {
      keywords: ['목록', '리스트', '폴더', '파일']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: false,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['file_metadata'],
      blockedWhen: ['outsideAllowedRoots=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['directory', 'itemCount']
    }
  },
  {
    skillId: 'file_move_skill',
    version: '1.0.0',
    label: 'File Move',
    module: ModuleId.PC_AGENT,
    category: 'filesystem',
    actionType: ActionType.MOVE_FILE,
    toolName: 'filesystem.moveFiles',
    match: {
      keywords: ['이동', '옮겨', 'move']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 4,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['file_path', 'file_metadata'],
      blockedWhen: ['outsideAllowedRoots=true', 'destructiveMove=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['from', 'to', 'undoJournalId']
    }
  },
  {
    skillId: 'browser_search_skill',
    version: '1.0.0',
    label: 'Read-only Browser Search',
    module: ModuleId.PC_AGENT,
    category: 'browser',
    actionType: ActionType.BROWSER_SEARCH,
    toolName: 'browser.search',
    match: {
      keywords: ['검색', '조사', '찾아', '브라우저']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.WEB_CONTENT,
      dataClasses: ['public_web'],
      blockedWhen: ['readOnly=false', 'downloadRequested=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['query', 'searchEngine', 'readOnly']
    }
  },
  {
    skillId: 'shell_execute_skill',
    version: '1.0.0',
    label: 'Shell Command Execute',
    module: ModuleId.PC_AGENT,
    category: 'system',
    actionType: ActionType.SHELL_EXECUTE,
    toolName: 'shell.execute',
    match: {
      keywords: ['명령어', '실행', 'cmd', 'powershell', '터미널', '셸', '쉘', '프로그램', '열어', '실행해', '스크립트']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      // 셸은 되돌릴 수 없고 광범위한 영향을 주므로 위험 등급을 높게 둔다(낮을수록 위험).
      // 삭제/포맷/전송성 명령은 어댑터가 정적 차단하고, 그 외는 승인 카드에 실제 명령을 노출한다.
      maxRiskTier: 2,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['shell_command'],
      blockedWhen: ['destructiveCommand=true', 'externalTransfer=true', 'capabilityTokenMissing=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['command', 'shell', 'exitCode', 'stdoutPreview']
    }
  },
  {
    skillId: 'file_search_skill',
    version: '1.0.0',
    label: 'File Search',
    module: ModuleId.PC_AGENT,
    category: 'filesystem',
    actionType: ActionType.SEARCH_FILES,
    toolName: 'filesystem.searchFiles',
    match: {
      keywords: ['찾아', '검색', '어디', '파일 찾', '문서 찾', 'find', 'search']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: false,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['file_metadata', 'file_path'],
      blockedWhen: ['outsideAllowedRoots=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['query', 'matchCount', 'roots']
    }
  },
  {
    skillId: 'email_send_skill',
    version: '1.0.0',
    label: 'Email Send',
    module: ModuleId.PC_AGENT,
    category: 'external',
    actionType: ActionType.SEND_EMAIL,
    toolName: 'email.send',
    match: {
      keywords: ['메일', '이메일', '메일로', '보내', '전송', 'email', 'mail']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: true,
      reversible: false,
      requiresApproval: true,
      requiresDesktopApproval: true,
      // 외부로 데이터가 나가므로 최고 위험 등급. 첨부·수신자·본문이 승인 카드에 노출된다.
      maxRiskTier: 2,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['potential_sensitive_file', 'recipient_address'],
      blockedWhen: ['recipientMissing=true', 'smtpNotConfigured=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['to', 'subject', 'attachmentCount']
    }
  },
  {
    skillId: 'document_edit_skill',
    version: '1.0.0',
    label: 'Document Edit',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.EDIT_DOCUMENT,
    toolName: 'document.edit',
    match: {
      outputFormats: ['xlsx'],
      keywords: ['수정', '고쳐', '바꿔', '편집', '변경', '채워', '입력', '표에']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 3,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['user_text', 'file_content'],
      blockedWhen: ['outsideAllowedRoots=true', 'targetFileMissing=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['targetPath', 'editedCells', 'backupPath']
    }
  },
  {
    skillId: 'external_transfer_review_skill',
    version: '1.0.0',
    label: 'External Transfer Review',
    module: ModuleId.POLICY_SECURITY,
    category: 'external',
    actionType: ActionType.UPLOAD_FILE,
    toolName: 'externalTransfer.reviewOnly',
    match: {
      keywords: ['전송', '업로드', '메일', '카톡', '밴드', '공유']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: true,
      reversible: false,
      requiresApproval: true,
      requiresDesktopApproval: true,
      maxRiskTier: 3,
      allowedModes: ['shadow']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['potential_sensitive_file'],
      blockedWhen: ['mobileApprovalOnly=true', 'capabilityTokenMissing=true']
    },
    adapterContract: {
      preview: true,
      execute: false,
      rollback: false,
      evidence: ['destination', 'fileName', 'approvalPath']
    }
  }
]);
