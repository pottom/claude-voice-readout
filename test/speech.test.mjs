import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { formatTopic, parseReply, classify, toSpeech, worthSaying, promptSource, forwardedFrom, overviewTitles, sessionTopic, introFor } from '../scripts/lib.mjs';
import { loadRules, loadVoices, readJson } from '../scripts/config.mjs';
import { repo, tempDir } from './helpers.mjs';

const fixture = path.join(repo, 'test', 'fixtures', 'v1');
const plainRules = loadRules(tempDir());          // no user files: the plugin defaults
const v1Rules = loadRules(fixture);                // a config from the earlier standalone installer
const v1Voices = loadVoices(fixture);
const plainCtx = (extra = {}) => ({ rules: plainRules, voice: { voice: 'default' }, firstTime: true, isOverview: false, topic: 'Website', address: '', ...extra });
const v1Ctx = (extra = {}) => ({ rules: v1Rules, voices: v1Voices, voice: v1Voices.pool[0], firstTime: false, isOverview: false, topic: 'weboldal', address: v1Voices.address, ...extra });

// ---- the plain default ------------------------------------------------------------

test('default: the closing message is read as it is, with no opening line', () => {
  const r = toSpeech('I checked the config. Shall I go on?', plainCtx());
  assert.equal(r.speech, 'I checked the config. Shall I go on?');
  assert.equal(r.kind, 'plain');
  assert.equal(r.asks, true);
});

test('default: a table is read as label and value, nothing is treated as a report', () => {
  const r = toSpeech('| Done | The tests pass. |\n|---|---|\n| Next | Review. |', plainCtx());
  assert.equal(r.report, false);
  assert.equal(r.speech, 'Done: The tests pass. Next: Review.');
});

test('default: headings with symbols and comment marks have no special meaning', () => {
  const r = toSpeech('#### ❓ Website\n<!-- read: all -->\nA plain line.', plainCtx());
  assert.equal(r.kind, 'plain');
  assert.equal(r.speech, 'Website. A plain line.');
});

test('default: a long reply is cut to the budget, the closing question stays', () => {
  const long = Array.from({ length: 60 }, (_, i) => `This is sentence number ${i + 1} of the answer.`).join(' ');
  const { speech } = toSpeech(`${long}\nWhich one should I pick?`, plainCtx());
  assert.ok(speech.length <= 1000, `too long: ${speech.length}`);
  assert.match(speech, /^This is sentence number 1 of the answer\./);
  assert.match(speech, /Which one should I pick\?$/);
});

test('default: the user\'s own turn is cut too; only ctx.full lifts the budget', () => {
  const long = Array.from({ length: 60 }, (_, i) => `This is point number ${i + 1} of the list.`).join('\n');
  assert.equal(plainRules._fullForUserTurns, undefined);
  assert.doesNotMatch(toSpeech(long, plainCtx()).speech, /number 60 of/);
  assert.match(toSpeech(long, plainCtx({ full: true })).speech, /number 60 of the list\.$/);
});

test('default: the dictionary holds only generic tech terms', () => {
  assert.deepEqual(Object.keys(plainRules._spoken).sort(), ['E2E', 'PR', 'PRs', 'e2e']);
  assert.equal(toSpeech('Two PRs and one PR, e2e green.', plainCtx()).speech, 'Two pull requests and one pull request, end-to-end green.');
});

test('the shipped defaults name no person, voice or project', () => {
  const text = ['speech-rules.json', 'voices.json'].map((f) => JSON.stringify(readJson(path.join(repo, 'defaults', f)))).join(' ');
  assert.deepEqual(Object.keys(plainRules._team), []);
  assert.doesNotMatch(text, /\b[0-9a-f]{8}\b/, 'no voice profile ids');
  assert.doesNotMatch(text, /"(address|name)"\s*:\s*"[^"]+"/, 'no names');
});

// ---- generic helpers ----------------------------------------------------------------

test('formatTopic drops the topic\'s own article and picks a/az', () => {
  assert.equal(formatTopic(['{A} {t} ügye kész.'], 'Az átvétel'), 'Az átvétel ügye kész.');
  assert.equal(formatTopic(['{h}, {a} {t} ügyében'], 'ellenőrzés', '', 'Sam'), 'Sam, az ellenőrzés ügyében');
  assert.equal(formatTopic(['{h}, are you there?'], '', '', ''), 'Are you there?');
});

test('sessionTopic strips "<WORD> <number> · " prefixes, or _titlePrefix', () => {
  assert.equal(sessionTopic('TICKET 604 · Website'), 'Website');
  assert.equal(sessionTopic('PR 12 · Backup'), 'Backup');
  assert.equal(sessionTopic('📨 Lead'), 'Lead');
  assert.equal(sessionTopic('task-12: Backup', { _titlePrefix: '^task-\\d+:\\s*' }), 'Backup');
});

test('promptSource: typed text and slash commands are the user\'s', () => {
  assert.equal(promptSource('What is the state?'), 'user');
  assert.equal(promptSource('<system-reminder>x</system-reminder>What is the state?'), 'user');
  assert.equal(promptSource('<command-message>readout</command-message>'), 'user');
  assert.equal(promptSource('<task-notification>done</task-notification>'), 'auto');
  assert.equal(promptSource(''), 'auto');
});

test('worthSaying: the user\'s own turn, a report or a question', () => {
  const c = (t) => classify(parseReply(t, plainRules), plainRules);
  assert.equal(worthSaying(c('Fine.'), 'user'), true);
  assert.equal(worthSaying(c('Fine.'), 'auto'), false);
  assert.equal(worthSaying(c('Shall I look?'), 'auto'), true);
});

test('forwardedFrom ignores the overview itself and _ignoreSenders', () => {
  const titles = overviewTitles({ overviewTitle: 'Lead', overviewAliases: ['Old lead'] });
  assert.equal(forwardedFrom('Backup', titles), 'Backup');
  assert.equal(forwardedFrom('old lead', titles), '');
  assert.equal(forwardedFrom('Helper: tests', titles, { _ignoreSenders: '^helper\\b' }), '');
});

// ---- opt-in extras, from the user's own rules ------------------------------------------

test('opt-in: _team gives named voices an introduction and openers', () => {
  const rules = { ...plainRules, _team: { _default: { first: ['Hi {h}, I am {n}, on {t}.'], question: ['{h}, a question on {t}.'] } } };
  assert.equal(introFor({ rules, voice: { name: 'Anna' }, firstTime: true, address: 'Sam' }, 'question', 'the website'), 'Hi Sam, I am Anna, on the website.');
  assert.equal(introFor({ rules, voice: { name: 'Anna' }, firstTime: false, address: 'Sam' }, 'question', 'the website'), 'Sam, a question on the website.');
});

test('opt-in: _marks, _report and label rules make report handling', () => {
  const rules = {
    ...plainRules,
    _marks: { '🛑': 'blocked' },
    _report: { ask: 'You', nothing: 'nothing', approval: 'approve', done: '\\bmerged\\b' },
    Done: { empty: 'Nothing is done yet.', prefix: '' },
    You: { empty: 'Nothing needed from you.', prefix: '' },
  };
  const k = (t) => classify(parseReply(t, rules), rules).kind;
  assert.equal(k('| Done | X. |\n| You | Will you approve the PR? |'), 'approval');
  assert.equal(k('| Done | X. |\n| You | Which one? |'), 'question');
  assert.equal(k('#### 🛑 Stuck\nIt fails.'), 'blocked');
  assert.equal(k('| Done | It merged. |\n| You | Nothing. |'), 'done');
  assert.equal(toSpeech('| Done | It merged. |\n| You | Nothing. |', { ...plainCtx(), rules }).speech, 'It merged. Nothing needed from you.');
});

test('opt-in: _fullMark reads a marked reply to the end', () => {
  const rules = { ...plainRules, _fullMark: 'read:\\s*all' };
  const long = Array.from({ length: 60 }, (_, i) => `Point ${i + 1}.`).join(' ');
  assert.match(toSpeech(`<!-- read: all -->\n${long}`, { ...plainCtx(), rules }).speech, /Point 60\.$/);
});

// ---- a config from the earlier standalone installer keeps working --------------------------

test('v1 config: report rows, kinds and the named voice\'s openers work as before', () => {
  const report = '# TICKET 12 · Backup\n| Kész | A mentés megy. |\n|---|---|\n| PR | 34 Draft: mentés |\n| Tőled | Jóváhagyod a PR-t? |';
  const first = toSpeech(report, v1Ctx({ firstTime: true }));
  assert.equal(first.kind, 'approval');
  assert.equal(first.sender, 'Backup');
  assert.match(first.speech, /^Szia Sam, Anna vagyok, én viszem a weboldal ügyét\./);
  assert.match(first.speech, /A pul rikveszt 34 piszkozat, mentés\./);
  assert.match(first.speech, /Jóváhagyod a pul rikvesztet\?$/);
  const k = (t) => classify(parseReply(t, v1Rules), v1Rules).kind;
  assert.equal(k('#### 🛑 Staging\nNem megy.'), 'blocked');
  assert.equal(k('#### ❓ Weboldal\nMelyik?'), 'question');
  assert.equal(k('| Kész | A PR beolvadt. |\n| Tőled | Semmi. |'), 'done');
  assert.match(toSpeech('| Kész | Fut a teszt. |\n| Tőled | Semmi. |', v1Ctx()).speech, /Tőled most nem kell semmi\.$/);
});

test('v1 config: the full-readout mark and full user turns are still on', () => {
  const long = Array.from({ length: 60 }, (_, i) => `Ez a ${i + 1}. mondat.`).join(' ');
  assert.equal(v1Rules._fullForUserTurns, true);
  assert.match(toSpeech(`<!-- felolvas: teljes -->\n${long}`, v1Ctx()).speech, /60\. mondat\.$/);
  assert.match(toSpeech(long, v1Ctx()).speech, /A részletek a képernyőn\./, 'a background turn is still cut');
});

test('v1 config: the overview, its aliases and ignored senders', () => {
  const titles = overviewTitles(v1Voices);
  assert.deepEqual(titles, ['Lead', 'Old lead']);
  assert.equal(forwardedFrom('Háttérügynök: teszt', titles, v1Rules), '');
  assert.equal(forwardedFrom('Backup', titles, v1Rules), 'Backup');
  const s = toSpeech('#### ❓ Backup\nMelyik?', v1Ctx({ isOverview: true, voice: v1Voices.overview, topic: '', topicOverride: 'Backup' }));
  assert.match(s.speech, /^Sam, a backup ügyében kérdés vár rád\./);
});
