import { Vector3 } from 'three';

export type WindowAnchor = {
  center: Vector3;
  right: Vector3;
  up: Vector3;
  width: number;
  height: number;
};

/** Return the three corners required by generalized off-axis projection. */
export function windowPlaneFromAnchor(anchor: WindowAnchor) {
  const right = anchor.right.clone().normalize();
  const up = anchor.up.clone().normalize();
  const halfWidth = anchor.width / 2;
  const halfHeight = anchor.height / 2;
  return {
    bottomLeft: anchor.center.clone().addScaledVector(right, -halfWidth).addScaledVector(up, -halfHeight),
    bottomRight: anchor.center.clone().addScaledVector(right, halfWidth).addScaledVector(up, -halfHeight),
    topLeft: anchor.center.clone().addScaledVector(right, -halfWidth).addScaledVector(up, halfHeight),
  };
}
