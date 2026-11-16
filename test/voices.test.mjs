import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { matchVoice, leastUsed, worthSaying } from '../scripts/lib.mjs';
import { loadRules } from '../scripts/config.mjs';
import { isV1Rules } from '../scripts/compat-v1.mjs';
import { repo } from './helpers.mjs';

const pool = [{ voice: 'a', match: ['website', 'Site'] }, { voice: 'b' }, { voice: 'c', match: 'backup' }, { voice: 'd' }];

test('a session title with a voice\'s keyword gets that voice', () => {
  assert.equal(matchVoice(pool, 'TICKET 3 · New website'), 0);
  assert.equal(matchVoice(pool, 'The SITE header'), 0);
  assert.equal(matchVoice(pool, 'Nightly Backup'), 2);
  assert.equal(matchVoice(pool, 'Something else'), -1);
  assert.equal(matchVoice(pool, ''), -1);
});

test('other sessions share the voices without keywords, least used first', () => {
  assert.equal(leastUsed(pool, []), 1);
  assert.equal(leastUsed(pool, [1]), 3);
  assert.equal(leastUsed(pool, [1, 3]), 1);
  assert.equal(leastUsed([{ match: 'x' }, { match: 'y' }], [0]), 1, 'all have keywords: all are shared');
  assert.equal(leastUsed([{}, {}, {}], [0, 1]), 2);
});

test('background news: questions and reports (default), all, or none', () => {
  const chat = { report: false, asks: false };
  const ask = { report: false, asks: true };
  assert.equal(worthSaying(chat, 'auto'), false);
  assert.equal(worthSaying(ask, 'auto'), true);
  assert.equal(worthSaying(chat, 'auto', 'all'), true);
  assert.equal(worthSaying(ask, 'auto', 'none'), false);
  assert.equal(worthSaying(chat, 'user', 'none'), true, 'the user\'s own turn always');
});

test('only a rules file shaped like the earlier installer\'s gets the v1 settings', () => {
  assert.equal(isV1Rules({}), false);
  assert.equal(isV1Rules({ _spoken: { a: 'b' } }), false);
  assert.equal(isV1Rules({ _team: { Anna: {} } }), false);
  assert.equal(isV1Rules({ Done: { empty: '' } }), true);
  assert.equal(isV1Rules({ _team: { _default: {} } }), true);
  assert.equal(isV1Rules({ Done: {}, _report: {} }), false, 'a file with its own _report is taken as it is');
  assert.ok(loadRules(path.join(repo, 'test', 'fixtures', 'v1'))._report);
});
