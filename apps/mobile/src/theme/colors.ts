// iOS 다크 시스템을 기준으로 한 색 팔레트. 깊이 있는 배경 계층 + 단일 액센트(iOS 블루)로 절제한다.
// 기존 키(background/surface/surfaceMuted/text/muted/line/accent/warning/danger/info)는 다른 화면 호환을 위해 유지한다.
export const colors = {
  // 배경 계층 (뒤 → 앞)
  background: '#000000',
  surface: '#1C1C1E',      // iOS secondarySystemBackground
  surfaceMuted: '#2C2C2E', // iOS tertiarySystemBackground
  elevated: '#2C2C2E',
  card: '#1C1C1E',

  // 텍스트
  text: '#FFFFFF',
  textSecondary: '#EBEBF5',
  muted: '#8E8E93',        // iOS systemGray
  faint: '#48484A',

  // 구분선
  line: '#38383A',
  hairline: '#2C2C2E',

  // 액센트 (iOS 블루 계열)
  accent: '#0A84FF',
  accentSoft: 'rgba(10,132,255,0.16)',
  accentPressed: '#0060DF',

  // 시맨틱 (iOS 시스템 컬러)
  success: '#30D158',
  successSoft: 'rgba(48,209,88,0.16)',
  warning: '#FF9F0A',
  warningSoft: 'rgba(255,159,10,0.16)',
  danger: '#FF453A',
  dangerSoft: 'rgba(255,69,58,0.16)',
  info: '#64D2FF',

  // 온·오프 스위치, 오버레이
  overlay: 'rgba(0,0,0,0.72)',
  onAccent: '#FFFFFF'
};
