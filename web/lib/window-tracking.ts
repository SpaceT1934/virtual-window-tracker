export type Position = { x: number; y: number; z: number };
export type CameraOffset = Position;

export function isPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const p = value as Position;
  return [p.x, p.y, p.z].every(Number.isFinite) && p.z >= 0.15 && p.z <= 3;
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

  accept(packet: unknown, now: number): Position | null {
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
    const p = data.face?.viewer_position_m?.filtered;
    if (data.tracking !== true || !isPosition(p)) {
      this.stationary = false;
      this.reprojectionError = null;
      if (!this.neutral) this.samples = [];
      return null;
    }
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
      this.samples.push({ position: { ...p }, time: now });
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
    return p;
  }

  stale(now: number, resetMs: number) {
    return { lost: now - this.lastValidAt > 250, reset: now - this.lastValidAt >= resetMs };
  }
}

export function physicalView(position: Position, neutral: Position, windowWidth: number,
                             visibleWidthM: number, neutralDistanceM: number, invertX: boolean,
                             minimumEyeDistanceM = 0.03,
                             cameraOffset: CameraOffset = { x: 0, y: 0, z: 0 },
                             responseScale = 1): Position {
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
    // X/Y are view offsets relative to the calibrated neutral eye. Without
    // subtracting neutral.x/y, a non-centred camera calibration permanently
    // shifts the eye away from the window center and makes head motion look
    // like the whole scene/window is drifting.
    x: ((position.x - neutral.x) * metricScale * (invertX ? -1 : 1) + cameraOffset.x) * unitsPerM * responseScale,
    y: ((position.y - neutral.y) * metricScale + cameraOffset.y) * unitsPerM * responseScale,
    // Keep the eye in front of the window. The tracker is camera-space and
    // can briefly overshoot during occlusion; clamping here prevents one bad
    // sample from making the render loop throw while preserving real motion.
    z: Math.max(minimumEyeDistanceM, position.z * metricScale + cameraOffset.z) * unitsPerM * responseScale,
  };
}
