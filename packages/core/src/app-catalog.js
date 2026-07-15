// 자비스가 네이티브(COM/포맷 직접)로 다룰 수 있는 프로그램 카탈로그.
// 능력 안내(capability.describe)와 라우팅 힌트의 단일 출처. 도구가 늘면 여기만 갱신하면
// 능력 목록에 자동 반영된다(유기적 확장). 실제 설치 여부는 PC-Agent가 런타임에 감지한다.
export const appCatalog = Object.freeze([
  {
    id: 'excel',
    labelKo: '엑셀(Excel)',
    formats: ['xlsx'],
    progId: 'Excel.Application',
    kind: 'spreadsheet',
    authoring: true,
    editing: true,
    note: '표·수식·다중 시트를 직접 만들고 편집'
  },
  {
    id: 'word',
    labelKo: '워드(Word)',
    formats: ['docx', 'pdf'],
    progId: 'Word.Application',
    kind: 'document',
    authoring: true,
    editing: false,
    note: '제목·머리글·문단·표·목록 스타일을 갖춘 완성 문서, PDF 내보내기'
  },
  {
    id: 'powerpoint',
    labelKo: '파워포인트(PowerPoint)',
    formats: ['pptx', 'pdf'],
    progId: 'PowerPoint.Application',
    kind: 'presentation',
    authoring: true,
    editing: false,
    note: '슬라이드 레이아웃·불릿·발표자 노트를 갖춘 프레젠테이션, PDF 내보내기'
  },
  {
    id: 'hwp',
    labelKo: '한글(HWP)',
    formats: ['hwp', 'hwpx'],
    progId: 'HWPFrame.HwpObject',
    kind: 'document',
    authoring: true,
    editing: true,
    note: '한컴 한글 문서 생성·표/문단 삽입, 찾아바꾸기 편집'
  },
  {
    id: 'text',
    labelKo: '텍스트/메모(txt)',
    formats: ['txt'],
    progId: null,
    kind: 'text',
    authoring: true,
    editing: false,
    note: '가벼운 메모·로그·설정 파일'
  }
]);

// 확장자/포맷 → 카탈로그 항목
export function appForFormat(format) {
  const f = String(format ?? '').toLowerCase();
  return appCatalog.find((app) => app.formats.includes(f)) ?? null;
}

// 리치 문서(제목/헤딩/문단/불릿/표) 구조를 지원하는 포맷인지
export function isRichDocFormat(format) {
  return ['docx', 'pdf', 'hwp', 'hwpx'].includes(String(format ?? '').toLowerCase());
}

export function isSlideFormat(format) {
  return ['pptx'].includes(String(format ?? '').toLowerCase());
}
