import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CALIBRATION_FOV_DEG,
  MIN_CALIBRATION_FOV_DEG,
  applyDepthScale,
  depthScaleFor,
} from '../lib/fov-calibration.ts';

/** tan of an angle given in degrees. */
const tangent = (degrees) => Math.tan((degrees * Math.PI) / 180);

test('depth scale inverts the configured-FOV error', () => {
  // z is proportional to fx, so a narrower-than-real setting inflates depth.
  assert.ok(Math.abs(depthScaleFor(70, 110) - tangent(35) / tangent(55)) < 1e-12);
  assert.ok(Math.abs(depthScaleFor(70, 110) - 0.4903) < 5e-4);
  assert.ok(Math.abs(depthScaleFor(70, 120) - 0.4043) < 5e-4);
  // A wide camera left at the default needs depth pulled back by ~2x.
  assert.ok(Math.abs(depthScaleFor(70, 70) - 1) < 1e-12);
  assert.ok(depthScaleFor(70, 110) < 1);
  assert.ok(depthScaleFor(110, 70) > 1);
});

test('no override means no correction', () => {
  assert.equal(depthScaleFor(70, null), 1);
  assert.equal(depthScaleFor(70, NaN), 1);
  assert.equal(depthScaleFor(0, 110), 1);
  assert.equal(depthScaleFor(NaN, 110), 1);
});

test('depth scale stays finite across the whole slider range', () => {
  for (let fov = MIN_CALIBRATION_FOV_DEG; fov <= MAX_CALIBRATION_FOV_DEG; fov += 0.5) {
    for (const backend of [MIN_CALIBRATION_FOV_DEG, 70, 120, MAX_CALIBRATION_FOV_DEG]) {
      const scale = depthScaleFor(backend, fov);
      assert.ok(Number.isFinite(scale) && scale > 0, `backend ${backend} fov ${fov}`);
    }
  }
});

test('only the depth axis is rescaled', () => {
  const source = { x: 0.12, y: -0.03, z: 1.2 };
  const scaled = applyDepthScale(source, 0.5);
  assert.deepEqual(scaled, { x: 0.12, y: -0.03, z: 0.6 });
  assert.equal(source.z, 1.2, 'input must not be mutated');
  assert.equal(applyDepthScale(source, 1), source, 'a unit scale must not copy');
});
