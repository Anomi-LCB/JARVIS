import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PcAgentRuntime } from '../pc-agent-runtime.js';

const packetPath = process.argv[2] ?? 'apps/pc-agent/sample-packets/create-workbook.json';
const packet = JSON.parse(await readFile(packetPath, 'utf8'));
const pcAgent = new PcAgentRuntime({
  allowedRoots: [resolve('./workspace')],
  auditRoot: 'apps/pc-agent/logs'
});

const result = await pcAgent.receiveExecutionPacket(packet);
console.log(JSON.stringify({
  module: 'B_PC_AGENT_PACKET_CLI',
  packetPath,
  result
}, null, 2));
