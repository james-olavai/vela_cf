import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
// Explicit path keeps normal tests independent of ignored build output.
const artifact = process.env.VELA_QA_ARTIFACT;
test('standalone setup, SDK stdio and live prompt edits', { skip: !artifact }, async () => {
  const directory = resolve(artifact);
  execFileSync(process.execPath, ['setup.mjs'], { cwd: directory, stdio: 'pipe' });
  const config = JSON.parse(await readFile(resolve(directory, '.vela/mcp.config.json'), 'utf8'));
  assert.ok(isAbsolute(Object.values(config.mcpServers)[0].args[0]));
  execFileSync(process.execPath, ['verify.mjs'], { cwd: directory, stdio: 'pipe' });
  const client = new Client({ name: 'vela-independent-qa', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(directory, 'launch.mjs')], cwd: directory, stderr: 'pipe' });
  let source, original;
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.ok(!response.isError, JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  };
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['inspect_product','start_evaluation','get_evaluation','cancel_evaluation','compare_evaluations'].sort());
    const menu = await call('inspect_product', {});
    const caseId = menu.cases.find(c => c.id === 'natal-a')?.id || menu.cases[0].id;
    const before = await call('inspect_product', { productId: 'go', caseId });
    source = resolve(directory, 'prompts/products/go.prompt'); original = await readFile(source, 'utf8');
    await writeFile(source, original + '\n独立协议验收标记。');
    const after = await call('inspect_product', { productId: 'go', caseId });
    assert.ok(after.preview.diagnostics.system.includes('独立协议验收标记'));
    assert.notEqual(before.hash, after.hash);
  } finally { if (source && original !== undefined) await writeFile(source, original); await client.close(); }
});
