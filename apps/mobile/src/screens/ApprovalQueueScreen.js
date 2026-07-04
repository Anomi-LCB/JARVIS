export function createApprovalQueueScreenViewModel({ mobileRuntime }) {
  const approvals = mobileRuntime.approvalQueue();
  return {
    route: 'ApprovalQueueScreen',
    items: approvals.items ?? [],
    empty: (approvals.items ?? []).length === 0,
    select(approvalId) {
      return { nextRoute: 'ApprovalDetailScreen', approvalId };
    }
  };
}
