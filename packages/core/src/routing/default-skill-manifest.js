import { ActionType, ModuleId, TrustBoundary } from '../../../shared/src/types.js';

export const defaultSkillManifest = Object.freeze([
  {skillId:'xlsx_existing_pdf_export_skill',version:'1.0.0',label:'기존 엑셀 PDF 출력',module:ModuleId.PC_AGENT,category:'document',actionType:ActionType.CREATE_FILE,toolName:'excel.exportPdf',
    match:{workflows:['export-existing-xlsx-pdf'],keywords:['기존 엑셀 PDF 출력']},capability:{readsLocalFiles:true,writesLocalFiles:true,externalNetwork:false,externalTransfer:false,reversible:true,requiresApproval:true,maxRiskTier:5,allowedModes:['shadow','execute']},
    safety:{trustBoundary:TrustBoundary.USER_COMMAND,dataClasses:['user_text'],blockedWhen:['externalTransfer=true']},adapterContract:{preview:true,execute:true,rollback:true,evidence:['pdfExport','undoJournalId']}},
  {skillId:'xlsx_region_read_skill',version:'1.0.0',label:'엑셀 내용 읽기',module:ModuleId.PC_AGENT,category:'document',actionType:ActionType.SEARCH_FILES,toolName:'excel.readWorkbook',
    match:{workflows:['read-xlsx-file'],keywords:['엑셀 읽기']},capability:{readsLocalFiles:true,writesLocalFiles:false,externalNetwork:false,externalTransfer:false,reversible:false,requiresApproval:false,maxRiskTier:5,allowedModes:['shadow','execute']},
    safety:{trustBoundary:TrustBoundary.USER_COMMAND,dataClasses:['user_text'],blockedWhen:['externalTransfer=true']},adapterContract:{preview:true,execute:true,rollback:false,evidence:['contentSha256','xlsxRead']}},
  {skillId:'pdf_text_read_skill',version:'1.0.0',label:'PDF 내용 읽기',module:ModuleId.PC_AGENT,category:'document',actionType:ActionType.SEARCH_FILES,toolName:'document.readPdf',
    match:{workflows:['read-pdf-file'],keywords:['PDF 읽기']},
    capability:{readsLocalFiles:true,writesLocalFiles:false,externalNetwork:false,externalTransfer:false,reversible:false,requiresApproval:false,maxRiskTier:5,allowedModes:['shadow','execute']},
    safety:{trustBoundary:TrustBoundary.USER_COMMAND,dataClasses:['user_text'],blockedWhen:['externalTransfer=true']},
    adapterContract:{preview:true,execute:true,rollback:false,evidence:['contentSha256','pdfRead']}},
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
    skillId: 'word_document_skill',
    version: '1.0.0',
    label: 'Word Document Create',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'word.create',
    match: {
      outputFormats: ['docx', 'pdf'],
      keywords: ['워드', 'word', 'docx', '보고서', '문서', 'pdf']
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
      evidence: ['outputPath', 'sha256', 'blockCount']
    }
  },
  {
    skillId: 'powerpoint_deck_skill',
    version: '1.0.0',
    label: 'PowerPoint Deck Create',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'powerpoint.create',
    match: {
      outputFormats: ['pptx'],
      keywords: ['파워포인트', 'powerpoint', 'pptx', 'ppt', '프레젠테이션', '슬라이드', '발표']
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
      evidence: ['outputPath', 'sha256', 'slideCount']
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
      outputFormats: ['txt'],
      keywords: ['메모', '텍스트', 'txt', 'md', 'markdown', 'csv', 'json', 'html', '로그']
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
    skillId: 'visual_card_create_skill',
    version: '1.0.0',
    label: 'Verified PNG Card Create',
    module: ModuleId.PC_AGENT,
    category: 'visual',
    actionType: ActionType.CREATE_FILE,
    toolName: 'visual.createCards',
    match: {
      outputFormats: ['png'],
      keywords: ['png', '뉴스 카드', '이미지 카드', '시각화 카드', '카드 이미지']
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
      dataClasses: ['user_text', 'public_summary'],
      blockedWhen: ['outsideAllowedRoots=true', 'targetExists=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['outputPaths', 'cardCount', 'cards', 'undoJournalIds']
    }
  },
  {
    skillId: 'archive_zip_create_skill',
    version: '1.0.0',
    label: 'Verified ZIP Archive Create',
    module: ModuleId.PC_AGENT,
    category: 'archive',
    actionType: ActionType.CREATE_FILE,
    toolName: 'archive.createZip',
    match: {
      outputFormats: ['zip'],
      keywords: ['zip', '압축', '묶음', '번들']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['file_path', 'file_metadata'],
      blockedWhen: ['outsideAllowedRoots=true', 'inputMissing=true', 'targetExists=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'entryCount', 'entries', 'undoJournalId']
    }
  },
  {
    skillId: 'macro_save_skill',
    version: '1.0.0',
    label: '매크로 저장',
    module: ModuleId.PC_AGENT,
    category: 'system',
    actionType: ActionType.MACRO_SAVE,
    toolName: 'macro.save',
    match: {
      keywords: ['저장', '기억', '매크로']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: true,
      externalNetwork: false,
      externalTransfer: false,
      reversible: true,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['tool_metadata'],
      blockedWhen: []
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['macroName']
    }
  },
  {
    skillId: 'capability_query_skill',
    version: '1.0.0',
    label: '능력 조회',
    module: ModuleId.PC_AGENT,
    category: 'system',
    actionType: ActionType.CAPABILITY_QUERY,
    toolName: 'capability.describe',
    match: {
      keywords: ['능력', '기능', '할 수 있는', '뭘 할', '무엇을']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['tool_metadata'],
      blockedWhen: []
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['capabilityCount']
    }
  },
  {
    skillId: 'weekly_weather_hwp_report_skill',
    version: '1.0.0',
    label: 'Weekly Weather HWP Report',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'weather.createHwpReport',
    match: {
      outputFormats: ['hwp', 'hwpx'],
      workflows: ['weekly-weather-hwp-report'],
      keywords: ['날씨 통계', '기상 통계', '주간 예보', '날씨 표']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: true,
      externalNetwork: true,
      externalTransfer: false,
      reversible: true,
      requiresApproval: true,
      maxRiskTier: 4,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['location_query', 'public_weather_data'],
      blockedWhen: ['locationMissing=true', 'outsideAllowedRoots=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: true,
      evidence: ['outputPath', 'sha256', 'weatherReport.sourceUrl', 'weatherReport.retrievedAt', 'weatherReport.rowCount']
    }
  },
  {
    skillId: 'hwp_create_skill',
    version: '1.0.0',
    label: 'Hangul (HWP) File Create',
    module: ModuleId.PC_AGENT,
    category: 'document',
    actionType: ActionType.CREATE_FILE,
    toolName: 'hwp.create',
    match: {
      outputFormats: ['hwp', 'hwpx'],
      keywords: ['한글', 'hwp', '아래아']
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
    skillId: 'file_read_text_skill',
    version: '1.0.0',
    label: 'Verified Text File Read',
    module: ModuleId.PC_AGENT,
    category: 'filesystem',
    actionType: ActionType.SEARCH_FILES,
    toolName: 'filesystem.readText',
    match: {
      workflows: ['read-text-file'],
      keywords: ['내용 읽어', '본문 읽어', '파일 읽어', '열어서 읽어', '원문 확인', '내용 확인', '.txt', '.csv', '.json', '.jsonl', '.md', '.html', '.xml', '.yaml', '.log']
    },
    capability: {
      readsLocalFiles: true,
      writesLocalFiles: false,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.LOCAL_FILE_CONTENT,
      dataClasses: ['file_content'],
      blockedWhen: ['outsideAllowedRoots=true', 'unsupportedBinary=true', 'fileTooLarge=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['pathHash', 'contentSha256', 'bytes', 'offset', 'returnedChars', 'truncated']
    }
  },
  {
    skillId: 'news_headlines_fetch_skill',
    version: '1.0.0',
    label: 'Live Korean News Headlines',
    module: ModuleId.PC_AGENT,
    category: 'browser',
    actionType: ActionType.BROWSER_SEARCH,
    toolName: 'news.fetchHeadlines',
    match: {
      workflows: ['news-headlines'],
      keywords: ['뉴스', '핫뉴스', '헤드라인', '속보', '오늘 뉴스', '최신 뉴스']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: false,
      reversible: false,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.WEB_CONTENT,
      dataClasses: ['public_news_metadata'],
      blockedWhen: ['readOnly=false', 'fixture=true', 'sourceHostMismatch=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['news.live', 'news.retrievedAt', 'news.sourceUrl', 'news.sourceHost', 'news.items']
    }
  },
  {
    skillId: 'publisher_rss_feed_fetch_skill',
    version: '1.0.0',
    label: 'Safe Public Publisher RSS Feed',
    module: ModuleId.PC_AGENT,
    category: 'browser',
    actionType: ActionType.BROWSER_SEARCH,
    toolName: 'news.fetchPublisherFeed',
    match: {
      workflows: ['publisher-news-feed'],
      keywords: ['게시자 RSS', '언론사 RSS', '뉴스 피드 주소', '원문사 피드', 'publisher rss']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: false,
      reversible: false,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.WEB_CONTENT,
      dataClasses: ['public_news_metadata'],
      blockedWhen: ['nonHttps=true', 'privateAddress=true', 'fixture=true', 'sourceNotRss=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['news.live', 'news.feedUrl', 'news.finalFeedUrl', 'news.items']
    }
  },
  {
    skillId: 'news_article_read_skill',
    version: '1.0.0',
    label: 'Safe Public News Article Reader',
    module: ModuleId.PC_AGENT,
    category: 'browser',
    actionType: ActionType.BROWSER_SEARCH,
    toolName: 'news.fetchArticle',
    match: {
      workflows: ['news-article-read'],
      keywords: ['기사 본문', '기사 원문', '이 기사 읽', '기사 링크 읽', '본문을 읽고 요약', '뉴스 기사 내용']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: true,
      externalTransfer: false,
      reversible: false,
      requiresApproval: false,
      maxRiskTier: 5,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.WEB_CONTENT,
      dataClasses: ['public_article_content'],
      blockedWhen: ['nonHttps=true', 'privateAddress=true', 'bodyUnavailable=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['article.live', 'article.finalUrl', 'article.textSha256', 'article.textCharacters']
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
    skillId: 'windows_desktop_control_skill',
    version: '1.0.0',
    label: 'Windows Desktop Control',
    module: ModuleId.PC_AGENT,
    category: 'desktop',
    actionType: ActionType.DESKTOP_CONTROL,
    toolName: 'desktop.control',
    match: {
      keywords: ['창', '화면', '버튼', '메뉴', '클릭', '입력', '포커스', 'UI Automation']
    },
    capability: {
      readsLocalFiles: false,
      writesLocalFiles: false,
      externalNetwork: false,
      externalTransfer: false,
      reversible: false,
      requiresApproval: true,
      requiresDesktopApproval: true,
      maxRiskTier: 3,
      allowedModes: ['shadow', 'execute']
    },
    safety: {
      trustBoundary: TrustBoundary.USER_COMMAND,
      dataClasses: ['desktop_ui_state'],
      blockedWhen: ['passwordControl=true', 'scriptHostLaunch=true', 'verificationMissing=true', 'rawCoordinateClick=true', 'untrustedTemplate=true', 'ambiguousVisualTarget=true']
    },
    adapterContract: {
      preview: true,
      execute: true,
      rollback: false,
      evidence: ['operationCount', 'verification', 'observedWindow', 'interactiveSession', 'localOcrPerception', 'localTemplatePerception']
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
