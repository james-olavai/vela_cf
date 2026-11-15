import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compilePromptResources } from './prompt-build.mjs';

async function altered(path, modify, fn) {
  const root = await mkdtemp(join(tmpdir(), 'vela-prompt-contract-'));
  try {
    await cp(new URL('../apps/api/prompts/', import.meta.url), root, { recursive: true });
    const file = join(root, path);
    await writeFile(file, modify(await readFile(file, 'utf8')));
    await fn(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('Prompt compilation is deterministic and preserves system roles', async () => {
  const first = await compilePromptResources();
  assert.deepEqual(await compilePromptResources(), first);
  assert.ok(first.systemPrompts.go.startsWith('你是 Vela 的西洋占星咨询顾问。'));
});

for (const [name, path, change, error] of [
  ['unknown product variable', 'products/free.prompt', (s) => s + '{{unknown_secret}}', /Unknown template expression/],
  ['unknown shared variable', 'shared/_consultation.prompt', (s) => s + '{{unknown_secret}}', /Unknown template expression/],
  ['unknown helper', 'products/go.prompt', (s) => s + '{{lookup this "secret"}}', /Unknown template expression/],
  ['missing partial', 'products/go.prompt', (s) => s.replace('> consultation', '> missing'), /Unknown partial/],
  ['circular partial', 'shared/_consultation.prompt', (s) => s + '{{> consultation}}', /Circular partial/],
  ['extra message role', 'products/go.prompt', (s) => s + '{{role "user"}}hello', /Unknown template expression/],
  ['unknown data template variable', 'shared/templates.json', (s) => s.replace('{{data}}', '{{unknown_secret}}'), /Unknown or missing template/],
  ['unknown routing variable', 'shared/routing.json', (s) => s.replace('{{tier}}', '{{unknown_secret}}'), /Missing routing variable/],
]) test(`Prompt compiler rejects ${name}`, async () => {
  await altered(path, change, (root) => assert.rejects(compilePromptResources(root), error));
});
