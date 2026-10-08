export const desktopTargets = Object.freeze({
  'desktop-command': '.assistant-compose',
  'desktop-routines': '.assistant-routines',
  'desktop-inbox': '#desktop-inbox',
  'desktop-memory': '#desktop-memory',
  'desktop-sources': '#desktop-sources',
  'desktop-delegation': '#desktop-delegation',
  'desktop-models': '.diagnostic-readiness',
  'desktop-security': '.runtime-trust-panel',
  'desktop-connections': '.diagnostic-settings'
});

export function applyDesktopNavigation(root, hash, { scroll = true } = {}) {
  const id = String(hash ?? '').replace(/^#/, '');
  const selector = desktopTargets[id];
  if (!selector) return false;
  const target = root.querySelector(selector);
  if (!target) return false;
  for (let parent = target; parent && parent !== root; parent = parent.parentElement) {
    if (parent.tagName === 'DETAILS') parent.open = true;
  }
  for (const drawer of target.querySelectorAll?.('details') ?? []) drawer.open = true;
  // Existing forms retain the same authentication, authorization and persistence.
  if (scroll) target.scrollIntoView({ block: 'start', behavior: 'instant' });
  return true;
}
