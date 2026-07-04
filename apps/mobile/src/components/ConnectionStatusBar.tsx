import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function ConnectionStatusBar({ connected, bridgeUrl }: { connected: boolean; bridgeUrl?: string | null }) {
  return (
    <View style={{ padding: 10, backgroundColor: colors.surface }}>
      <Text style={{ color: connected ? colors.accent : colors.warning }}>
        {connected ? `연결됨 ${bridgeUrl ?? ''}` : 'PC Bridge 연결 필요'}
      </Text>
    </View>
  );
}
