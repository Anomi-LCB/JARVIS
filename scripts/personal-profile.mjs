import { readFileSync } from 'node:fs';
import { PersonalProfileStore, projectPersonalContext } from '../packages/core/src/personal-operations/personal-profile.js';

try {
  const [command = 'status', ...args] = process.argv.slice(2);
  const store = new PersonalProfileStore({ path: process.env.JARVIS_PERSONAL_PROFILE_PATH });
  if (command === 'status' && !args.length) console.log(JSON.stringify(store.status(), null, 2));
  else if (command === 'import' && args.length === 2 && args[0] === '--input') {
    const input = JSON.parse(readFileSync(args[1], 'utf8').replace(/^\uFEFF/, ''));
    const existing = store.load();
    console.log(JSON.stringify(store.save(input, { expectedRevision: existing?.revision ?? null }), null, 2));
  } else if (command === 'context' && args.length === 2 && args[0] === '--input') {
    const request = JSON.parse(readFileSync(args[1], 'utf8').replace(/^\uFEFF/, ''));
    const context = projectPersonalContext(store.load(), request);
    console.log(JSON.stringify({ available: Boolean(context), revision: context?.profileRevision ?? null,
      sectionIds: context?.sectionIds ?? [], goalIds: context?.goals.map(goal => goal.id) ?? [],
      projectIds: context?.projects.map(project => project.id) ?? [], identityIncluded: false }, null, 2));
  } else throw new Error('Usage: npm run personal:profile -- [status | import --input private-profile.json | context --input request.json]');
} catch (error) { console.error(error.code ?? error.message); process.exitCode = 1; }
