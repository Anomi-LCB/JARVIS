import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function TaskStatusPill({ status }: { status: string }) {
  const blocked = ['FAILED', 'BLOCKED', 'CANCELLED'].includes(status);
  return (
    <View style={{ backgroundColor: blocked ? colors.danger : colors.surfaceMuted, padding: 8 }}>
      <Text style={{ color: colors.text }}>{status}</Text>
    </View>
  );
}
