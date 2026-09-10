export type HandPoint = {
  x: number;
  y: number;
  z?: number;
  pixel?: { x: number; y: number };
  world?: { x: number; y: number; z: number };
};

export type HandFeatures = {
  tracking?: boolean;
  tracking_lost?: boolean;
  handedness?: string | null;
  handedness_score?: number;
  hand_index?: number;
  landmarks?: HandPoint[];
  landmark_count?: number;
  palm_center?: HandPoint | null;
  palm_normal?: { x: number; y: number; z: number } | null;
  palm_axis?: { x: number; y: number; z: number } | null;
  palm_rotation_deg?: { pitch: number; yaw: number; roll: number } | null;
  palm_rotation?: { pitch: number; yaw: number; roll: number } | null;
  rotation?: { pitch: number; yaw: number; roll: number } | null;
  pinch?: {
    active?: boolean;
    distance?: number | null;
    ratio?: number | null;
    strength?: number;
  };
};

export type HandPacket = {
  sequence?: number;
  tracking?: boolean;
  hand?: HandFeatures | null;
  hands?: HandFeatures[];
};

export type HandPairPoint = { x: number; y: number };

export type TwoHandPinchGeometry = {
  distance: number;
  center: HandPairPoint;
  angle: number;
  /** True when the two hands have crossed their normal left/right order. */
  flipSignal: boolean;
};

export type TwoHandPinchGesture = TwoHandPinchGeometry & {
  scale: number;
  baselineDistance: number;
};

export type TwoHandScaleOptions = {
  minScale?: number;
  maxScale?: number;
};

export type GestureTarget = { x: number; y: number; rotation: number };

const finite = (value: unknown, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function isHandTracking(hand: HandFeatures | null | undefined): hand is HandFeatures {
  if (hand?.tracking !== true || hand.tracking_lost || (hand.landmarks?.length ?? 0) < 21) return false;
  if (!hand.landmarks!.slice(0, 21).every((point) => (
    point != null
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && (point.z === undefined || Number.isFinite(point.z))
  ))) return false;
  const center = hand.palm_center;
  return center !== null && center !== undefined
    && Number.isFinite(center.x) && Number.isFinite(center.y)
    && (center.z === undefined || Number.isFinite(center.z));
}

function finitePoint(point: HandPoint | null | undefined): HandPairPoint | null {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y };
}

/** Return the midpoint of a hand's thumb/index pinch, falling back to its palm. */
export function handPinchPoint(hand: HandFeatures | null | undefined): HandPairPoint | null {
  const landmarks = hand?.landmarks;
  const thumb = finitePoint(landmarks?.[4]);
  const index = finitePoint(landmarks?.[8]);
  if (thumb && index) return { x: (thumb.x + index.x) / 2, y: (thumb.y + index.y) / 2 };
  return finitePoint(hand?.palm_center);
}

function isPinchingHand(hand: HandFeatures | null | undefined): hand is HandFeatures {
  const center = finitePoint(hand?.palm_center);
  return hand?.tracking === true
    && !hand.tracking_lost
    && hand.pinch?.active === true
    && center !== null
    && handPinchPoint(hand) !== null;
}

function handednessIs(hand: HandFeatures, name: string) {
  return typeof hand.handedness === 'string' && hand.handedness.trim().toLowerCase() === name;
}

/**
 * Compute the geometry of two simultaneously pinching hands.
 *
 * The distance is measured between the thumb/index pinch midpoints, so it is
 * independent of palm size.  The function intentionally accepts a readonly
 * array and returns null for anything other than two active, valid pinches.
 */
export function twoHandPinchGeometry(
  hands: readonly (HandFeatures | null | undefined)[] | null | undefined,
): TwoHandPinchGeometry | null {
  const active = (hands ?? []).filter(isPinchingHand).slice(0, 2);
  if (active.length !== 2) return null;
  const first = handPinchPoint(active[0]);
  const second = handPinchPoint(active[1]);
  if (!first || !second) return null;
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 1e-4) return null;
  const center = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };

  // MediaPipe's handedness remains meaningful when the hands cross.  When it
  // is absent, detector order is the best available stable fallback.
  const left = active.find((hand) => handednessIs(hand, 'left'));
  const right = active.find((hand) => handednessIs(hand, 'right'));
  const orderedDx = left && right
    ? (handPinchPoint(right)!.x - handPinchPoint(left)!.x)
    : dx;
  return {
    distance,
    center,
    angle: Math.atan2(dy, dx),
    flipSignal: orderedDx < 0,
  };
}

/** Compute a clamped scale relative to a previously captured pair distance. */
export function computeTwoHandPinchScale(
  hands: readonly (HandFeatures | null | undefined)[] | null | undefined,
  baselineDistance: number,
  options: TwoHandScaleOptions = {},
): number | null {
  const geometry = twoHandPinchGeometry(hands);
  if (!geometry || !Number.isFinite(baselineDistance) || baselineDistance <= 0) return null;
  const minimum = Math.max(0.05, finite(options.minScale, 0.5));
  const maximum = Math.max(minimum, finite(options.maxScale, 2.5));
  return clamp(geometry.distance / baselineDistance, minimum, maximum);
}

// Short aliases make the geometry useful to callers that do not need the
// longer descriptive name, while keeping the public API self-documenting.
export const twoHandPinchScale = computeTwoHandPinchScale;
export const twoHandScale = computeTwoHandPinchScale;

/** Stateful two-hand gesture with a baseline captured on the first valid frame. */
export class TwoHandGestureState {
  private readonly response: number;
  private readonly scaleOptions: TwoHandScaleOptions;
  private baseline: number | null = null;
  private value: TwoHandPinchGesture | null = null;
  private lastAt = 0;

  constructor(response = 0, scaleOptions: TwoHandScaleOptions = {}) {
    this.response = response;
    this.scaleOptions = scaleOptions;
  }

  reset() {
    this.baseline = null;
    this.value = null;
    this.lastAt = 0;
  }

  update(
    hands: readonly (HandFeatures | null | undefined)[] | null | undefined,
    now = performance.now(),
  ): TwoHandPinchGesture | null {
    const geometry = twoHandPinchGeometry(hands);
    if (!geometry) {
      this.reset();
      return null;
    }
    if (this.baseline == null) this.baseline = geometry.distance;
    const rawScale = clamp(
      geometry.distance / this.baseline,
      Math.max(0.05, finite(this.scaleOptions.minScale, 0.5)),
      Math.max(
        Math.max(0.05, finite(this.scaleOptions.minScale, 0.5)),
        finite(this.scaleOptions.maxScale, 2.5),
      ),
    );
    const previous = this.value;
    let scale = rawScale;
    let center = geometry.center;
    let angle = geometry.angle;
    if (previous && this.response > 0 && Number.isFinite(this.lastAt)) {
      const dt = Math.max(0, Math.min((now - this.lastAt) / 1000, 0.2));
      const alpha = 1 - Math.exp(-Math.max(0.1, this.response) * dt);
      scale = previous.scale + (rawScale - previous.scale) * alpha;
      center = {
        x: previous.center.x + (geometry.center.x - previous.center.x) * alpha,
        y: previous.center.y + (geometry.center.y - previous.center.y) * alpha,
      };
      angle = previous.angle + angleDelta(geometry.angle, previous.angle) * alpha;
    }
    this.lastAt = now;
    this.value = { ...geometry, center, angle, scale, baselineDistance: this.baseline };
    return { ...this.value, center: { ...center } };
  }

  get baselineDistance() { return this.baseline; }
  get current() { return this.value ? { ...this.value, center: { ...this.value.center } } : null; }
}

/** Debounced boolean state used for gestures that should not flicker at a boundary. */
export class HandFlipStateMachine {
  private readonly onFrames: number;
  private readonly offFrames: number;
  private stable = false;
  private candidate: boolean | null = null;
  private count = 0;

  constructor(onFrames = 3, offFrames = 3) {
    this.onFrames = onFrames;
    this.offFrames = offFrames;
  }

  reset() {
    this.stable = false;
    this.candidate = null;
    this.count = 0;
  }

  update(signal: boolean | null | undefined): boolean {
    if (signal == null) {
      this.reset();
      return this.stable;
    }
    const required = signal ? Math.max(1, this.onFrames) : Math.max(1, this.offFrames);
    if (signal === this.stable) {
      this.candidate = null;
      this.count = 0;
      return this.stable;
    }
    if (this.candidate !== signal) {
      this.candidate = signal;
      this.count = 0;
    }
    this.count += 1;
    if (this.count >= required) {
      this.stable = signal;
      this.candidate = null;
      this.count = 0;
    }
    return this.stable;
  }

  get flipped() { return this.stable; }
  get value() { return this.stable; }
}

export const FlipStateMachine = HandFlipStateMachine;

/** Exponential smoothing with a frame-rate independent response. */
export class HandGestureFilter {
  private value: GestureTarget | null = null;
  private lastAt = 0;
  private readonly response: number;

  constructor(response = 18) {
    this.response = response;
  }

  reset() {
    this.value = null;
    this.lastAt = 0;
  }

  update(target: GestureTarget, now = performance.now()): GestureTarget {
    if (!this.value || !Number.isFinite(this.lastAt)) {
      this.value = { ...target };
      this.lastAt = now;
      return { ...this.value };
    }
    const dt = Math.max(0, Math.min((now - this.lastAt) / 1000, 0.2));
    const alpha = 1 - Math.exp(-Math.max(0.1, this.response) * dt);
    this.value = {
      x: this.value.x + (target.x - this.value.x) * alpha,
      y: this.value.y + (target.y - this.value.y) * alpha,
      rotation: this.value.rotation + angleDelta(target.rotation, this.value.rotation) * alpha,
    };
    this.lastAt = now;
    return { ...this.value };
  }

  get current() { return this.value ? { ...this.value } : null; }
}

function angleDelta(next: number, previous: number) {
  let delta = next - previous;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

/** Convert normalized palm position and roll into a Three.js-friendly target. */
export function gestureTarget(
  hand: HandFeatures,
  widthGain = 8,
  heightGain = 5,
  rotationGain = 1,
  invertX = false,
): GestureTarget | null {
  if (!isHandTracking(hand) || hand.palm_center == null || hand.pinch?.active !== true) return null;
  const center = hand.palm_center;
  const rotation = hand.palm_rotation_deg ?? hand.palm_rotation ?? hand.rotation;
  return {
    x: clamp(
      (finite(center.x, 0.5) - 0.5) * widthGain * (invertX ? -1 : 1),
      -Math.abs(widthGain) / 2,
      Math.abs(widthGain) / 2,
    ),
    y: clamp((0.5 - finite(center.y, 0.5)) * heightGain, -heightGain / 2, heightGain / 2),
    rotation: finite(rotation?.roll) * Math.PI / 180 * rotationGain,
  };
}

export function handTrackingAge(packetAt: number, now = performance.now()) {
  return packetAt > 0 ? Math.max(0, now - packetAt) : Infinity;
}
