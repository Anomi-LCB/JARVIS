import React, { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Sharing from 'expo-sharing';
import { colors } from '../theme/colors';
import { spacing } from '../theme/spacing';

type ProbeState = {
  secureStore: 'checking' | 'available' | 'unavailable' | 'error';
  notifications: 'checking' | 'granted' | 'denied' | 'undetermined' | 'error';
  sharing: 'checking' | 'available' | 'unavailable' | 'error';
  checkedAt: string | null;
};

const probeStatusLabel: Record<string, string> = {
  checking: '확인 중',
  available: '사용 가능',
  unavailable: '사용 불가',
  error: '오류',
  granted: '허용됨',
  denied: '거부됨',
  undetermined: '미결정'
};

function platformLabel(platform: string) {
  if (platform === 'android') return '안드로이드';
  if (platform === 'ios') return 'iOS';
  return platform;
}

export function NativeRuntimeProbe() {
  const [state, setState] = useState<ProbeState>({
    secureStore: 'checking',
    notifications: 'checking',
    sharing: 'checking',
    checkedAt: null
  });

  useEffect(() => {
    let mounted = true;
    async function checkNativeRuntime() {
      try {
        const [secureAvailable, notificationPermission, sharingAvailable] = await Promise.all([
          SecureStore.isAvailableAsync(),
          Notifications.getPermissionsAsync(),
          Sharing.isAvailableAsync()
        ]);
        if (!mounted) return;
        setState({
          secureStore: secureAvailable ? 'available' : 'unavailable',
          notifications: notificationPermission.granted
            ? 'granted'
            : notificationPermission.status === 'denied'
              ? 'denied'
              : 'undetermined',
          sharing: sharingAvailable ? 'available' : 'unavailable',
          checkedAt: new Date().toISOString()
        });
      } catch {
        if (!mounted) return;
        setState({
          secureStore: 'error',
          notifications: 'error',
          sharing: 'error',
          checkedAt: new Date().toISOString()
        });
      }
    }
    checkNativeRuntime();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <View
      testID="native-runtime-probe"
      accessibilityLabel={`기기 기능 점검, 보안 저장소 ${probeStatusLabel[state.secureStore]}, 알림 ${probeStatusLabel[state.notifications]}, 공유 ${probeStatusLabel[state.sharing]}`}
      style={{ padding: spacing.sm, borderColor: colors.line, borderWidth: 1, gap: spacing.xs }}
    >
      <Text style={{ color: colors.text }}>기기 기능 점검</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Text testID="native-probe-secure-store" style={{ color: colors.muted }}>
          보안 저장소: {probeStatusLabel[state.secureStore]}
        </Text>
        <Text testID="native-probe-notifications" style={{ color: colors.muted }}>
          알림: {probeStatusLabel[state.notifications]}
        </Text>
        <Text testID="native-probe-sharing" style={{ color: colors.muted }}>
          공유: {probeStatusLabel[state.sharing]}
        </Text>
        <Text style={{ color: colors.muted }}>
          운영체제: {platformLabel(Platform.OS)}
        </Text>
      </View>
    </View>
  );
}
