import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const approvalPhrase = 'APPROVED_FOR_COMMERCIAL_RELEASE';
const hashPattern = /^[a-f0-9]{64}$/i;
const fieldDefinitions = Object.freeze([
  ['operatorName', 'JARVIS_LEGAL_OPERATOR_NAME', '운영자 또는 사업자명'],
  ['operatorType', 'JARVIS_LEGAL_OPERATOR_TYPE', '운영자 유형(개인/개인사업자/법인)'],
  ['businessAddress', 'JARVIS_LEGAL_BUSINESS_ADDRESS', '사업장 또는 통지 주소'],
  ['supportEmail', 'JARVIS_LEGAL_SUPPORT_EMAIL', '고객지원 이메일'],
  ['privacyOfficer', 'JARVIS_LEGAL_PRIVACY_OFFICER', '개인정보 보호책임자 또는 담당 부서'],
  ['privacyEmail', 'JARVIS_LEGAL_PRIVACY_EMAIL', '개인정보 문의 이메일'],
  ['privacyPhone', 'JARVIS_LEGAL_PRIVACY_PHONE', '개인정보 문의 전화번호'],
  ['salesRegion', 'JARVIS_LEGAL_SALES_REGION', '판매 및 서비스 지역'],
  ['thirdPartyProviders', 'JARVIS_LEGAL_THIRD_PARTY_PROVIDERS', '사용 예정 외부 처리자/AI 공급자'],
  ['governingLaw', 'JARVIS_LEGAL_GOVERNING_LAW', '준거법'],
  ['venue', 'JARVIS_LEGAL_VENUE', '전속 관할 또는 분쟁 해결 기준'],
  ['effectiveDate', 'JARVIS_LEGAL_EFFECTIVE_DATE', '시행일(YYYY-MM-DD)'],
  ['reviewerName', 'JARVIS_LEGAL_REVIEWER_NAME', '법률 검토자 또는 승인 책임자']
]);

export function collectLegalReleaseIntake({ env = process.env } = {}) {
  const values = Object.fromEntries(fieldDefinitions.map(([key, variable]) => [key, clean(env[variable])]));
  const missingFields = fieldDefinitions
    .filter(([key]) => !values[key])
    .map(([key, variable, label]) => ({ key, variable, label }));
  const effectiveDateValid = /^\d{4}-\d{2}-\d{2}$/.test(values.effectiveDate);
  if (values.effectiveDate && !effectiveDateValid) {
    missingFields.push({
      key: 'effectiveDate',
      variable: 'JARVIS_LEGAL_EFFECTIVE_DATE',
      label: '시행일은 YYYY-MM-DD 형식이어야 함'
    });
  }
  const approvalConfirmed = clean(env.JARVIS_LEGAL_REVIEW_APPROVED) === approvalPhrase;
  const providedBundleSha256 = clean(env.JARVIS_LEGAL_REVIEW_BUNDLE_SHA256).toLowerCase();
  return {
    intakeVersion: 'jarvis-legal-release-intake-v1',
    values,
    missingFields: uniqueByKey(missingFields),
    approval: {
      confirmed: approvalConfirmed,
      requiredPhrase: approvalPhrase,
      reviewerPresent: Boolean(values.reviewerName),
      bundleSha256Provided: hashPattern.test(providedBundleSha256),
      providedBundleSha256
    },
    readyToFinalize: false
  };
}

export function createLegalReleasePack({ env = process.env, clock = () => new Date() } = {}) {
  const intake = collectLegalReleaseIntake({ env });
  const generatedAt = clock().toISOString();
  const baseContext = {
    ...Object.fromEntries(fieldDefinitions.map(([key, , label]) => [key, intake.values[key] || marker(label)])),
    generatedAt,
    year: generatedAt.slice(0, 4)
  };
  const reviewDocuments = renderDocuments({ ...baseContext, reviewStatus: 'approved' });
  const reviewBundleSha256 = legalDocumentBundleSha256(reviewDocuments);
  const bundleSha256Matches = intake.approval.providedBundleSha256 === reviewBundleSha256;
  const readyToFinalize = intake.missingFields.length === 0
    && intake.approval.confirmed
    && intake.approval.bundleSha256Provided
    && bundleSha256Matches;
  const documents = renderDocuments({ ...baseContext, reviewStatus: readyToFinalize ? 'approved' : 'draft' });
  const approval = {
    ...intake.approval,
    bundleSha256Matches,
    requiredBundleSha256: reviewBundleSha256,
    providedBundleSha256: undefined
  };
  return {
    reportVersion: 'jarvis-legal-release-pack-v1',
    generatedAt,
    status: readyToFinalize
      ? 'ready-to-finalize'
      : intake.missingFields.length > 0
        ? 'owner-input-required'
        : 'legal-approval-required',
    readyToFinalize,
    missingFields: intake.missingFields,
    approval,
    reviewBundle: {
      sha256: reviewBundleSha256,
      documentNames: ['LICENSE', 'PRIVACY.md', 'EULA.md'],
      exactDocumentApprovalRequired: true
    },
    documents,
    reviewDocuments,
    safeguards: {
      draftFilesAreNotDistributionDocuments: true,
      rootDocumentsRequireExplicitFinalizeFlag: true,
      explicitApprovalPhraseRequired: true,
      approvalBoundToExactDocumentHash: true,
      staleApprovalRejected: true,
      secretsStoredInDocuments: false,
      legalReviewCannotBeAutomated: true
    }
  };
}

export async function writeLegalReleasePack(pack, {
  workspaceRoot = process.cwd(),
  outputDir = 'dist/legal-release-pack',
  finalize = false
} = {}) {
  const root = resolve(workspaceRoot);
  const drafts = resolve(root, outputDir);
  await mkdir(drafts, { recursive: true });
  const report = {
    ...pack,
    documents: {
      license: {
        draftPath: join(outputDir, 'LICENSE.draft.md'),
        reviewPath: join(outputDir, 'LICENSE.review.md')
      },
      privacy: {
        draftPath: join(outputDir, 'PRIVACY.draft.md'),
        reviewPath: join(outputDir, 'PRIVACY.review.md')
      },
      eula: {
        draftPath: join(outputDir, 'EULA.draft.md'),
        reviewPath: join(outputDir, 'EULA.review.md')
      }
    }
  };
  delete report.reviewDocuments;
  await Promise.all([
    writeFile(join(drafts, 'LICENSE.draft.md'), pack.documents.license, 'utf8'),
    writeFile(join(drafts, 'PRIVACY.draft.md'), pack.documents.privacy, 'utf8'),
    writeFile(join(drafts, 'EULA.draft.md'), pack.documents.eula, 'utf8'),
    writeFile(join(drafts, 'LICENSE.review.md'), pack.reviewDocuments.license, 'utf8'),
    writeFile(join(drafts, 'PRIVACY.review.md'), pack.reviewDocuments.privacy, 'utf8'),
    writeFile(join(drafts, 'EULA.review.md'), pack.reviewDocuments.eula, 'utf8'),
    writeFile(join(drafts, 'legal-release-pack.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8'),
    writeFile(join(drafts, 'legal-release-pack.md'), renderReport(report), 'utf8')
  ]);

  if (!finalize) return { ...report, status: pack.status, finalized: false };
  if (!pack.readyToFinalize) {
    const missing = pack.missingFields.map((item) => item.variable).join(', ');
    const reason = !pack.approval.confirmed
      ? 'legal-release-approval-required'
      : !pack.approval.bundleSha256Provided
        ? 'legal-release-bundle-hash-required'
        : 'legal-release-bundle-hash-mismatch';
    throw new Error(missing ? `legal-release-input-incomplete:${missing}` : reason);
  }
  if (legalDocumentBundleSha256(pack.reviewDocuments) !== pack.reviewBundle.sha256) {
    throw new Error('legal-release-review-bundle-integrity-failed');
  }

  const packagePath = join(root, 'package.json');
  const packageManifest = JSON.parse(await readFile(packagePath, 'utf8'));
  packageManifest.license = 'SEE LICENSE IN LICENSE';
  await Promise.all([
    writeFile(join(root, 'LICENSE'), pack.reviewDocuments.license, 'utf8'),
    writeFile(join(root, 'PRIVACY.md'), pack.reviewDocuments.privacy, 'utf8'),
    writeFile(join(root, 'EULA.md'), pack.reviewDocuments.eula, 'utf8'),
    writeFile(packagePath, `${JSON.stringify(packageManifest, null, 2)}\n`, 'utf8')
  ]);
  const finalizedReport = {
    ...report,
    status: 'finalized',
    finalized: true,
    approvalReceipt: {
      receiptVersion: 'jarvis-legal-release-approval-receipt-v1',
      finalizedAt: new Date().toISOString(),
      reviewerName: pack.approval.reviewerPresent ? pack.reviewDocuments.license.match(/^Legal-Reviewer:\s*(.+)$/m)?.[1] ?? null : null,
      reviewBundleSha256: pack.reviewBundle.sha256,
      explicitApprovalConfirmed: true,
      rawApprovalPhraseStored: false
    }
  };
  await writeFile(join(drafts, 'legal-release-pack.json'), `${JSON.stringify(finalizedReport, null, 2)}\n`, 'utf8');
  await writeFile(join(drafts, 'legal-release-pack.md'), renderReport(finalizedReport), 'utf8');
  await writeFile(join(drafts, 'legal-release-approval.json'), `${JSON.stringify(finalizedReport.approvalReceipt, null, 2)}\n`, 'utf8');
  return finalizedReport;
}

export function legalDocumentBundleSha256(documents) {
  return createHash('sha256').update([
    `LICENSE\0${documents.license}`,
    `PRIVACY.md\0${documents.privacy}`,
    `EULA.md\0${documents.eula}`
  ].join('\0')).digest('hex');
}

function renderDocuments(context) {
  return {
    license: renderLicense(context),
    privacy: renderPrivacy(context),
    eula: renderEula(context)
  };
}

function metadata(context, title) {
  return [
    `# ${title}`,
    '',
    `Legal-Review-Status: ${context.reviewStatus}`,
    `Legal-Reviewer: ${context.reviewerName}`,
    `Effective-Date: ${context.effectiveDate}`,
    '',
    context.reviewStatus === 'approved'
      ? '> 본 문서는 지정된 승인 책임자의 명시적 승인을 거쳐 배포용으로 생성되었습니다.'
      : '> 배포 금지: 이 문서는 자동 생성 초안이며 법률 검토와 제품 소유자의 승인이 필요합니다.',
    ''
  ].join('\n');
}

function renderLicense(context) {
  return `${metadata(context, 'JARVIS 상용 소프트웨어 라이선스')}저작권 (c) ${context.year} ${context.operatorName}. 모든 권리 보유.

## 1. 허용 범위

정당하게 라이선스를 취득한 사용자는 구매 또는 별도 계약에서 정한 장치 수와 기간 동안 JARVIS 소프트웨어를 설치하고 사용할 수 있습니다. 별도 서면 허가가 없는 한 라이선스는 비독점적이고 양도할 수 없습니다.

## 2. 제한

사용자는 관련 법령이 명시적으로 허용하는 범위를 제외하고 소프트웨어를 재판매, 재배포, 임대, 공개 호스팅, 서브라이선스, 역공학, 보안 우회 또는 파생 제품의 기반으로 사용할 수 없습니다. 인증서, 토큰, 모델 자격증명 및 장치 페어링 정보는 제3자에게 제공해서는 안 됩니다.

## 3. 소유권과 제3자 구성요소

JARVIS와 그 자체 구성요소의 권리는 ${context.operatorName}에게 있습니다. 함께 배포되는 오픈소스 또는 제3자 구성요소에는 해당 구성요소의 별도 라이선스가 우선 적용됩니다.

## 4. 업데이트와 종료

보안, 호환성 또는 기능 개선을 위해 업데이트가 제공될 수 있습니다. 중대한 위반이 시정되지 않으면 라이선스가 종료될 수 있으며, 종료 시 사용자는 소프트웨어와 배포 사본의 사용을 중단해야 합니다.

## 5. 문의

- 운영자: ${context.operatorName} (${context.operatorType})
- 주소: ${context.businessAddress}
- 이메일: ${context.supportEmail}
`;
}

function renderPrivacy(context) {
  return `${metadata(context, 'JARVIS 개인정보 처리방침')}JARVIS 운영자 ${context.operatorName}(이하 "운영자")는 ${context.salesRegion}에서 서비스하며 개인정보 보호 관련 법령을 준수합니다.

## 1. 개인정보 처리자

- 운영자: ${context.operatorName} (${context.operatorType})
- 주소: ${context.businessAddress}
- 개인정보 보호책임자/부서: ${context.privacyOfficer}
- 문의: ${context.privacyEmail}, ${context.privacyPhone}

## 2. 처리 목적과 항목

JARVIS는 사용자가 요청한 PC·모바일·웨어러블 작업 수행, 장치 페어링과 승인, 설정·기억 유지, 장애 진단, 보안 감사 및 고객지원을 위해 필요한 범위에서 데이터를 처리합니다. 처리될 수 있는 항목은 장치 별칭과 난수 식별자, 페어링·승인 상태, 명령 및 작업 메타데이터, 사용자가 저장하도록 요청한 기억, 오류 코드와 성능 지표, 지원 요청 시 사용자가 선택해 제공한 진단 정보입니다.

음성은 명령 인식을 위해 일시 처리될 수 있습니다. 기본 지원 번들은 원시 음성, 원문 명령, 파일 내용, API 키, 토큰, 사용자명, 호스트명 및 정확한 네트워크 주소를 포함하지 않도록 설계되었습니다. 사용자가 선택한 외부 AI 공급자를 활성화하면 해당 요청 처리에 필요한 입력이 그 공급자에게 전송될 수 있습니다.

## 3. 처리 근거와 수집 방법

계약 체결·이행, 사용자의 요청 또는 동의, 보안과 법적 의무 이행을 근거로 처리합니다. 앱 입력, 음성 입력, 로컬 장치 API, 사용자가 연결한 서비스 및 사용자가 제출한 지원 자료를 통해 수집될 수 있습니다.

## 4. 보유 기간과 파기

로컬 작업 기록과 기억은 사용자가 삭제하거나 제품 설정의 보존 기간이 끝날 때까지 장치에 저장될 수 있습니다. 일시 음성 버퍼와 임시 실행 데이터는 작업 완료 후 지체 없이 삭제하도록 설계됩니다. 법령 또는 분쟁 대응에 필요한 정보는 해당 법정 기간 동안 별도 보관한 뒤 복구하기 어렵게 파기합니다. 외부 공급자의 보유 기간은 해당 공급자의 정책과 사용자가 선택한 계정 설정에 따릅니다.

## 5. 제3자 제공, 처리위탁 및 국외 이전

예정된 외부 처리자 또는 공급자: ${context.thirdPartyProviders}. 실제 활성화한 공급자, 처리 목적, 이전 국가, 항목, 시점·방법, 보유 기간과 거부 방법은 출시 전 서비스 화면과 본 방침에 구체적으로 확정해야 합니다. 법령상 근거가 없거나 사용자의 요청·동의가 없는 판매 목적의 개인정보 제공은 하지 않습니다.

## 6. 정보주체의 권리

사용자는 자신의 개인정보에 대한 열람, 정정, 삭제, 처리정지, 동의 철회 및 자동화된 결정 관련 권리를 관계 법령에 따라 행사할 수 있습니다. 요청은 ${context.privacyEmail} 또는 ${context.privacyPhone}으로 접수하며 본인 확인 후 법정 기한 내 처리합니다. 법정대리인은 관계 법령이 허용하는 범위에서 권리를 행사할 수 있습니다.

## 7. 안전성 확보 조치

운영자는 최소 권한, 위험도별 승인, 로컬 바인딩, 토큰 비노출, 전송구간 보호, 무결성 검증, 보안 로그 최소화, 자격증명과 배포 산출물의 분리, 업데이트 검증 및 사고 대응 절차를 적용합니다. 다만 어떤 시스템도 모든 위험을 완전히 제거할 수는 없습니다.

## 8. 자동 수집 장치와 추적

로컬 제품은 광고 목적의 추적 쿠키를 기본 사용하지 않습니다. 외부 웹 서비스 또는 배포 플랫폼을 활성화하는 경우 해당 서비스의 필수 저장소와 로그가 사용될 수 있으며 출시 구성에 맞춰 세부 내용을 갱신합니다.

## 9. 아동의 개인정보

법정대리인의 동의가 필요한 연령의 사용자를 대상으로 출시하는 경우 별도의 동의 및 확인 절차를 적용합니다. 해당 절차가 준비되지 않은 배포판은 아동 대상 서비스로 제공하지 않습니다.

## 10. 변경과 구제

방침 변경 시 시행일과 변경 이유를 제품 또는 공식 배포 채널에 알립니다. 국내 개인정보 침해 상담은 개인정보침해신고센터 등 관계 기관을 이용할 수 있습니다.

- 시행일: ${context.effectiveDate}
`;
}

function renderEula(context) {
  return `${metadata(context, 'JARVIS 최종 사용자 사용권 계약(EULA)')}본 계약은 ${context.operatorName}(이하 "운영자")와 JARVIS 사용자 사이의 소프트웨어 사용 조건을 정합니다. 설치 또는 사용 전 내용을 확인하십시오.

## 1. 계약과 이용 자격

사용자가 본 계약에 동의하고 필요한 이용 자격을 갖춘 경우에만 JARVIS를 사용할 수 있습니다. 조직을 대신해 사용하는 경우 사용자는 해당 조직을 구속할 권한이 있음을 확인합니다.

## 2. 사용권

운영자는 정당한 구매·구독 조건과 JARVIS 상용 소프트웨어 라이선스에 따라 제한적, 비독점적, 양도 불가능한 사용권을 부여합니다. 소프트웨어와 지식재산권의 소유권은 이전되지 않습니다.

## 3. PC 제어와 승인

JARVIS는 사용자의 지시에 따라 파일, 앱, 브라우저, 네트워크 및 연결 장치를 제어할 수 있습니다. 삭제, 외부 전송, 결제, 계정 변경, 보안 설정 및 기타 고위험 작업은 제품이 제공하는 승인 절차를 거쳐야 합니다. 사용자는 승인 전 대상, 범위와 결과를 확인하고 적절한 백업을 유지해야 합니다.

## 4. AI 결과와 사람의 검토

AI가 생성한 계획, 명령, 요약 또는 콘텐츠는 부정확하거나 불완전할 수 있습니다. 의료, 법률, 재무, 안전, 고용 또는 권리 침해 위험이 있는 결정에는 자격 있는 사람의 독립 검토가 필요합니다. JARVIS를 불법 접근, 감시, 위해, 기만, 권리 침해 또는 보안 통제 우회에 사용해서는 안 됩니다.

## 5. 계정과 자격증명

사용자는 운영체제, AI 공급자, 앱스토어 및 연결 서비스 계정의 적법한 사용 권한을 보유하고 자격증명을 안전하게 관리해야 합니다. 키와 토큰을 소스 코드, 지원 번들 또는 공개 저장소에 포함해서는 안 됩니다.

## 6. 개인정보와 외부 서비스

개인정보 처리는 JARVIS 개인정보 처리방침에 따릅니다. 사용자가 외부 AI, 클라우드, 앱스토어 또는 제3자 앱을 연결하면 해당 서비스의 약관과 정책도 적용됩니다. 예정된 외부 공급자: ${context.thirdPartyProviders}.

## 7. 업데이트와 가용성

운영자는 보안, 법령, 호환성 또는 제품 개선을 위해 업데이트하거나 일부 기능을 변경할 수 있습니다. 네트워크, 운영체제, 장치, 외부 공급자 또는 권한 설정에 따라 일부 기능이 제한될 수 있습니다.

## 8. 보증과 책임 제한

관계 법령이 허용하는 범위에서 소프트웨어는 명시된 제품 설명과 별도 보증 조건에 따라 제공됩니다. 운영자는 모든 상황에서 무중단·무오류 또는 특정 결과를 보장하지 않습니다. 소비자에게 강행 적용되는 법정 권리와 운영자의 고의 또는 중대한 과실에 대한 책임은 본 조항으로 제한되지 않습니다. 구체적인 환불, 손해배상 한도와 기업용 서비스 수준은 판매 조건 또는 별도 계약에서 정합니다.

## 9. 계약 종료

사용자는 소프트웨어 사용을 중단하고 삭제하여 계약을 종료할 수 있습니다. 중대한 위반, 보안 위험 또는 불법 사용이 확인되면 운영자는 관계 법령과 계약에 따라 사용권을 제한하거나 종료할 수 있습니다.

## 10. 준거법과 분쟁

- 준거법: ${context.governingLaw}
- 분쟁 해결 및 관할: ${context.venue}
- 판매·서비스 지역: ${context.salesRegion}

## 11. 연락처

- 운영자: ${context.operatorName}
- 주소: ${context.businessAddress}
- 고객지원: ${context.supportEmail}
- 시행일: ${context.effectiveDate}
`;
}

function renderReport(report) {
  const missing = report.missingFields.length > 0
    ? report.missingFields.map((item) => `- ${item.variable}: ${item.label}`).join('\n')
    : '- 없음';
  return `# JARVIS 법적 배포 팩\n\n- 상태: **${report.status}**\n- 최종화 가능: **${report.readyToFinalize ? '예' : '아니오'}**\n- 루트 배포 문서 생성: **${report.finalized ? '예' : '아니오'}**\n- 검토 묶음 SHA-256: \`${report.reviewBundle.sha256}\`\n\n## 필요한 입력\n\n${missing}\n\n## 승인\n\n- 명시적 승인 확인: ${report.approval.confirmed ? '예' : '아니오'}\n- 검토 묶음 해시 제공: ${report.approval.bundleSha256Provided ? '예' : '아니오'}\n- 검토 묶음 해시 일치: ${report.approval.bundleSha256Matches ? '예' : '아니오'}\n- 승인 문구 환경변수: JARVIS_LEGAL_REVIEW_APPROVED\n- 검토 해시 환경변수: JARVIS_LEGAL_REVIEW_BUNDLE_SHA256\n\n초안과 승인 대상 문서는 dist/legal-release-pack에만 생성되며, 모든 입력과 정확한 문서 묶음에 대한 명시적 승인이 있어야 루트 LICENSE, PRIVACY.md, EULA.md를 생성합니다.\n`;
}

function clean(value) {
  return String(value ?? '').trim();
}

function marker(label) {
  return `[확정 필요: ${label}]`;
}

function uniqueByKey(items) {
  return [...new Map(items.map((item) => [item.key, item])).values()];
}

function parseArgs(argv) {
  const options = { finalize: false };
  for (const arg of argv) {
    if (arg === '--finalize') options.finalize = true;
  }
  return options;
}

async function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const pack = createLegalReleasePack();
  try {
    const report = await writeLegalReleasePack(pack, { finalize: options.finalize });
    console.log(JSON.stringify({
      status: report.status,
      finalized: report.finalized,
      readyToFinalize: report.readyToFinalize,
      missingFields: report.missingFields.map((item) => item.variable),
      reportPath: resolve('dist/legal-release-pack/legal-release-pack.md')
    }, null, 2));
  } catch (error) {
    console.error(`JARVIS legal release pack blocked: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli();
}
