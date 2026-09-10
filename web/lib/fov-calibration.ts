import { useSyncExternalStore } from 'react';

import type { Position } from './window-tracking';

/** The backend's built-in default (Settings.camera_hfov_deg). */
export const DEFAULT_BACKEND_FOV_DEG = 70;
export const MIN_CALIBRATION_FOV_DEG = 30;
export const MAX_CALIBRATION_FOV_DEG = 160;
const STORAGE_KEY = 'virtual-window-tracker.fov-calibration.v1';

const radians = (degrees: number) => (degrees * Math.PI) / 180;
const clampFov = (value: number) =>
  Math.min(Math.max(value, MIN_CALIBRATION_FOV_DEG), MAX_CALIBRATION_FOV_DEG);

/**
 * Depth-only correction for a camera whose real horizontal FOV differs from the
 * one the tracker was configured with.
 *
 * The tracker derives depth from the configured FOV:
 *
 *     fx = frame_width / (2 * tan(hfov / 2))
 *     z  = fx * assumed_ipd / eye_pixels
 *
 * so a FOV narrower than the lens inflates every reported depth by
 *
 *     fx_configured / fx_real = tan(hfov_real / 2) / tan(hfov_configured / 2)
 *
 * Lateral x/y need no correction at all: they reduce to
 * ``(u - cx) * assumed_ipd / eye_pixels``, which is independent of fx.  But the
 * correction still has to be applied to z *before* the neutral calibration,
 * because the projection scale that x and y get multiplied by is derived from
 * the depth reported at calibration time -- leaving it uncorrected would leave
 * the same error in the lateral amplitude.
 *
 * Returns 1 when no override is set, so the untouched path stays identical.
 */
export function depthScaleFor(backendFovDeg: number, trueFovDeg: number | null): number {
  if (trueFovDeg === null || !Number.isFinite(trueFovDeg)) return 1;
  if (!Number.isFinite(backendFovDeg) || backendFovDeg <= 0) return 1;
  const scale =
    Math.tan(radians(clampFov(backendFovDeg)) / 2) /
    Math.tan(radians(clampFov(trueFovDeg)) / 2);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** Scale only the depth axis; x and y already carry the correct metric value. */
export function applyDepthScale(position: Position, scale: number): Position {
  return scale === 1 ? position : { x: position.x, y: position.y, z: position.z * scale };
}

/* ---------------------------------------------------------------- storage */

let trueFovDeg: number | null = null;
let hydrated = false;
const listeners = new Set<(value: number | null) => void>();

function read(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? clampFov(parsed) : null;
  } catch {
    return null;
  }
}

function write(value: number | null) {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    /* storage may be disabled */
  }
}

/** null means "follow the backend FOV", i.e. no correction. */
export function getTrueFovDeg(): number | null {
  if (!hydrated) {
    hydrated = true;
    trueFovDeg = read();
  }
  return trueFovDeg;
}

export function setTrueFovDeg(value: number | null) {
  const next = value === null ? null : clampFov(value);
  if (next === trueFovDeg) return;
  hydrated = true;
  trueFovDeg = next;
  write(next);
  listeners.forEach((listener) => listener(next));
}

export function subscribeTrueFov(listener: (value: number | null) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding. Hydrates after mount so server output never disagrees. */
export function useTrueFovDeg(): [number | null, (value: number | null) => void] {
  const value = useSyncExternalStore(subscribeTrueFov, getTrueFovDeg, () => null);
  return [value, setTrueFovDeg];
}
