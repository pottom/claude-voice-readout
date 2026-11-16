// The whole path in a sealed folder: Stop hook -> queue -> speaker -> a fake
// VoiceStudio -> the configured player. The player is a small node script
// that records what it was given, so nothing is played aloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { toneWav } from '../scripts/lib.mjs';
import { repo, tempDir, isolatedEnv } from './helpers.mjs';

const script = (f) => path.join(repo, 'scripts', f);

function fakeVoiceStudio() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, body });
      if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(toneWav({ ms: 300 })); }
      else { res.writeHead(404); res.end(); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}

function runHook(env, input) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script('hook.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('exit', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify(input));
  });
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
}

function setup(vsUrl) {
  const root = tempDir('vr-e2e-');
  const iso = isolatedEnv(root);
  const marker = path.join(root, 'played.json');
  const fakePlayer = path.join(root, 'player.mjs');
  fs.writeFileSync(fakePlayer, "import fs from 'node:fs'; const [file, marker, device] = process.argv.slice(2); fs.writeFileSync(marker, JSON.stringify({ bytes: fs.statSync(file).size, device }));\n");
  fs.writeFileSync(path.join(iso.readout, 'config.json'), JSON.stringify({ url: vsUrl, outputDevice: 'Test Device', playerCommand: [process.execPath, fakePlayer, '{file}', marker, '{device}'] }));
  return { ...iso, root, marker };
}

test('a reply goes from the Stop hook to the player', async () => {
  const vs = await fakeVoiceStudio();
  try {
    const s = setup(vs.url);
    assert.equal(spawnSync(process.execPath, [script('toggle.mjs'), 'on'], { env: s.env, encoding: 'utf8' }).stdout.trim(), 'Voice readout: ON');
    const r = await runHook(s.env, { session_id: 's1', last_assistant_message: 'I checked the settings. Shall I go on?' });
    assert.equal(r.code, 0);
    const played = await waitFor(() => fs.existsSync(s.marker) && JSON.parse(fs.readFileSync(s.marker, 'utf8')));
    assert.ok(played, `player never ran; log:\n${fs.existsSync(s.env.VOICE_READOUT_LOG) ? fs.readFileSync(s.env.VOICE_READOUT_LOG, 'utf8') : '(none)'}`);
    assert.equal(played.device, 'Test Device');
    assert.ok(played.bytes > 300 * 48, 'the WAV carries the tone and the added silence');
    const req = JSON.parse(vs.requests.find((q) => q.url === '/v1/audio/speech').body);
    assert.equal(req.voice, 'default');
    assert.equal(req.language, undefined, 'no language unless configured');
    assert.match(req.input, /Shall I go on\?/);
    // The speaker leaves nothing behind in the queue, and keeps the take in recent/.
    await waitFor(() => fs.readdirSync(path.join(s.readout, 'work', 'queue')).length === 0, 5000);
    assert.deepEqual(fs.readdirSync(path.join(s.readout, 'work', 'queue')), []);
    assert.ok(fs.readdirSync(path.join(s.readout, 'work', 'recent')).some((f) => f.includes('-ok-')));
  } finally { vs.server.close(); }
});

test('off, or with the old install\'s hooks in settings.json, nothing is queued', async () => {
  const vs = await fakeVoiceStudio();
  try {
    const s = setup(vs.url);
    await runHook(s.env, { session_id: 's1', last_assistant_message: 'Go on?' });
    assert.ok(!fs.existsSync(path.join(s.readout, 'work')), 'off: no work folder');

    fs.writeFileSync(path.join(s.readout, 'on'), '');
    fs.writeFileSync(path.join(s.claude, 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/u/.claude/voice-readout/hook.mjs"' }] }] } }));
    await runHook(s.env, { session_id: 's1', last_assistant_message: 'Go on?' });
    assert.ok(!fs.existsSync(path.join(s.readout, 'work')), 'legacy: no work folder');
    const style = spawnSync(process.execPath, [script('style.mjs')], { env: s.env, encoding: 'utf8' });
    assert.equal(style.stdout, '', 'legacy: the style is not added twice');
    assert.equal(vs.requests.length, 0);
  } finally { vs.server.close(); }
});

test('the style hook adds the user\'s style only while on', () => {
  const s = setup('http://127.0.0.1:1');
  const run = () => spawnSync(process.execPath, [script('style.mjs')], { env: s.env, encoding: 'utf8' }).stdout;
  assert.equal(run(), '');
  spawnSync(process.execPath, [script('toggle.mjs'), 'on'], { env: s.env });
  assert.match(run(), /^The voice readout is on/);
  fs.writeFileSync(path.join(s.readout, 'style.txt'), 'Own style.');
  assert.equal(run(), 'Own style.');
});

test('/readout: on, off, toggle and status', () => {
  const s = setup('http://127.0.0.1:1');
  const t = (...a) => spawnSync(process.execPath, [script('toggle.mjs'), ...a], { env: s.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(t('on'), 'Voice readout: ON');
  assert.ok(fs.existsSync(path.join(s.readout, 'on')));
  assert.equal(t('off'), 'Voice readout: OFF');
  assert.ok(!fs.existsSync(path.join(s.readout, 'on')));
  assert.equal(t(), 'Voice readout: ON');
  assert.match(t('status'), /^Voice readout: ON \(usage/);
});

test('a clone voice reads a long reply part by part, first sentence first', async () => {
  const vs = await fakeVoiceStudio();
  try {
    const s = setup(vs.url);
    fs.writeFileSync(path.join(s.readout, 'voices.json'), JSON.stringify({ main: { voice: 'p1' } }));
    spawnSync(process.execPath, [script('toggle.mjs'), 'on'], { env: s.env, encoding: 'utf8' });
    const reply = `I checked the settings. ${'Everything else is in order and the tests pass. '.repeat(6)}Shall I go on?`;
    const r = await runHook(s.env, { session_id: 's2', last_assistant_message: reply });
    assert.equal(r.code, 0);
    await waitFor(() => fs.readdirSync(path.join(s.readout, 'work', 'queue')).length === 0 && fs.existsSync(s.marker));
    const inputs = vs.requests.filter((q) => q.url === '/v1/audio/speech').map((q) => JSON.parse(q.body));
    assert.ok(inputs.length >= 2, `expected several parts, got ${inputs.length}`);
    assert.equal(inputs[0].input, 'I checked the settings.');
    assert.ok(inputs.every((q) => q.voice === 'p1'));
    assert.match(inputs.at(-1).input, /Shall I go on\?$/);
  } finally { vs.server.close(); }
});

test('with engine piper a reply is made by Piper in one piece, not by VoiceStudio', { skip: process.platform === 'win32' }, async () => {
  const vs = await fakeVoiceStudio();
  try {
    const s = setup(vs.url);
    // A stand-in Piper: reads the text from stdin, writes a tone to -f, records its arguments.
    const pdir = path.join(s.readout, 'piper');
    fs.mkdirSync(path.join(pdir, 'venv', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'voices'), { recursive: true });
    for (const e of ['.onnx', '.onnx.json']) fs.writeFileSync(path.join(pdir, 'voices', `hu_HU-berta-medium${e}`), '{}');
    const calls = path.join(s.readout, 'piper-calls.json');
    const lib = path.join(repo, 'scripts', 'lib.mjs');
    const fake = path.join(pdir, 'venv', 'bin', 'piper');
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('fs'); let t = ''; process.stdin.on('data', (c) => t += c).on('end', async () => {\n  const a = process.argv.slice(2); const { toneWav } = await import(${JSON.stringify(lib)});\n  fs.writeFileSync(a[a.indexOf('-f') + 1], toneWav({ ms: 300 }));\n  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, text: t }) + '\\n'); });\n`);
    fs.chmodSync(fake, 0o755);
    fs.writeFileSync(path.join(s.readout, 'voices.json'), JSON.stringify({ engine: 'piper', speed: 1.25, main: { voice: 'hu_HU-berta-medium' } }));
    spawnSync(process.execPath, [script('toggle.mjs'), 'on'], { env: s.env, encoding: 'utf8' });
    const reply = `I checked the settings. ${'Everything else is in order and the tests pass. '.repeat(6)}Shall I go on?`;
    assert.equal((await runHook(s.env, { session_id: 's3', last_assistant_message: reply })).code, 0);
    const played = await waitFor(() => fs.existsSync(s.marker) && fs.readdirSync(path.join(s.readout, 'work', 'queue')).length === 0);
    assert.ok(played, `nothing played; log:\n${fs.existsSync(s.env.VOICE_READOUT_LOG) ? fs.readFileSync(s.env.VOICE_READOUT_LOG, 'utf8') : '(none)'}`);
    const runs = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(runs.length, 1, 'one take for the whole reply');
    assert.match(runs[0].text, /^I checked the settings\..*Shall I go on\?$/s);
    assert.equal(runs[0].args[runs[0].args.indexOf('--length-scale') + 1], '0.8');
    assert.ok(!vs.requests.some((q) => q.url === '/v1/audio/speech'), 'VoiceStudio is not asked');
  } finally { vs.server.close(); }
});
