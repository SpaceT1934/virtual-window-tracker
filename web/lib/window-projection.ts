import type { PerspectiveCamera } from 'three';
import { Matrix4, Vector3 } from 'three';
import type { Position } from './window-tracking';

export type ScreenPlane = {
  /** Lower-left, lower-right and upper-left corners in world coordinates. */
  bottomLeft: Position;
  bottomRight: Position;
  topLeft: Position;
};

const finitePosition = (point: Position) =>
  [point.x, point.y, point.z].every(Number.isFinite);

/**
 * Apply a physical off-axis projection for a fixed screen plane.
 *
 * This is the generalized perspective construction from Kooima, “Generalized
 * Perspective Projection” (2009): https://csc.lsu.edu/~kooima/pdfs/gen-perspective.pdf
 * The resulting l/r/b/t values are passed to Three's Matrix4.makePerspective,
 * whose asymmetric frustum has the same convention as OpenGL glFrustum.
 *
 * The old implementation happened to work only for an unrotated screen.  A
 * real window is a plane with a basis: the camera must use that same basis,
 * otherwise a rolled/tilted screen and the room behind it no longer share the
 * same perspective.  The default plane is the existing x/y rectangle at z=0.
 * The camera is never aimed at the model; its -Z axis points through the
 * screen plane.
 */
export function applyWindowProjection(camera: PerspectiveCamera, eye: Position,
                                      width: number, height: number, near: number, far: number,
                                      screen?: ScreenPlane) {
  if (![eye.x, eye.y, eye.z, width, height, near, far].every(Number.isFinite)
      || width <= 0 || height <= 0 || near <= 0 || far <= near) {
    throw new Error('Invalid window projection parameters');
  }

  const plane = screen ?? {
    bottomLeft: { x: -width / 2, y: -height / 2, z: 0 },
    bottomRight: { x: width / 2, y: -height / 2, z: 0 },
    topLeft: { x: -width / 2, y: height / 2, z: 0 },
  };
  if (![plane.bottomLeft, plane.bottomRight, plane.topLeft].every(finitePosition)) {
    throw new Error('Invalid screen plane parameters');
  }

  const lowerLeft = new Vector3(plane.bottomLeft.x, plane.bottomLeft.y, plane.bottomLeft.z);
  const lowerRight = new Vector3(plane.bottomRight.x, plane.bottomRight.y, plane.bottomRight.z);
  const upperLeft = new Vector3(plane.topLeft.x, plane.topLeft.y, plane.topLeft.z);
  const rightRaw = lowerRight.clone().sub(lowerLeft);
  const upRaw = upperLeft.clone().sub(lowerLeft);
  const screenWidth = rightRaw.length();
  const rawHeight = upRaw.length();
  if (screenWidth <= 1e-9 || rawHeight <= 1e-9) throw new Error('Degenerate screen plane');
  const right = rightRaw.clone().multiplyScalar(1 / screenWidth);
  // A window is rectangular, not a sheared parallelogram.  Rejecting a
  // malformed basis is safer than silently introducing a twist into the
  // camera.  The tolerance allows ordinary floating-point corner noise.
  if (Math.abs(right.dot(upRaw)) > 1e-5 * rawHeight) {
    throw new Error('Screen plane edges must be perpendicular');
  }
  const up = upRaw.clone().multiplyScalar(1 / rawHeight);
  const screenHeight = rawHeight;
  const normal = right.clone().cross(up).normalize();

  const requestedEye = new Vector3(eye.x, eye.y, eye.z);
  const planeToEye = requestedEye.clone().sub(lowerLeft);
  const requestedDistance = planeToEye.dot(normal);
  if (!Number.isFinite(requestedDistance) || requestedDistance <= 0) {
    throw new Error('Eye must be in front of the screen plane');
  }
  // Do not move the measured eye to satisfy the near plane.  That creates a
  // discontinuity exactly when the viewer gets close.  Instead shrink the
  // clipping plane for this frame; the frustum remains in the measured eye's
  // coordinate frame.  The lower bound avoids a zero near plane.
  const distance = requestedDistance;
  const nearPlane = Math.max(1e-4, Math.min(near, distance * 0.5));
  const effectiveEye = requestedEye;
  const eyeToScreen = lowerLeft.clone().sub(effectiveEye);
  const planeDistance = distance;
  const left = nearPlane * eyeToScreen.dot(right) / planeDistance;
  const rightFrustum = nearPlane * lowerRight.clone().sub(effectiveEye).dot(right) / planeDistance;
  const bottom = nearPlane * eyeToScreen.dot(up) / planeDistance;
  const top = nearPlane * upperLeft.clone().sub(effectiveEye).dot(up) / planeDistance;

  // Camera local +Z points towards the viewer, so local -Z looks through the
  // screen.  This basis also carries any physical screen roll into the view.
  const basis = new Matrix4().makeBasis(right, up, normal);
  camera.position.copy(effectiveEye);
  camera.quaternion.setFromRotationMatrix(basis);
  camera.near = nearPlane;
  camera.far = far;
  camera.zoom = 1;
  camera.aspect = screenWidth / screenHeight;
  camera.fov = 2 * Math.atan((top - bottom) / (2 * nearPlane)) * 180 / Math.PI;
  camera.projectionMatrix.makePerspective(left, rightFrustum, top, bottom, nearPlane, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld();
  // fov/aspect agree with P00/P11 for downstream culling/LOD. Do not call
  // updateProjectionMatrix afterwards: it would erase the off-axis center.
}
