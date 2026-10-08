import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const prefix = 'artifacts/voice-turn-boundary-20261008';
const observedAt = new Date().toISOString();
const baseline = await readFile(`${prefix}-baseline.txt`, 'utf8');
const final = await readFile(`${prefix}-final.txt`, 'utf8');
const build = await readFile(`${prefix}-build.txt`, 'utf8');
const contract = await readFile(`${prefix}-contract.txt`, 'utf8');
if (!baseline.includes('ℹ fail 4') || !final.includes('ℹ pass 44') || !final.includes('ℹ fail 0') ||
    !final.includes('ℹ skipped 0') || !build.includes('Built static JARVIS') || !contract.includes('gatePassed: true')) {
  throw new Error('Terminal comparison/build/contract evidence missing');
}
const sources = ['apps/mobile/src/voice/voice-command-turn.js', 'apps/mobile/src/voice/voiceMode.ts',
  'tests/voice-command-boundary.test.js'];
await writeFile(`${prefix}-source.json`, JSON.stringify({ observedAt, sources: await Promise.all(sources.map(async path => ({
  path, sha256: createHash('sha256').update(await readFile(path)).digest('hex')
}))) }, null, 2), { flag: 'wx' });
await writeFile(`${prefix}-report.md`, `# 음성 정정·취소의 제출 경계 수정

실제 관측 시각 ${observedAt}. 감시6곳 변화0/오류0 뒤 sync/status를 순서대로 확인했다. 기존 한국어 STT 후보의 합성 텍스트 S07 증거와 실제 음성 미검증 조건을 보존하고, 준비된 로컬 코드의 결함을 우선 재현했다.

## 재현과 수정

새5개 검사 중 변경 전1통과/4실패. “자료를 전부 보내줘. 아니”처럼 대체 명령이 없는 정정이 원래 요청으로 확정됐고, 실제 Core에 WAITING_APPROVAL 작업이 생성됐다. 이는 외부 발송 성공 증거가 아니라 정정된 요청이 작업으로 생성되는 실제 제출 결함이다. 문자열 'false' 등 truthy 값도 최종 발화로 처리됐고, 명시적인 발화 취소도 일반 명령으로 확정됐다.

부분 발화와 최종 발화를 엄격한 boolean으로 구별한다. 정정 표식 뒤 내용이 없으면 원래 요청으로 돌아가지 않고 listening 상태에서 대체 발화를 기다린다. “취소해”, “그만” 및 문장 끝의 명시적 취소는 해당 미제출 턴을 cancelled로 고정해 늦게 오는 final 이벤트가 다시 제출하지 못하게 한다. 정정 표식에는 단어 경계를 적용하고 끝 마침표·한국어 문장부호도 처리한다. “예약 취소해줘”, “취소된 일정만 찾아줘”, 인용된 단어, 일반 부정 표현은 그대로 유지한다. 기존 App의 accepted/committed 검사와 연결된 helper이며, native callback도 Boolean coercion 대신 event.isFinal === true를 전달한다.

## 실제 검증 범위

최종8개 파일44/44, fail0/skip0. 새6개 경계 검사에는 실제 voiceMode.ts를 TypeScript로 변환해 native hook 이벤트를 주입한 callback 실행, 실제 Core/B/G의 로컬 파일 목록 조회와 완료 상태, 미완성 정정·비boolean final의 Core 제출0이 포함된다. 네이티브 인식 모듈은 대역이며 React 화면·마이크·실기기 인식 증거가 아니다. 별도 기존 검사는 Bridge의 실제 복합 파일 생성·재읽기·G 거부, 실제 읽기 전용 PowerShell, 음성 승인·낮은 신뢰도·재시도·웨어러블 회귀를 포함한다. fixture 계획기를 사용한 검사를 외부 LLM 성능으로 표현하지 않는다. focused9/regression44/final44 반복 수는 합산하지 않는다.

build 및 Core API contract gate 통과. build는 정적 파일 생성이며 새 APK/PC EXE 배포·상주 서비스 활성화가 아니다. 실계정 발송·거래0, 개인 기억/프로필 수정0. 공식 문서 공개 읽기 외 민감정보 전송0. 실제 비용·마이크 인식 WER/p50/p95는 미측정이다.

## 출처와 한계

[Android RecognitionListener](https://developer.android.com/reference/android/speech/RecognitionListener)와 [expo-speech-recognition 원본](https://github.com/jamsch/expo-speech-recognition)을 다시 열어 확인했다. 이번 변경은 현재 설치 경로의 코드 결함 수정이며 새 버전 출시·한국어 인식 개선을 주장하지 않는다. 공식 API의 부분/최종 이벤트와 실제 음성의 정정 의도는 별개다.

이미 제출·확정된 Mission의 취소·실제 음성 끼어들기·wearable 전체 정정 경로·마침표 없는 모든 자연어 표현은 이번 수정으로 완료되지 않는다. App 로그인/장치/마이크와 실제 음성 인식 모델에서 중단·재개를 검증해야 한다. cancelled 턴은 새 인식 시작에서 재생성하는 기존 경로를 따른다. 모든 취소 의도나 안전한 의료·긴급 행동 지원을 의미하지 않는다.

## 인수와 다음 작업

V3-068은 pending에서 in_progress로 옮기고 이 부분 증거를 연결한다. 원래100 중 verified60은 유지하며 진행23/대기17이다. 실제 음성 및 외부 쓰기 취소 경합 인수는 남는다. 다음은 별도 실제 음성 입력 준비 조건 확인과, Core의 실행 전·실행 중 사용자 취소 경합을 대조하는 검사다. 복원은 native final boolean과 정정/취소 helper 변경을 함께 검토하며 잘못된 턴을 재전송하거나 기존 권한을 완화하지 않는다.
`, { flag: 'wx' });
const evidencePaths = ['-report.md', '-source.json', '-baseline.txt', '-focused.txt', '-regression.txt',
  '-final.txt', '-build.txt', '-contract.txt', '-watch.txt'].map(suffix => prefix + suffix);
const path = 'docs/universal-control-v3-acceptance.json';
const acceptance = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const gates = acceptance.stages.flatMap(stage => stage.gates);
if (gates.length !== 100 || gates.filter(gate => gate.status === 'verified').length !== 60) throw new Error('Acceptance scope changed');
const gate = gates.find(gate => gate.id === 'V3-068');
if (!gate || gate.status !== 'pending') throw new Error('Voice gate changed; inspect before recording');
gate.status = 'in_progress';
gate.evidence = [...new Set([...(gate.evidence ?? []), ...evidencePaths])];
gate.limitations = [...(gate.limitations ?? []), '2026-10-08: 未완성 정정/비boolean final/미제출 턴 취소 반례4 수정, native callback 대역·실제 Core/B/G 포함44검사. 실제 마이크/Android·실음성 끼어들기/제출된 외부 쓰기 취소 경합은 미검증.'];
await writeFile(path, JSON.stringify(acceptance, null, 2) + '\n');
await writeFile(`${prefix}-attempt.json`, JSON.stringify({ id: 'voice-turn-boundary-20261008',
  candidateId: 'korean-audio-correction-turn-readiness', kind: 'contract-test', reportedOutcome: 'passed', observedAt,
  hypothesis: '미완성 정정을 원문으로 되돌리지 않고 final boolean 및 미제출 턴 취소를 확정하면 잘못된 Core 제출을 차단하면서 유효한 대체 명령을 처리할 수 있다.',
  lesson: '인식기의 final은 의미 완성을 보증하지 않는다. 정정 내용 부재를 fall back으로 처리하면 superseded 요청이 제출된다. native callback의 boolean coercion도 제출 경계까지 검사해야 한다.',
  limitations: '합성 인식 이벤트/native 모듈 대역·실제 로컬 Core/B/G. 변경 전4실패, 최종44/44/build/contract. 실제 마이크/실기기/외부 쓰기 취소는 미검증, 비용미측정, 공식verified60 유지, 운영활성화0.',
  evidencePaths }, null, 2), { flag: 'wx' });
await appendFile('docs/execution-to-100.md', `\n최신 ${prefix}-report.md: 미완성 정정/비boolean final/미제출 턴 취소4반례 수정. native callback 실행·실제 Core/B/G 포함 최종44/44/build/contract. 공식60완료/23진행/17대기,068 부분 진행. 실제 음성·제출된 Mission/외부 쓰기 취소 경합 미검증, 운영활성화0. 다음 실제 음성 준비·실행 전후 사용자 취소 경합.\n`);
