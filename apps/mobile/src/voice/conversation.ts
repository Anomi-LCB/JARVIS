// 대화 모드 발화 의도 분류기.
// 승인/거절/종료 같은 제어 발화는 "짧고 명시적인" 경우에만 인정해서
// 일반 명령 문장("그만 두 줄로 정리해줘" 등)이 오분류되지 않게 한다.

export type UtteranceIntent = 'approve' | 'reject' | 'exit' | 'answer' | 'command';

function normalize(transcript: string): string {
  return String(transcript ?? '')
    .trim()
    .replace(/[.,!?~…'"'"「」()]/g, '')
    .replace(/\s+/g, ' ');
}

const exitPattern = /^(대화\s*모드\s*)?(종료|끝|끝내기|그만|그만할래|그만하자|나가기|나갈래)$/;
const approvePattern = /^(승인|네|예|응|어|그래|좋아|좋아요|진행|진행해|진행해\s*줘|해\s*줘|오케이|ok|okay|콜)$/i;
const rejectPattern = /^(거절|아니|아니요|아냐|아니야|취소|취소해|하지\s*마|싫어|안\s*해|중단)$/;

// 제어 발화로 인정하는 최대 길이(공백 제거 기준). 이보다 길면 내용 발화로 본다.
const controlMaxChars = 10;

export function classifyUtterance(
  transcript: string,
  context: { awaitingDecision?: boolean } = {}
): UtteranceIntent {
  const text = normalize(transcript);
  const compact = text.replace(/\s/g, '');
  if (!compact) return 'command';

  if (compact.length <= controlMaxChars && exitPattern.test(text)) return 'exit';

  if (context.awaitingDecision) {
    if (compact.length <= controlMaxChars) {
      if (approvePattern.test(text)) return 'approve';
      if (rejectPattern.test(text)) return 'reject';
    }
    // 승인 대기 중의 긴 발화는 명료화 답변/추가 정보로 취급해 재계획에 쓴다.
    return 'answer';
  }

  return 'command';
}
