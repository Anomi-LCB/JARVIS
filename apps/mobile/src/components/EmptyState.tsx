import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function EmptyState({ title }: { title: string }) {
  return (
    <View style={{ padding: 24, borderColor: colors.line, borderWidth: 1 }}>
      <Text style={{ color: colors.muted }}>{title}</Text>
    </View>
  );
}
