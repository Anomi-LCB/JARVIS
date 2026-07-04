import { cp, mkdir, rm } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const target of ['dist/index.html', 'dist/src', 'dist/apps', 'dist/packages']) {
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
await cp('index.html', 'dist/index.html');
await cp('src', 'dist/src', { recursive: true });
await cp('apps', 'dist/apps', { recursive: true });
await cp('packages', 'dist/packages', { recursive: true });
console.log('Built static JARVIS executive console into dist/.');
