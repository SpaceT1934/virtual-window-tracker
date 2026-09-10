export type Position = { x: number; y: number; z: number };
export type CameraOffset = Position;

/**
 * Plausible eye-to-camera depth in metres for a monocular face tracker.
 *
 * These bounds only exist to discard garbage (NaN, negative or absurd depth).
 * They must stay generous, because a rejected sample never updates
 * `lastValidAt`: with an over-tight cap the tracker is healthy while the UI
 * reports "no face yet".
 *
 * Depth comes from the configured horizontal FOV (`z = fx * assumed_ipd /
 * eye_pixels`), so a wide-angle camera left on a narrower FOV inflates z by
 * 2-3x and used to reach the old 3 m cap at an actual distance of ~1.5 m.
 * Bounds are also exposed as parameters so callers can tune them per camera
 * without rewriting this predicate.
 */
export const MIN_TRACKING_DEPTH_M = 0.05;
export const MAX_TRACKING_DEPTH_M = 10;

export function isPosition(
  value: unknown,
  minimumDepthM: number = MIN_TRACKING_DEPTH_M,
  maximumDepthM: number = MAX_TRACKING_DEPTH_M,
): value is Position {
  if (!value || typeof value !== 'object') return false;
  const p = value as Position;
  return (
    [p.x, p.y, p.z].every(Number.isFinite) &&
    p.z >= minimumDepthM &&
    p.z <= maximumDepthM
  );
}

/** One timer based on the LAST VALID sample, not one restarted by every lost packet. */
export class TrackingSession {
  neutral: Position | null = null;
  lastValidAt = -Infinity;
  acceptedSamples = 0;
  backend = 'detector';
  reprojectionError: number | null = null;
  stationary = false;
  private sequence = -1;
  private identity: number | undefined;
  private samples: { position: Position; time: number }[] = [];

  resetCalibration() {
    this.neutral = null;
    this.samples = [];
    this.lastValidAt = -Infinity;
  }

  reconnect() {
    this.sequence = -1;
    this.identity = undefined;
    this.stationary = false;
    this.reprojectionError = null;
    this.resetCalibration();
  }

  /**
   * Feed one tracking packet.
   *
   * ``depthScale`` rescales the reported depth before it is validated and
   * calibrated, which is how a client compensates for a camera whose real FOV
   * differs from the tracker's configured one (see lib/fov-calibration).  It
   * must be applied here rather than in the projection maths: the neutral
   * calibration records a depth, and the scale that x/y are multiplied by is
   * derived from it, so correcting it late leaves the same error in place.
   */
  accept(packet: unknown, now: number, depthScale = 1): Position | null {
    if (!packet || typeof packet !== 'object') return null;
    const data = packet as {
      sequence?: number; tracking?: boolean; track_id?: number;
      tracker_backend?: string; calibration_ready?: boolean;
      face?: { viewer_position_m?: { filtered?: unknown }; quality?: { reprojection_error_px?: number; stationary?: boolean } };
    };
    if (data.sequence !== undefined) {
      if (!Number.isSafeInteger(data.sequence) || data.sequence <= this.sequence) return null;
      this.sequence = data.sequence;
    }
    const raw = data.face?.viewer_position_m?.filtered;
    // Only depth carries the configured-FOV error: x and y reduce to
    // (u - cx) * assumed_ipd / eye_pixels, which is independent of fx.  Doing
    // the arithmetic inline keeps this module free of runtime imports so the
    // test runner can load it directly.
    const corrected =
      isPosition(raw) && depthScale !== 1
        ? { x: raw.x, y: raw.y, z: raw.z * depthScale }
        : raw;
    if (data.tracking !== true || !isPosition(corrected)) {
      this.stationary = false;
      this.reprojectionError = null;
      if (!this.neutral) this.samples = [];
      return null;
    }
    const position = corrected;
    if (data.track_id !== undefined && data.track_id !== this.identity) {
      if (!Number.isSafeInteger(data.track_id) || data.track_id < 0) return null;
      this.resetCalibration();
      this.identity = data.track_id;
    }
    if (now - this.lastValidAt > 200) this.samples = [];
    this.lastValidAt = now;
    this.acceptedSamples++;
    this.backend = data.tracker_backend === 'landmarker' ? 'landmarker' : 'detector';
    const error = data.face?.quality?.reprojection_error_px;
    this.reprojectionError = typeof error === 'number' && Number.isFinite(error) ? error : null;
    this.stationary = data.face?.quality?.stationary === true;
    if (!this.neutral) {
      if (data.calibration_ready === false) { this.samples = []; return null; }
      this.samples.push({ position: { ...position }, time: now });
      this.samples = this.samples.filter((s) => now - s.time <= 1200).slice(-15);
      if (this.samples.length < 10 || now - this.samples[0].time < 250) return null;
      const median = (key: keyof Position) => {
        const values = this.samples.map((s) => s.position[key]).sort((a, b) => a - b);
        return values[Math.floor(values.length / 2)];
      };
      const center = { x: median('x'), y: median('y'), z: median('z') };
      // Require a steady half-second-ish window; don't calibrate during a head turn.
      if (this.samples.some(({ position: s }) => Math.hypot(s.x - center.x, s.y - center.y) > 0.025 || Math.abs(s.z - center.z) > 0.04)) return null;
      this.neutral = center;
      this.samples = [];
    }
    return position;
  }

  stale(now: number, resetMs: number) {
    return { lost: now - this.lastValidAt > 250, reset: now - this.lastValidAt >= resetMs };
  }
}

export function physicalView(position: Position, neutral: Position, windowWidth: number,
                             visibleWidthM: number, neutralDistanceM: number, invertX: boolean,
                             minimumEyeDistanceM = 0.03,
                             cameraOffset: CameraOffset = { x: 0, y: 0, z: 0 }): Position {
  // Physical width refers to the visible rendered rectangle, NOT the monitor diagonal.
  const unitsPerM = windowWidth / visibleWidthM;
  // The tracker reports absolute camera-space metres. With parallel camera
  // and screen axes, translation is sufficient: eye_screen = scale *
  // eye_camera + camera_origin_screen. The known neutral eye-to-screen
  // distance corrects the remaining monocular/IPD scale error, while the
  // same scale is retained on all three axes.
  const neutralCameraDepthM = Math.max(1e-6, neutralDistanceM - cameraOffset.z);
  const metricScale = neutralCameraDepthM / Math.max(1e-6, neutral.z);
  return {
    x: (position.x * metricScale * (invertX ? -1 : 1) + cameraOffset.x) * unitsPerM,
    y: (position.y * metricScale + cameraOffset.y) * unitsPerM,
    // Keep the eye in front of the window. The tracker is camera-space and
    // can briefly overshoot during occlusion; clamping here prevents one bad
    // sample from making the render loop throw while preserving real motion.
    z: Math.max(minimumEyeDistanceM, position.z * metricScale + cameraOffset.z) * unitsPerM,
  };
}
