// 8pt 기반 여백 스케일. iOS/인스타식으로 넉넉한 여백을 위해 2xl까지 둔다.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32
};

// 모서리 둥글기. iOS는 큰 라운드를 선호한다.
export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999
};

// iOS식 부드러운 그림자(안드로이드는 elevation로 근사).
export const shadow = {
  card: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6
  },
  floating: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.45,
    shadowRadius: 24,
    elevation: 12
  }
};
