import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { userDir, claudeHome, mergeRules, loadRules, loadVoices, loadStyle, loadSettings, resolveUrl, isLocalUrl, findVoicestudioApp, legacyInstallActive, DEFAULT_URL } from '../scripts/config.mjs';
import { tempDir } from './helpers.mjs';

const write = (dir, f, obj) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, f), typeof obj === 'string' ? obj : JSON.stringify(obj)); };

test('the user folder: VOICE_READOUT_DIR, else CLAUDE_CONFIG_DIR/voice-readout, else ~/.claude/voice-readout', () => {
  assert.equal(userDir({ VOICE_READOUT_DIR: '/x/vr' }, '/home/u'), path.resolve('/x/vr'));
  assert.equal(userDir({ CLAUDE_CONFIG_DIR: '/c' }, '/home/u'), path.join(path.resolve('/c'), 'voice-readout'));
  assert.equal(userDir({}, '/home/u'), path.join('/home/u', '.claude', 'voice-readout'));
  assert.equal(claudeHome({}, '/home/u'), path.join('/home/u', '.claude'));
});

test('mergeRules adds the user\'s words and voices to the defaults', () => {
  const d = { _budget: 600, _spoken: { CI: 'szí-áj' }, _words: { Open: 'nyitott' }, _team: { _default: { done: ['a'], info: ['b'] }, _overview: { done: ['o'] } } };
  const u = { _budget: 300, _spoken: { WSL: 'vé-es-el' }, _team: { Anna: { done: ['x'] }, _overview: { info: ['y'] } } };
  const r = mergeRules(d, u);
  assert.equal(r._budget, 300);
  assert.deepEqual(r._spoken, { CI: 'szí-áj', WSL: 'vé-es-el' });
  assert.deepEqual(r._words, { Open: 'nyitott' });
  assert.deepEqual(r._team.Anna, { done: ['x'] });
  assert.deepEqual(r._team._overview, { done: ['o'], info: ['y'] });
  assert.deepEqual(r._team._default, d._team._default);
});

test('without user files the neutral defaults load', () => {
  const dir = tempDir();
  const v = loadVoices(dir);
  assert.equal(v.address, undefined);
  assert.equal(v.language, undefined);
  assert.equal(v.main.voice, 'default');
  assert.deepEqual(v.pool, []);
  assert.equal(v.overviewTitle, '');
  const r = loadRules(dir);
  assert.deepEqual(r._team, {});
  for (const k of ['_marks', '_report', '_fullMark', '_fullForUserTurns', '_ignoreSenders', '_titlePrefix', '_backgroundNews']) assert.equal(r[k], undefined, k);
  assert.match(loadStyle(dir), /^The voice readout is on/);
  assert.deepEqual(loadSettings(dir), { url: null, outputDevice: '', playerCommand: null, voicestudioApp: null });
});

test('an old install\'s files are read as they are', () => {
  const dir = tempDir();
  write(dir, 'voices.json', { address: 'Sam', url: 'http://127.0.0.1:4000', pool: [{ voice: 'a1', name: 'Anna' }] });
  write(dir, 'speech-rules.json', '\uFEFF' + JSON.stringify({ _spoken: { Foo: 'fú' } }));
  write(dir, 'style.txt', 'own style');
  assert.equal(loadVoices(dir).address, 'Sam');
  assert.equal(loadVoices(dir).pool[0].name, 'Anna');
  assert.equal(loadRules(dir)._spoken.Foo, 'fú');
  assert.equal(loadRules(dir)._spoken.PR, 'pull request');
  assert.equal(loadRules(dir)._report, undefined, 'a rules file without v1 shape stays plain');
  assert.equal(loadStyle(dir), 'own style');
  assert.equal(loadSettings(dir).url, 'http://127.0.0.1:4000');
});

test('config.json settings win over voices.json and are checked', () => {
  const dir = tempDir();
  write(dir, 'voices.json', { url: 'http://127.0.0.1:4000' });
  write(dir, 'config.json', { url: 'http://localhost:5000/', outputDevice: ' Headphones ', playerCommand: ['ffplay', '{file}'], voicestudioApp: '/opt/vs' });
  assert.deepEqual(loadSettings(dir), { url: 'http://localhost:5000/', outputDevice: 'Headphones', playerCommand: ['ffplay', '{file}'], voicestudioApp: '/opt/vs' });
  write(dir, 'config.json', { playerCommand: 'ffplay' });
  assert.equal(loadSettings(dir).playerCommand, null);
});

test('isLocalUrl only accepts this machine', () => {
  assert.ok(isLocalUrl('http://127.0.0.1:3900'));
  assert.ok(isLocalUrl('http://localhost:3900/'));
  assert.ok(isLocalUrl('http://[::1]:3900'));
  assert.ok(!isLocalUrl('http://192.168.1.5:3900'));
  assert.ok(!isLocalUrl('http://127.0.0.1.evil.com'));
  assert.ok(!isLocalUrl('http://127.0.0.1:3900/v1'));
});

const none = () => null;
const settings = (o = {}) => ({ url: null, outputDevice: '', playerCommand: null, voicestudioApp: null, ...o });

test('resolveUrl order: env, config, installed app, default', () => {
  const appRead = (f) => (/app\.json$/.test(f) && f.includes('VoiceStudio') ? { ports: { backend: 3999 } } : null);
  assert.deepEqual(resolveUrl({ env: { VOICESTUDIO_URL: 'http://127.0.0.1:1111' }, settings: settings({ url: 'http://127.0.0.1:2222' }), read: appRead, platform: 'win32' }), { url: 'http://127.0.0.1:1111', source: 'env' });
  assert.deepEqual(resolveUrl({ env: {}, settings: settings({ url: 'http://127.0.0.1:2222/' }), read: appRead, platform: 'win32' }), { url: 'http://127.0.0.1:2222', source: 'config' });
  assert.equal(resolveUrl({ env: { ProgramFiles: 'C:\\Program Files' }, settings: settings(), read: appRead, platform: 'win32' }).url, 'http://127.0.0.1:3999');
  assert.deepEqual(resolveUrl({ env: {}, settings: settings(), read: none, platform: 'linux' }), { url: DEFAULT_URL, source: 'default' });
});

test('resolveUrl never uses a non-local address', () => {
  const r = resolveUrl({ env: { VOICESTUDIO_URL: 'http://10.0.0.2:3900' }, settings: settings({ url: 'https://example.com' }), read: none, platform: 'linux' });
  assert.equal(r.url, DEFAULT_URL);
});

test('VoiceStudio is looked for where each OS installs it', () => {
  const seen = [];
  const read = (f) => { seen.push(f.replace(/\\/g, '/')); return null; };
  findVoicestudioApp({ platform: 'darwin', env: {}, home: '/Users/u', read });
  assert.ok(seen.includes('/Applications/VoiceStudio.app/Contents/Resources/config/app.json'));
  assert.ok(seen.includes('/Users/u/Applications/VoiceStudio.app/Contents/Resources/config/app.json'));
  seen.length = 0;
  findVoicestudioApp({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, read });
  assert.ok(seen.includes('C:/Program Files/VoiceStudio/resources/config/app.json'));
  assert.ok(seen.includes('C:/Users/u/AppData/Local/Programs/VoiceStudio/resources/config/app.json'));
  seen.length = 0;
  findVoicestudioApp({ platform: 'darwin', env: {}, home: '/Users/u', extra: '/Volumes/Apps/VoiceStudio.app', read });
  assert.equal(seen[0], '/Volumes/Apps/VoiceStudio.app/Contents/Resources/config/app.json');
});

test('the installed app\'s port is used on macOS', () => {
  const read = (f) => (f === '/Applications/VoiceStudio.app/Contents/Resources/config/app.json' ? { ports: { backend: 3905 } } : null);
  assert.deepEqual(resolveUrl({ env: {}, settings: settings(), read, platform: 'darwin', home: '/Users/u' }), { url: 'http://127.0.0.1:3905', source: 'app', app: '/Applications/VoiceStudio.app' });
});

test('legacyInstallActive spots the old settings.json hooks', () => {
  const root = tempDir();
  const env = { CLAUDE_CONFIG_DIR: root };
  assert.equal(legacyInstallActive(env), false);
  write(root, 'settings.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: '"C:/Program Files/nodejs/node.exe" "C:/Users/u/.claude/voice-readout/hook.mjs"' }] }] } });
  assert.equal(legacyInstallActive(env), true);
  write(root, 'settings.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'C:\\Users\\u\\.claude\\voice-readout\\style.mjs' }] }] } });
  assert.equal(legacyInstallActive(env), true);
  write(root, 'settings.json', { hooks: {} });
  assert.equal(legacyInstallActive(env), false);
});
