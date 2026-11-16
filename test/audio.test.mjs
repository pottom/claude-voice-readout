import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { toneWav, wavSeconds, addSilence, noiseScore, speechSeconds, speechParts } from '../scripts/lib.mjs';

test('toneWav is a valid WAV of the asked length', () => {
  const w = toneWav({ ms: 500, rate: 24000 });
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.ok(Math.abs(wavSeconds(w) - 0.5) < 0.001);
});

test('addSilence lengthens the sound and keeps the header right', () => {
  const w = addSilence(toneWav({ ms: 500 }), 1000);
  assert.ok(Math.abs(wavSeconds(w) - 1.5) < 0.001);
  assert.equal(w.readUInt32LE(4), w.length - 8);
});

test('noiseScore tells a tone from hiss', () => {
  assert.ok(noiseScore(toneWav({ ms: 1000, hz: 220, volume: 0.5 })) < 0.1);
  const hiss = toneWav({ ms: 1000 });
  const rnd = crypto.randomBytes(hiss.length - 44);
  rnd.copy(hiss, 44);
  assert.ok(noiseScore(hiss) > 0.25);
});

test('unreadable audio is reported, not thrown', () => {
  assert.equal(wavSeconds(Buffer.from('nope')), -1);
  assert.equal(noiseScore(Buffer.from('nope')), -1);
});

test('speechSeconds gives the take room and folds the speed in', () => {
  const text = 'x'.repeat(160);
  assert.equal(speechSeconds(text), 13);            // 160 / 16 * 1.3
  assert.equal(speechSeconds(text, 2), 6.5);
  assert.equal(speechSeconds(text, 99), 13);        // out of range: speed 1
  assert.equal(speechSeconds('  '), undefined);     // nothing to size
});

test('speechParts starts with one sentence and groups the rest', () => {
  const t = 'Kész vagyok. A tempó 1.25 lett, a verzió v0.1.1. Minden teszt zöld! Mehetünk tovább? Szólj.';
  assert.deepEqual(speechParts(t, 60), ['Kész vagyok.', 'A tempó 1.25 lett, a verzió v0.1.1. Minden teszt zöld!', 'Mehetünk tovább? Szólj.']);
  assert.deepEqual(speechParts('Egy mondat pont nélkül'), ['Egy mondat pont nélkül']);
  assert.deepEqual(speechParts('  '), []);
  const long = 'x'.repeat(400) + '. Vége.';
  assert.deepEqual(speechParts(long, 250), ['x'.repeat(400) + '.', 'Vége.']);   // a long sentence stays whole
});
