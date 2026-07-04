import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';
import { createPairingInputState, createPairingQrPayload, createPairingRecoveryState, createQrScannerPermissionState } from './PairingQrPanel.js';

type Props = {
  pairingId?: string | null;
  pairingCode: string;
  bridgeUrl: string;
  expiresAt?: string;
  cameraPermission?: string;
  tokenStatus?: string | null;
};

export function PairingQrPanel({ pairingId = null, pairingCode, bridgeUrl, expiresAt, cameraPermission = 'unknown', tokenStatus = null }: Props) {
  const input = createPairingInputState({ pairingCode, bridgeUrl, expiresAt });
  const qr = createPairingQrPayload({ pairingId, pairingCode, bridgeUrl, expiresAt });
  const scanner = createQrScannerPermissionState({ cameraPermission });
  const recovery = createPairingRecoveryState({ tokenStatus, pairingStatus: input.canConfirm ? 'pairing' : 'unpaired', bridgeUrl });
  return (
    <View style={{ gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.accent }}>페어링 코드 {input.pairingCode}</Text>
      <Text style={{ color: colors.muted }}>{bridgeUrl}</Text>
      <Text style={{ color: input.canConfirm ? colors.text : colors.warning }}>
        {input.validation.message ?? 'QR 또는 수동 코드로 연결할 수 있습니다.'}
      </Text>
      <Text testID="pairing-qr-scanner-state" style={{ color: scanner.canScan ? colors.text : colors.warning }}>
        {scanner.primaryAction}
      </Text>
      <Text testID="pairing-recovery-state" style={{ color: recovery.canRestartPairing ? colors.warning : colors.muted }}>
        {recovery.recommendedAction}
      </Text>
      <Text style={{ color: colors.muted }}>{qr.qrText}</Text>
    </View>
  );
}
