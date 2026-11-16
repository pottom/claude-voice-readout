import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { repo } from './helpers.mjs';

const json = (f) => JSON.parse(fs.readFileSync(path.join(repo, f), 'utf8'));

test('the manifest and the marketplace agree on the plugin name', () => {
  const plugin = json('.claude-plugin/plugin.json');
  const market = json('.claude-plugin/marketplace.json');
  assert.equal(plugin.name, 'voice-readout');
  assert.equal(market.name, 'voice-readout');
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(market.plugins[0].source, './');
  assert.ok(market.owner?.name);
});

test('every hook runs a script that exists, from the plugin root', () => {
  const { hooks } = json('hooks/hooks.json');
  assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      assert.equal(h.command, 'node');
      const [arg] = h.args;
      assert.match(arg, /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\//);
      assert.ok(fs.existsSync(path.join(repo, arg.replace('${CLAUDE_PLUGIN_ROOT}/', ''))), arg);
    }
  }
});

test('the /readout command and the setup skill are there', () => {
  assert.deepEqual(fs.readdirSync(path.join(repo, 'commands')), ['readout.md']);
  const cmd = fs.readFileSync(path.join(repo, 'commands', 'readout.md'), 'utf8');
  assert.match(cmd, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/toggle\.mjs/);
  const skill = fs.readFileSync(path.join(repo, 'skills', 'setup', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: setup\n/);
});

// Generic checks, so the test itself names nobody: no voice-profile-like ids,
// no e-mail addresses, no paths into someone's home or work folders.
test('the repository carries no personal traces', () => {
  const skip = new Set(['.git', 'node_modules']);
  const files = fs.readdirSync(repo, { recursive: true }).filter((f) => !String(f).split(/[\\/]/).some((p) => skip.has(p)))
    .map((f) => path.join(repo, f)).filter((f) => fs.statSync(f).isFile() && !/\.(wav|png)$/i.test(f));
  assert.ok(files.length > 10);
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    const rel = path.relative(repo, f);
    assert.doesNotMatch(t, /\b[0-9a-f]{8}\b/, `voice-profile-like id in ${rel}`);
    assert.doesNotMatch(t, /[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i, `e-mail address in ${rel}`);
    assert.doesNotMatch(t, /[A-Za-z]:[\\/]+(?:Code|Work)\b/i, `local work path in ${rel}`);
    assert.doesNotMatch(t, /(?:[A-Za-z]:[\\/]+Users|\/Users|\/home)[\\/]+[A-Za-z][\w.-]+/, `home path with a user name in ${rel}`);
  }
});
