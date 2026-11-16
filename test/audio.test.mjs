import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { toneWav, wavSeconds, addSilence, noiseScore } from '../scripts/lib.mjs';

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
