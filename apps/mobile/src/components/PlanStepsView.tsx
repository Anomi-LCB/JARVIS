import React from 'react';
import { Text, View } from 'react-native';
import { colors } from '../theme/colors';

export function PlanStepsView({ steps }: { steps: string[] }) {
  return (
    <View>
      {steps.map((step, index) => (
        <Text key={`${step}-${index}`} style={{ color: colors.text }}>
          {index + 1}. {step}
        </Text>
      ))}
    </View>
  );
}
