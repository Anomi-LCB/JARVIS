import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function ReversibilityBadge({ rollbackAvailable }: { rollbackAvailable: boolean }) {
  return (
    <View style={{ borderColor: rollbackAvailable ? colors.accent : colors.danger, borderWidth: 1, padding: 6 }}>
      <Text style={{ color: rollbackAvailable ? colors.accent : colors.danger }}>
        {rollbackAvailable ? '되돌리기 가능' : '되돌리기 불가'}
      </Text>
    </View>
  );
}
