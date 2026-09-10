import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HandFlipStateMachine,
  TwoHandGestureState,
  computeTwoHandPinchScale,
  twoHandPinchGeometry,
} from '../lib/hand-tracking.ts';

const hand = (x, y = 0.5, handedness) => ({
  tracking: true,
  tracking_lost: false,
  handedness,
  palm_center: { x, y },
  pinch: { active: true },
});

test('two-hand pinch scale follows the ratio of pinch distances', () => {
  const baseline = [hand(0.25, 0.5, 'Left'), hand(0.75, 0.5, 'Right')];
  const opened = [hand(0.10, 0.5, 'Left'), hand(0.90, 0.5, 'Right')];
  const geometry = twoHandPinchGeometry(opened);
  assert.ok(geometry);
  assert.equal(geometry.distance, 0.8);
  assert.equal(computeTwoHandPinchScale(opened, 0.5), 1.6);
  assert.equal(computeTwoHandPinchScale(opened, 0.5, { maxScale: 1.25 }), 1.25);
  assert.equal(computeTwoHandPinchScale([baseline[0]], 0.5), null);
});

test('flip state machine requires consecutive frames and rejects jitter', () => {
  const flip = new HandFlipStateMachine(3, 2);
  assert.equal(flip.update(false), false);
  assert.equal(flip.update(true), false);
  assert.equal(flip.update(false), false);
  assert.equal(flip.update(true), false);
  assert.equal(flip.update(true), false);
  assert.equal(flip.update(true), true);
  assert.equal(flip.update(false), true);
  assert.equal(flip.update(false), false);
  assert.equal(flip.update(null), false);
});

test('losing either hand resets the scale baseline and flip state', () => {
  const gesture = new TwoHandGestureState();
  const pair = [hand(0.25, 0.5, 'Left'), hand(0.75, 0.5, 'Right')];
  const opened = [hand(0.10, 0.5, 'Left'), hand(0.90, 0.5, 'Right')];
  assert.equal(gesture.update(pair, 0)?.scale, 1);
  assert.equal(gesture.update(opened, 16)?.scale, 1.6);
  assert.equal(gesture.update([opened[0]], 32), null);
  assert.equal(gesture.baselineDistance, null);
  assert.equal(gesture.update([hand(0.40, 0.5, 'Left'), hand(0.60, 0.5, 'Right')], 48)?.scale, 1);
});
