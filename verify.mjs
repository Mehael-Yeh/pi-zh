import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
// Verification only: pass the installed node_modules path, not used by the extension.
const modules = process.argv[2];
const url = (relative) => pathToFileURL(`${modules}/${relative}`).href;
const { createJiti } = await import(url('jiti/lib/jiti.mjs'));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': `${modules}/@earendil-works/pi-coding-agent/dist/index.js`,
}, moduleCache: false });
const extension = await jiti.import(new URL('./index.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const { CombinedAutocompleteProvider } = await import(url('@earendil-works/pi-tui/dist/autocomplete.js'));
const { BUILTIN_SLASH_COMMANDS } = await import(url('@earendil-works/pi-coding-agent/dist/core/slash-commands.js'));
const { thirdParty } = await jiti.import(new URL('./third-party.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const dictionary = { ...thirdParty, ...JSON.parse(readFileSync(new URL('./translations.json', import.meta.url))) };
const baseline = JSON.parse(readFileSync(new URL('./upgrade-baseline.json', import.meta.url)));
const packageRoot = new URL('../../npm/node_modules/', import.meta.url);
let discovered = 0;
for (const pkg of baseline.packages) {
  for (const file of Object.keys(pkg.files)) {
    const content = readFileSync(new URL(`${pkg.name}/${file}`, packageRoot), 'utf8');
    if (file.endsWith('.md') && /(^|\/)prompts\//.test(file)) {
      const name = file.split('/').at(-1).slice(0, -3);
      assert.ok(dictionary[name], `untranslated prompt: ${pkg.name}/${name}`);
      discovered++;
    }
    for (const match of content.matchAll(/\.registerCommand\(\s*["']([^"']+)["']/g)) {
      assert.ok(dictionary[match[1]], `untranslated command: ${pkg.name}/${match[1]}`);
      discovered++;
    }
  }
}
// Table-driven and variable-name registrations are reviewed separately.
for (const name of Object.keys(thirdParty)) {
  const result = extension.translateSuggestions({ prefix: '/', items: [{ value: name, label: name, description: 'Original' }] }, dictionary);
  assert.equal(result.items[0].description, `${dictionary[name]} · Original`);
}
console.log(`PASS: ${Object.keys(thirdParty).length} third-party translations; ${discovered} source command/template occurrences covered.`);
const original = new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS, { name: 'unknown-test', description: 'Unknown command' }], process.cwd());
const wrapped = extension.wrapProvider(original, dictionary);
const options = { signal: new AbortController().signal };
const before = await original.getSuggestions(['/'], 0, 1, options);
const after = await wrapped.getSuggestions(['/'], 0, 1, options);
assert.deepEqual(after.items.map(x => [x.value, x.label]), before.items.map(x => [x.value, x.label]));
for (const command of BUILTIN_SLASH_COMMANDS) {
  assert.ok(dictionary[command.name], `missing: ${command.name}`);
  assert.ok(after.items.find(x => x.value === command.name).description.startsWith(dictionary[command.name]));
}
assert.equal(after.items.find(x => x.value === 'unknown-test').description, 'Unknown command');
assert.deepEqual(extension.translateSuggestions(after, dictionary), after);
const item = after.items.find(x => x.value === 'model');
assert.deepEqual(wrapped.applyCompletion(['/'], 0, 1, item, '/'), original.applyCompletion(['/'], 0, 1, item, '/'));
const files = { prefix: './', items: [{ value: 'model', label: 'model', description: 'File' }] };
assert.equal(extension.translateSuggestions(files, dictionary), files);
assert.equal(extension.translateSuggestions(null, dictionary), null);
let handler;
extension.default({ on: (name, fn) => { assert.equal(name, 'session_start'); handler = fn; } });
let factory;
const ctx = { mode: 'tui', ui: { setEditorComponent: fn => { factory = fn; }, notify: text => { throw new Error(text); } } };
handler({}, ctx);
assert.equal(typeof factory, 'function');
const editor = factory({ requestRender() {} }, {}, {});
editor.setAutocompleteProvider(original);
assert.ok(editor);
factory = undefined;
handler({}, { mode: 'json', ui: ctx.ui });
assert.equal(factory, undefined);
console.log(`PASS: ${BUILTIN_SLASH_COMMANDS.length} built-in translations; fallback, completion preservation, file isolation, idempotence, editor construction, non-TUI guard.`);
// Commands registered by Pi's own bundled extensions (dist/extensions/*/index.js) are
// not listed in BUILTIN_SLASH_COMMANDS, so they are read from the install directory.
const bundledDir = new URL('@earendil-works/pi-coding-agent/dist/extensions/', pathToFileURL(`${modules}/`));
const bundledCommands = [];
for (const dirent of existsSync(bundledDir) ? readdirSync(bundledDir, { withFileTypes: true }) : []) {
  if (!dirent.isDirectory()) continue;
  const script = new URL(`${dirent.name}/index.js`, bundledDir);
  if (!existsSync(script)) continue;
  for (const match of readFileSync(script, 'utf8').matchAll(/\.registerCommand\(\s*["']([^"']+)["']/g)) bundledCommands.push(match[1]);
}
for (const name of bundledCommands) assert.ok(dictionary[name], `missing bundled-extension command: ${name}`);
console.log(`PASS: ${bundledCommands.length} bundled-extension commands translated (${bundledCommands.join(', ')}).`);
