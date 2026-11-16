import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { styleText, validate, voicesJson, rulesJson } from '../scripts/configure.mjs';
import { repo, tempDir, isolatedEnv } from './helpers.mjs';

const run = (env, ...args) => spawnSync(process.execPath, [path.join(repo, 'scripts', 'configure.mjs'), ...args], { env, encoding: 'utf8' });
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('no answers: plain config, no style file, settings.json untouched', () => {
  const root = tempDir('vr-conf-');
  const { env, readout, claude } = isolatedEnv(root);
  const a = path.join(root, 'answers.json');
  fs.writeFileSync(a, '{}');
  const r = run(env, '--config', a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const voices = read(readout, 'voices.json');
  assert.deepEqual(voices.main, { voice: 'default' });
  assert.deepEqual(voices.pool, []);
  assert.equal(voices.address, undefined);
  assert.deepEqual(read(readout, 'speech-rules.json'), {});
  assert.ok(!fs.existsSync(path.join(readout, 'style.txt')), 'the plugin default style applies');
  assert.ok(!fs.existsSync(path.join(claude, 'settings.json')));
});

test('a full interview: voices per session, names, openers, preferences', () => {
  const root = tempDir('vr-conf-');
  const { env, readout } = isolatedEnv(root);
  fs.writeFileSync(path.join(readout, 'speech-rules.json'), JSON.stringify({ _spoken: { Old: 'ould' } }));
  const answers = {
    address: 'Sam', formal: false, tone: 'friendly, to the point', language: 'en', speed: 1.1,
    outputDevice: 'Headphones', budget: 600, details: 'More on the screen.', fullForUserTurns: true, backgroundNews: 'none',
    spoken: { Kubectl: 'cube control' },
    pool: [
      { name: 'Anna', voice: 'p1', match: ['website'], lines: { first: ['Hi {h}, I am {n}, I am working on {t}.'] } },
      { name: 'Bence', voice: 'p2', speed: 0.9 },
    ],
    createdProfiles: ['p1', 'p2'],
  };
  const a = path.join(root, 'answers.json');
  fs.writeFileSync(a, JSON.stringify(answers));

  const check = run(env, '--config', a, '--check');
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.ok(!fs.existsSync(path.join(readout, 'voices.json')), '--check writes nothing');

  const r = run(env, '--config', a);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(JSON.parse(r.stdout).previousBackup, 'the earlier rules file is kept aside');
  const voices = read(readout, 'voices.json');
  assert.equal(voices.address, 'Sam');
  assert.equal(voices.language, 'en');
  assert.deepEqual(voices.pool, [{ voice: 'p1', name: 'Anna', match: ['website'] }, { voice: 'p2', name: 'Bence', speed: 0.9 }]);
  const rules = read(readout, 'speech-rules.json');
  assert.deepEqual(rules._spoken, { Old: 'ould', Kubectl: 'cube control' });
  assert.deepEqual(rules._team.Anna.first, ['Hi {h}, I am {n}, I am working on {t}.']);
  assert.equal(rules._budget, 600);
  assert.equal(rules._details, 'More on the screen.');
  assert.equal(rules._fullForUserTurns, true);
  assert.equal(rules._backgroundNews, 'none');
  assert.equal(read(readout, 'config.json').outputDevice, 'Headphones');
  assert.match(fs.readFileSync(path.join(readout, 'style.txt'), 'utf8'), /Address the user as Sam\./);

  const status = JSON.parse(run(env, '--status').stdout);
  assert.equal(status.configured, true);
  assert.deepEqual(status.createdProfiles, ['p1', 'p2']);
  assert.equal(status.legacyInstallActive, false);
});

test('answers from the earlier installer still build the same voices', () => {
  const old = { address: 'Sam', formal: false, tone: 'kollega', language: 'hu', style: 'keep', overview: { title: 'Lead', aliases: ['Old lead'], name: 'Lead', voice: 'o1', lines: { info: ['Hír.'] } }, pool: [{ name: 'Anna', voice: 'p1', speed: 1.15, lines: { done: ['Kész.'] } }] };
  const v = voicesJson(old);
  assert.equal(v.overviewTitle, 'Lead');
  assert.deepEqual(v.overviewAliases, ['Old lead']);
  assert.deepEqual(v.overview, { voice: 'o1', name: 'Lead' });
  assert.deepEqual(v.pool, [{ voice: 'p1', name: 'Anna', speed: 1.15 }]);
  const r = rulesJson({ Kész: { empty: 'x' }, _team: { _default: { done: ['y'] } } }, old);
  assert.deepEqual(r.Kész, { empty: 'x' }, 'the existing file is kept');
  assert.deepEqual(r._team._default, { done: ['y'] });
  assert.deepEqual(r._team.Anna, { done: ['Kész.'] });
});

test('configure refuses a non-local VoiceStudio address and bad answers', () => {
  assert.throws(() => validate({ url: 'http://10.0.0.1:3900' }), /local address/);
  assert.throws(() => validate({ pool: [{ name: 'x' }] }), /voice id/);
  assert.throws(() => validate({ playerCommand: 'afplay' }), /playerCommand/);
  assert.throws(() => validate({ backgroundNews: 'some' }), /backgroundNews/);
  assert.throws(() => validate({ engine: 'cloud' }), /engine/);
  validate({});
});

test('styleText: nothing to add means no style file', () => {
  assert.equal(styleText({}), null);
  assert.match(styleText({ address: 'Sam', formal: true }), /Address the user as Sam\.\nUse the formal form/);
});

test('the piper engine is written to voices.json, voicestudio stays implicit', () => {
  assert.equal(voicesJson({ engine: 'piper', main: { voice: 'hu_HU-berta-medium' } }).engine, 'piper');
  assert.equal(voicesJson({ engine: 'piper', main: { voice: 'hu_HU-berta-medium' } }).main.voice, 'hu_HU-berta-medium');
  assert.equal(voicesJson({ engine: 'voicestudio' }).engine, undefined);
});
