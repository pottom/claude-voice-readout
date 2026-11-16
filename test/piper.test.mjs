import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isVoiceName, voiceUrls, lengthScale, piperPaths } from '../scripts/piper.mjs';

test('Piper voice names map to the rhasspy/piper-voices files', () => {
  assert.ok(isVoiceName('hu_HU-berta-medium'));
  assert.ok(!isVoiceName('../hu_HU-berta-medium'));
  assert.ok(!isVoiceName('default'));
  assert.deepEqual(voiceUrls('hu_HU-berta-medium'), {
    model: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/hu/hu_HU/berta/medium/hu_HU-berta-medium.onnx',
    config: 'https://huggingface.co/rhasspy/piper-voices/resolve/main/hu/hu_HU/berta/medium/hu_HU-berta-medium.onnx.json',
  });
  assert.equal(voiceUrls('nope'), null);
});

test('speed becomes Piper\'s length scale', () => {
  assert.equal(lengthScale(1), 1);
  assert.equal(lengthScale(1.25), 0.8);
  assert.equal(lengthScale(2), 0.5);
  assert.equal(lengthScale(undefined), 1);
  assert.equal(lengthScale(99), 1);
});

test('Piper lives in the readout folder unless piperDir says otherwise', () => {
  assert.equal(piperPaths({}, '/r').root, path.join('/r', 'piper'));
  assert.equal(piperPaths({ piperDir: '/p' }, '/r').root, path.resolve('/p'));
  assert.equal(piperPaths({}, '/r').voices, path.join('/r', 'piper', 'voices'));
});
