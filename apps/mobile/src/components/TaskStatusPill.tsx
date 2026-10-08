import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

const taskStatusLabel: Record<string, string> = {
  CREATED: '생성됨',
  WAITING_APPROVAL: '승인 대기',
  APPROVED: '승인됨',
  QUEUED: '대기열',
  EXECUTING: '실행 중',
  COMPLETED: '완료',
  FAILED: '실패',
  BLOCKED: '차단됨',
  CANCELLED: '취소됨',
  EXPIRED: '만료됨',
  COMPENSATED: '복구됨'
};

export function TaskStatusPill({ status }: { status: string }) {
  const blocked = ['FAILED', 'BLOCKED', 'CANCELLED'].includes(status);
  return (
    <View style={{ backgroundColor: blocked ? colors.danger : colors.surfaceMuted, padding: 8 }}>
      <Text style={{ color: colors.text }}>{taskStatusLabel[status] ?? '상태 확인'}</Text>
    </View>
  );
}
