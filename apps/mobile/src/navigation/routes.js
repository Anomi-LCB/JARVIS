export const MobileRoutes = Object.freeze({
  PairingScreen: 'PairingScreen',
  CommandScreen: 'CommandScreen',
  ApprovalQueueScreen: 'ApprovalQueueScreen',
  ApprovalDetailScreen: 'ApprovalDetailScreen',
  TaskStatusScreen: 'TaskStatusScreen',
  ResultScreen: 'ResultScreen',
  SettingsScreen: 'SettingsScreen',
  GrowthReviewScreen: 'GrowthReviewScreen',
  PoisonQueueScreen: 'PoisonQueueScreen'
});

export function canNavigate(route) {
  return Object.values(MobileRoutes).includes(route);
}
