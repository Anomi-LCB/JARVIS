export const ModuleId = Object.freeze({
  CORE: 'A_CORE_ENGINE',
  LOCAL: 'B_LOCAL_PC_CONTROL',
  MOBILE: 'C_MOBILE_TABLET_APP',
  BRIDGE: 'D_PC_MOBILE_BRIDGE',
  SECURITY: 'E_PERMISSION_SECURITY',
  MEMORY: 'F_GROWTH_MEMORY_LEARNING',
  SIMULATION: 'G_TEST_VALIDATION_SIMULATION'
});

export const PermissionLevel = Object.freeze({
  OBSERVE: 'observe',
  ASSIST: 'assist',
  CONTROL: 'control',
  ADMIN: 'admin'
});

export function createWorkflowStep(label, status = 'pending') {
  return { label, status, timestamp: new Date().toISOString() };
}

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
