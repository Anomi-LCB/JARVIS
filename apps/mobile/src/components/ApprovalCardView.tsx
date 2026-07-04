import React from 'react';
import { Text, View } from 'react-native';
import type { ApprovalCard } from '../api/apiTypes';
import { colors } from '../theme/colors';
import { RiskBadge } from './RiskBadge';
import { ExternalTransferBadge } from './ExternalTransferBadge';
import { ReversibilityBadge } from './ReversibilityBadge';
import { PlanStepsView } from './PlanStepsView';
import { AffectedItemsList } from './AffectedItemsList';
import { ApprovalActionPanel } from './ApprovalActionPanel';
import { approvalExpiryState } from '../approval/approval-expiry.js';

export function ApprovalCardView({
  card,
  safety,
  approveReadiness,
  onDecision
}: {
  card: ApprovalCard;
  safety?: unknown;
  approveReadiness?: unknown;
  onDecision?: (decision: string) => void;
}) {
  const expiry = approvalExpiryState(card);
  return (
    <View style={{ gap: 12, padding: 16, backgroundColor: colors.surface }}>
      <Text style={{ color: colors.text, fontSize: 20 }}>{card.title}</Text>
      <RiskBadge tier={card.riskTier} />
      <ExternalTransferBadge externalTransfer={card.externalTransfer} />
      <ReversibilityBadge rollbackAvailable={card.rollbackAvailable} />
      <Text testID="approval-expiry-state" style={{ color: expiry.expired ? colors.warning : colors.muted }}>
        {expiry.label}
      </Text>
      <Text style={{ color: colors.muted }}>{card.interpretedIntent}</Text>
      <PlanStepsView steps={card.planSteps} />
      <AffectedItemsList items={card.affectedItems} />
      {safety ? (
        <ApprovalActionPanel
          card={card}
          safety={safety}
          approveReadiness={approveReadiness ?? { allowed: true }}
          onDecision={onDecision}
        />
      ) : null}
    </View>
  );
}
