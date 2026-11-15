import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
import { genkit } from 'genkit';

// Compile fixed source resources; production never loads prompt files or GitHub.
export async function compilePromptResources(root = resolve(repoRoot, 'apps/api/prompts')) {
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const manifest = await json('manifest.json');
  if (manifest.schemaVersion !== 1 || manifest.runtimeContractVersion !== 1) throw new Error('Unsupported prompt contract');
  const sourceFiles = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const path = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Prompt resources cannot be symlinks');
      if (entry.isDirectory()) await walk(path);
      else sourceFiles.push({ path: relative(root, path).replaceAll('\\', '/'), content: await readFile(path, 'utf8') });
    }
  }
  await walk(root);
  // Dotprompt clears unknown inputs by default. Validate our deliberately small
  // template language before rendering, including all shared partials.
  const partials = new Map();
  const products = new Map();
  for (const file of sourceFiles.filter((file) => file.path.endsWith('.prompt'))) {
    const partial = /^shared\/_([a-z][a-z0-9_-]*)\.prompt$/.exec(file.path);
    const product = /^products\/([a-z][a-z0-9_-]*)\.prompt$/.exec(file.path);
    if (partial) partials.set(partial[1], file.content);
    else if (product) products.set(`products/${product[1]}`, file.content);
    else throw new Error(`Unregistered prompt path: ${file.path}`);
  }
  const dependencies = new Map();
  function validatePrompt(name, body, product = false) {
    if (product) {
      const match = /^---\nname: [a-z][a-z0-9_-]*\n---\n\{\{role "system"\}\}/.exec(body);
      if (!match) throw new Error(`Invalid product declaration: ${name}`);
      body = body.slice(match[0].length);
    }
    const deps = [];
    body = body.replace(/\{\{> ([a-z][a-z0-9_-]*)\}\}/g, (_, key) => {
      if (!partials.has(key)) throw new Error(`Unknown partial: ${key}`);
      deps.push(key);
      return '';
    });
    if (body.includes('{{') || body.includes('}}')) throw new Error(`Unknown template expression: ${name}`);
    dependencies.set(name, deps);
  }
  for (const [name, body] of partials) validatePrompt(name, body);
  for (const [name, body] of products) validatePrompt(name, body, true);
  function visit(name, chain = []) {
    if (chain.includes(name)) throw new Error(`Circular partial reference: ${[...chain, name].join(' -> ')}`);
    for (const dep of dependencies.get(name) || []) visit(dep, [...chain, name]);
  }
  for (const name of dependencies.keys()) visit(name);
  const templates = await json('shared/templates.json');
  for (const [name, value] of Object.entries(templates)) {
    if (typeof value !== 'string' || !value.includes('{{data}}') || /\{\{|\}\}/.test(value.replaceAll('{{data}}', ''))) throw new Error(`Unknown or missing template variable: ${name}`);
  }
  const routing = await json('shared/routing.json');
  for (const [name, value] of Object.entries(routing)) {
    const allowed = name === 'header' ? ['tier', 'depth', 'tools'] : [];
    let rest = value;
    for (const key of allowed) {
      if (!rest.includes(`{{${key}}}`)) throw new Error(`Missing routing variable: ${key}`);
      rest = rest.replaceAll(`{{${key}}}`, '');
    }
    if (/\{\{|\}\}/.test(rest)) throw new Error(`Unknown routing variable: ${name}`);
  }
  const ai = genkit({ promptDir: root });
  const systemPrompts = {};
  for (const [id, product] of Object.entries(manifest.products)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(id) || !/^products\/[a-z][a-z0-9_-]*$/.test(product.prompt)) throw new Error('Invalid product prompt reference');
    const rendered = await ai.prompt(product.prompt).render({});
    if (rendered.messages.length !== 1 || rendered.messages[0].role !== 'system' || rendered.messages[0].content.length !== 1 || typeof rendered.messages[0].content[0].text !== 'string') throw new Error('Product must render one system text message');
    systemPrompts[id] = rendered.messages[0].content[0].text;
  }
  const skills = await json('references/catalog.json');
  for (const [key, skill] of Object.entries(skills)) {
    if (!/^[a-z_]+$/.test(key)) throw new Error('Invalid reference key');
    skill.reference = await readFile(resolve(root, `references/${key}.md`), 'utf8');
  }
  return {
    schemaVersion: 1,
    runtimeContractVersion: 1,
    revision: manifest.revision,
    sourceHash: createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    systemPrompts,
    outputInstructions: await readFile(resolve(root, 'shared/output.md'), 'utf8'),
    templates,
    skills,
    toolDescriptions: await json('tools/descriptions.json'),
    routing,
  };
}

async function runCli() {
  const resources = await compilePromptResources();
  const output = resolve(repoRoot, 'apps/api/src/prompt-resources.generated.ts');
  const text = '// Generated by scripts/prompt-build.mjs. Edit apps/api/prompts/, then regenerate.\nexport const PROMPT_TEXT = ' + JSON.stringify(resources, null, 2) + ' as const;\n';
  if (process.argv.includes('--check')) {
    if (await readFile(output, 'utf8') !== text) throw new Error('Prompt resources are stale; run node scripts/prompt-build.mjs');
  } else await writeFile(output, text);
}

if (process.argv[1] && import.meta.url && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli().catch(error => { console.error(error.message); process.exitCode = 1; });
