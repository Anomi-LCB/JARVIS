import React from 'react';
import { Text, View } from 'react-native';
import type { AffectedItem } from '../api/apiTypes';
import { colors } from '../theme/colors';

export function AffectedItemsList({ items }: { items: AffectedItem[] }) {
  return (
    <View>
      {items.map((item, index) => (
        <Text key={`${item.type}-${index}`} style={{ color: colors.text }}>
          {item.type}: {item.path ?? item.label ?? 'n/a'}
        </Text>
      ))}
    </View>
  );
}
