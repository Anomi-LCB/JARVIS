if (location.hash.startsWith('#desktop-') || new URLSearchParams(location.search).get('advanced') === '1') {
  document.querySelector('[data-workspace-style]')?.remove();
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = '/src/ui/styles.css'; document.head.append(css);
  await import('./app.js');
} else {
  await import('./workspace/app.js');
}
