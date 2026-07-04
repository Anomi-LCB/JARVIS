import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { generateCoreApiTypes } from '../packages/core/src/client/core-api-typegen.js';
import { createCoreOpenApiSpec } from '../packages/core/src/main.mjs';

const args = parseArgs(process.argv.slice(2));
const outputPath = args.output ?? 'packages/core/src/client/generated/core-api-types.d.ts';
const generatedAt = args.generatedAt ?? new Date().toISOString();
const types = generateCoreApiTypes(createCoreOpenApiSpec(new CoreFacade()), { generatedAt });

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, types, 'utf8');
console.log(`# JARVIS Core API Types
output: ${outputPath}`);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--output') parsed.output = argv[++index];
    else if (arg === '--generated-at') parsed.generatedAt = argv[++index];
  }
  return parsed;
}
