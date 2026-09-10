import test from 'node:test';
import assert from 'node:assert/strict';
import { PerspectiveCamera, Vector3, Matrix4, Euler } from 'three';
import { applyWindowProjection } from '../lib/window-projection.ts';
import { TrackingSession, physicalView, MAX_TRACKING_DEPTH_M } from '../lib/window-tracking.ts';
import { depthScaleFor } from '../lib/fov-calibration.ts';
import { windowPlaneFromAnchor } from '../lib/window-anchor.ts';
import { RenderBudget, renderPixelRatio } from '../lib/render-budget.ts';

const packet = (sequence, position = { x: 0, y: 0, z: 0.6 }, track_id = 1) => ({
  sequence, tracking: true, track_id, face: { viewer_position_m: { filtered: position } },
});
const calibrated = () => {
  const session = new TrackingSession();
  for (let i = 0; i < 12; i++) session.accept(packet(i), i * 34);
  return session;
};

test('all four screen corners stay anchored, including near-plane clamping', () => {
  for (const [w, h] of [[8, 4.5], [4, 8], [20, 2]]) {
    for (const eye of [{ x: 0, y: 0, z: 7.4 }, { x: 2.2, y: -1.35, z: 5.2 }, { x: -2, y: 1, z: 0.03 }]) {
      const camera = new PerspectiveCamera();
      applyWindowProjection(camera, eye, w, h, 0.1, 50);
      for (const x of [-1, 1]) for (const y of [-1, 1]) {
        const p = new Vector3(x * w / 2, y * h / 2, 0).project(camera);
        assert.ok(Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
      }
      assert.ok(Math.abs(Math.tan(camera.fov * Math.PI / 360) - 1 / camera.projectionMatrix.elements[5]) < 1e-9);
      assert.equal(camera.aspect, w / h);
      const identity = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.projectionMatrixInverse);
      identity.elements.forEach((v, i) => assert.ok(Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-9));
    }
  }
});
test('generalized projection keeps a rotated physical screen and eye basis aligned', () => {
  const width = 8;
  const height = 4.5;
  const rotation = new Matrix4().makeRotationFromEuler(new Euler(.17, -.23, .11));
  const translation = new Vector3(1.1, -.7, .35);
  const transform = (x, y, z = 0) => new Vector3(x, y, z).applyMatrix4(rotation).add(translation);
  const screen = {
    bottomLeft: transform(-width / 2, -height / 2),
    bottomRight: transform(width / 2, -height / 2),
    topLeft: transform(-width / 2, height / 2),
  };
  const right = new Vector3().subVectors(screen.bottomRight, screen.bottomLeft).normalize();
  const up = new Vector3().subVectors(screen.topLeft, screen.bottomLeft).normalize();
  const normal = new Vector3().crossVectors(right, up);
  const center = transform(0, 0);
  const eye = center.clone().addScaledVector(normal, 7.4);
  const camera = new PerspectiveCamera();
  applyWindowProjection(camera, eye, width, height, .1, 50, screen);
  const corners = [
    screen.bottomLeft,
    screen.bottomRight,
    transform(width / 2, height / 2),
    screen.topLeft,
  ];
  const expected = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  corners.forEach((corner, index) => {
    const projected = corner.clone().project(camera);
    assert.ok(Math.abs(projected.x - expected[index][0]) < 1e-9);
    assert.ok(Math.abs(projected.y - expected[index][1]) < 1e-9);
  });
  const direction = camera.getWorldDirection(new Vector3());
  assert.ok(direction.distanceTo(normal.clone().negate()) < 1e-9);
});
test('sheared screen bases are rejected instead of producing a twisted frustum', () => {
  assert.throws(() => applyWindowProjection(new PerspectiveCamera(), { x: 0, y: 0, z: 7 }, 8, 4.5, .1, 50, {
    bottomLeft: { x: -4, y: -2.25, z: 0 },
    bottomRight: { x: 4, y: -2.25, z: 0 },
    topLeft: { x: -3.8, y: 2.25, z: 0 },
  }), /perpendicular/);
});
test('window anchors produce a physical rectangle for scene content', () => {
  const plane = windowPlaneFromAnchor({
    center: new Vector3(2, 3, -4), right: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0), width: 8, height: 4,
  });
  assert.deepEqual(plane.bottomLeft.toArray(), [-2, 1, -4]);
  assert.deepEqual(plane.bottomRight.toArray(), [6, 1, -4]);
  assert.deepEqual(plane.topLeft.toArray(), [-2, 5, -4]);
});
test('invalid frusta rejected', () => {
  assert.throws(() => applyWindowProjection(new PerspectiveCamera(), { x: NaN, y: 0, z: 1 }, 8, 4.5, 0.1, 50));
});
test('fixed viewer leaves every background grid intersection fixed across render frames', () => {
  const camera = new PerspectiveCamera();
  const eye = { x: .1, y: -.05, z: 7.4 };
  const projected = () => {
    applyWindowProjection(camera, eye, 8, 4.5, .1, 50);
    return Array.from({ length: 9 * 6 }, (_, i) =>
      new Vector3(-4 + i % 9, -2.25 + Math.floor(i / 9) * .9, -5.8 + .012)
        .project(camera).toArray());
  };
  const reference = projected();
  for (let frame = 0; frame < 120; frame++) assert.deepEqual(projected(), reference);
});
test('calibration needs multiple stable frames; one outlier cannot define center', () => {
  const s = new TrackingSession();
  assert.equal(s.accept(packet(0), 0), null);
  assert.equal(s.neutral, null);
  for (let i = 1; i <= 10; i++) s.accept(packet(i, { x: i * 0.03, y: 0, z: 0.6 }), i * 34);
  assert.equal(s.neutral, null);
  assert.deepEqual(calibrated().neutral, { x: 0, y: 0, z: 0.6 });
});
test('continuous lost packets do not postpone reset', () => {
  const s = calibrated();
  for (let t = 400; t <= 1200; t += 30) s.accept({ sequence: t, tracking: false }, t);
  assert.deepEqual(s.stale(1200, 700), { lost: true, reset: true });
});
test('silent/frozen connection expires and duplicate sequences cannot keep it alive', () => {
  const s = calibrated();
  assert.equal(s.accept(packet(11), 900), null);
  assert.equal(s.stale(1200, 700).reset, true);
});
test('invalid positions do not reach the camera', () => {
  const s = calibrated();
  [NaN, Infinity, -1, 0, 20].forEach((z, i) => assert.equal(s.accept(packet(20 + i, { x: 0, y: 0, z }), 400 + i), null));
});
test('far positions are tracked instead of being discarded as "no face"', () => {
  // The old cap was z <= 3 m and a rejected sample never refreshed
  // lastValidAt, so the render page showed "waiting for a face" while the
  // tracker was still reporting a good position (wide-angle cameras inflate z).
  const s = calibrated();
  const far = { x: 0.1, y: 0, z: 4.2 };
  assert.deepEqual(s.accept(packet(40, far), 500), far);
  assert.equal(s.stale(600, 700).lost, false);
  assert.deepEqual(s.accept(packet(41, { x: 0, y: 0, z: MAX_TRACKING_DEPTH_M }), 534), { x: 0, y: 0, z: MAX_TRACKING_DEPTH_M });
  assert.equal(s.accept(packet(42, { x: 0, y: 0, z: 0.01 }), 568), null);
});
test('depth scale compensates for a misconfigured FOV before calibration', () => {
  const scale = depthScaleFor(70, 110);
  const s = new TrackingSession();
  let last = null;
  for (let i = 0; i < 12; i++) last = s.accept(packet(i, { x: 0, y: 0, z: 1.2 }), i * 34, scale);
  // 1.2 m reported by a 70 deg tracker is ~0.59 m for a 110 deg lens.
  assert.ok(Math.abs(last.z - 1.2 * scale) < 1e-9);
  assert.ok(Math.abs(s.neutral.z - 1.2 * scale) < 1e-9, 'calibration must use corrected depth');
});
test('a depth correction that pushes a sample out of range is still rejected', () => {
  const s = calibrated();
  assert.equal(s.accept(packet(40, { x: 0, y: 0, z: 5 }), 500, 4), null);
});
test('new identity and reconnection require a new calibration', () => {
  const s = calibrated();
  assert.equal(s.accept(packet(12, { x: 0.3, y: 0, z: 0.7 }, 2), 410), null);
  assert.equal(s.neutral, null);
  s.reconnect();
  assert.equal(s.accept(packet(0), 1000), null);
  assert.equal(s.lastValidAt, 1000);
});
test('physical mapping uses one metric scale across all three axes', () => {
  const p = physicalView({ x: 0.05, y: 0.05, z: 0.55 }, { x: 0, y: 0, z: 0.5 }, 8, 0.5, 0.6, false);
  assert.ok(Math.abs(p.x - 0.96) < 1e-9);
  assert.ok(Math.abs(p.y - 0.96) < 1e-9);
  assert.ok(Math.abs(p.z - 10.56) < 1e-9);
});
test('physical mapping calibrates absolute camera geometry to neutral depth', () => {
  const neutral = { x: 0, y: 0, z: .5 };
  const p = physicalView(neutral, neutral, 8, .5, .6, true);
  assert.ok(Math.abs(p.x) < 1e-12);
  assert.ok(Math.abs(p.y) < 1e-12);
  assert.ok(Math.abs(p.z - 9.6) < 1e-12);
  const moved = physicalView({ x: .1, y: .05, z: .6 }, neutral, 8, .5, .6, true);
  assert.ok(Math.abs(moved.x + 1.92) < 1e-12);
  assert.ok(Math.abs(moved.y - .96) < 1e-12);
  assert.ok(Math.abs(moved.z - 11.52) < 1e-12);
});
test('physical mapping keeps an overshooting eye in front of the window', () => {
  const p = physicalView({ x: 0, y: 0, z: 0.01 }, { x: 0, y: 0, z: 0.6 }, 8, .5, .6, false, .05);
  assert.ok(Math.abs(p.z - .8) < 1e-12);
});
test('physical mapping applies a parallel camera offset without changing scale', () => {
  const p = physicalView({ x: 0, y: 0, z: .6 }, { x: 0, y: 0, z: .6 }, 8, .5, .6, false, .03, { x: .02, y: -.01, z: .04 });
  assert.deepEqual(p, { x: .32, y: -.16, z: 9.6 });
});
test('physical mapping centers the calibrated eye before applying motion offsets', () => {
  const neutral = { x: 0.12, y: -0.08, z: .6 };
  const centered = physicalView(neutral, neutral, 8, .5, .6, false);
  assert.ok(Math.abs(centered.x) < 1e-12);
  assert.ok(Math.abs(centered.y) < 1e-12);
  const moved = physicalView({ x: 0.17, y: -0.03, z: .6 }, neutral, 8, .5, .6, false);
  assert.ok(Math.abs(moved.x - 0.8) < 1e-12);
  assert.ok(Math.abs(moved.y - 0.8) < 1e-12);
});

test('side-on face cannot set neutral but can be tracked after calibration', () => {
  const s = new TrackingSession();
  for (let i = 0; i < 12; i++) s.accept({ ...packet(i), calibration_ready: false }, i * 34);
  assert.equal(s.neutral, null);
  const ready = calibrated();
  assert.notEqual(ready.accept({ ...packet(12), calibration_ready: false }, 450), null);
});
test('calibration still completes with an 8 Hz camera', () => {
  const s = new TrackingSession();
  for (let i = 0; i < 10; i++) s.accept(packet(i), i * 125);
  assert.deepEqual(s.neutral, { x: 0, y: 0, z: .6 });
});
test('quality metadata does not claim metric calibration', () => {
  const s = new TrackingSession();
  s.accept({ ...packet(0), tracker_backend: 'landmarker',
    face: { viewer_position_m: { filtered: { x: 0, y: 0, z: .6 } }, quality: { reprojection_error_px: 2.5 } } }, 0);
  assert.equal(s.backend, 'landmarker');
  assert.equal(s.reprojectionError, 2.5);
});
test('stationary telemetry is cleared on lost frames and reconnection', () => {
  const s = new TrackingSession();
  const valid = { ...packet(0), face: {
    viewer_position_m: { filtered: { x: 0, y: 0, z: .6 } },
    quality: { stationary: true, reprojection_error_px: 2 },
  } };
  s.accept(valid, 0);
  assert.equal(s.stationary, true);
  s.accept({ sequence: 1, tracking: false }, 65);
  assert.equal(s.stationary, false);
  assert.equal(s.reprojectionError, null);
  s.accept({ ...valid, sequence: 2 }, 130);
  assert.equal(s.stationary, true);
  s.reconnect();
  assert.equal(s.stationary, false);
});
test('render budget respects device ratio, user cap and pixel count', () => {
  const ratio = renderPixelRatio(3840, 2160, 2, 2, 2073600, 1);
  assert.equal(ratio, .5);
  assert.ok(3840 * 2160 * ratio ** 2 <= 2073600);
  assert.equal(renderPixelRatio(640, 360, 1, 2, 8300000, 1), 1);
});
test('adaptive resolution has hysteresis and bounded recovery', () => {
  const b = new RenderBudget();
  assert.equal(b.observe(30, 40), 1);
  assert.equal(b.observe(30, 40), .85);
  for (let i = 0; i < 30; i++) b.observe(30, 40);
  assert.equal(b.scale, .5);
  for (let i = 0; i < 5; i++) b.observe(15, 18);
  assert.equal(b.scale, .5);
  assert.equal(b.observe(15, 18), .55);
  for (let i = 0; i < 100; i++) b.observe(15, 18);
  assert.equal(b.scale, 1);
  assert.equal(b.observe(NaN, 0), 1);
});
