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
      accessibilityLabel={`native runtime probe ${state.secureStore} ${state.notifications} ${state.sharing}`}
      style={{ padding: spacing.sm, borderColor: colors.line, borderWidth: 1, gap: spacing.xs }}
    >
      <Text style={{ color: colors.text }}>Native runtime probe</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        <Text testID="native-probe-secure-store" style={{ color: colors.muted }}>
          SecureStore native: {state.secureStore}
        </Text>
        <Text testID="native-probe-notifications" style={{ color: colors.muted }}>
          Notifications native: {state.notifications}
        </Text>
        <Text testID="native-probe-sharing" style={{ color: colors.muted }}>
          Sharing native: {state.sharing}
        </Text>
        <Text style={{ color: colors.muted }}>
          Platform: {Platform.OS}
        </Text>
      </View>
    </View>
  );
}
