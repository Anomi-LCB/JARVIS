import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisBrandIcon } from '../apps/pc-agent/src/install/brand-icon.js';
import { desktopFeatures } from '../apps/pc-agent/src/install/desktop-features.js';
import { renderTrayAgentXaml } from '../apps/pc-agent/src/install/tray-wpf-xaml.js';
import { renderProfessionalTrayAgentSource, renderProfessionalTrayBuildScript } from '../apps/pc-agent/src/install/tray-wpf-source.js';
import { desktopTargets, applyDesktopNavigation } from '../src/ui/desktop-navigation.js';

test('ICO contains complete alpha and transparency masks at seven Windows shell resolutions', () => {
  const icon = createJarvisBrandIcon();
  assert.deepEqual(icon, createJarvisBrandIcon());
  assert.equal(icon.readUInt16LE(2), 1);
  assert.equal(icon.readUInt16LE(4), 7);
  let expectedOffset = 6 + 16 * 7;
  for (let i = 0; i < 7; i++) {
    const entry = 6 + i * 16;
    const size = icon[entry] || 256;
    const offset = icon.readUInt32LE(entry + 12);
    const length = icon.readUInt32LE(entry + 8);
    assert.equal(offset, expectedOffset);
    assert.equal(icon.readUInt32LE(offset), 40);
    assert.equal(icon.readInt32LE(offset + 8), size * 2);
    assert.equal(length, 40 + size * size * 4 + Math.ceil(size / 32) * 4 * size);
    assert.equal(icon[offset + 43], 0, 'transparent corner');
    assert.ok(icon.subarray(offset + 40, offset + 40 + size * size * 4).some((n, index) => index % 4 === 3 && n === 255));
    expectedOffset += length;
  }
  assert.equal(expectedOffset, icon.length);
});

test('every native feature has a bound action and an existing web target', () => {
  const xaml = renderTrayAgentXaml();
  const source = renderProfessionalTrayAgentSource({ endpoint:'http://127.0.0.1:17776', serviceName:'JarvisPcAgent', displayName:'JARVIS', xamlSha256:'test' });
  assert.equal(new Set(desktopFeatures.map(f => f.id)).size, desktopFeatures.length);
  for (const feature of desktopFeatures) {
    assert.ok(xaml.includes(`x:Name="FeatureOpen_${feature.id}"`));
    assert.ok(source.includes(`Need<Button>("FeatureOpen_${feature.id}").Click`));
    if (feature.path.startsWith('/#')) assert.ok(desktopTargets[feature.path.slice(2)]);
  }
  assert.ok(source.includes('SetCurrentProcessExplicitAppUserModelID("JARVIS.PcAgent.Desktop")'));
  assert.ok(renderProfessionalTrayBuildScript().includes('/win32icon:'));
});

test('desktop deep links expose nested configuration drawers without changing credentials or unrelated pages', () => {
  const drawer = { tagName:'DETAILS', open:false, parentElement:null };
  let scrolls = 0;
  const innerDrawer = { open:false };
  const target = { tagName:'SECTION', parentElement:drawer, scrollIntoView:()=>scrolls++, querySelectorAll:()=>[innerDrawer] };
  const root = { querySelector:selector => selector === '.diagnostic-readiness' ? target : null };
  drawer.parentElement = root;
  assert.equal(applyDesktopNavigation(root,'#desktop-models'), true);
  assert.equal(drawer.open, true);
  assert.equal(innerDrawer.open, true);
  assert.equal(scrolls, 1);
  assert.equal(applyDesktopNavigation(root,'#desktop-models',{scroll:false}), true);
  assert.equal(scrolls, 1);
  assert.equal(applyDesktopNavigation(root,'#unknown'), false);
});
