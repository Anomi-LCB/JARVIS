import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function ExternalTransferBadge({ externalTransfer }: { externalTransfer: boolean }) {
  return (
    <View style={{ borderColor: externalTransfer ? colors.danger : colors.line, borderWidth: 1, padding: 6 }}>
      <Text style={{ color: externalTransfer ? colors.danger : colors.text }}>
        {externalTransfer ? '외부 전송 포함' : '외부 전송 없음'}
      </Text>
    </View>
  );
}
