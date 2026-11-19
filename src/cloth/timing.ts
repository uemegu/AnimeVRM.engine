import { Quaternion, Vector3, type Matrix4 } from 'three';

// Below 15 FPS a single frame is too long for the capped number of cloth substeps.
export const MAX_CLOTH_FRAME = 1 / 15;

// Keep the 60 Hz integration interval down to 30 fps, with a bounded cost after a stall.
export function clothSubsteps(delta: number, substepMs: number): number {
  // Allow extra steps only while the measured solver cost fits in 40% of the frame.
  // Preserve the existing 16-step budget on slower devices.
  const limit = substepMs > 0 ? Math.max(16, Math.min(32, Math.floor(delta * 400 / substepMs))) : 16;
  return Math.max(4, Math.min(limit, Math.round(delta * 960)));
}

const JUMP_DISTANCE = 0.4;
const JUMP_ANGLE = 1;
const JUMP_DOT = Math.cos(JUMP_ANGLE / 2);

/** Compare the world pose of the bone or object that carries the garment. */
export class ClothPose {
  private readonly position = new Vector3();
  private readonly rotation = new Quaternion();
  private readonly nextPosition = new Vector3();
  private readonly nextRotation = new Quaternion();
  private readonly scale = new Vector3();
  private valid = false;

  invalidate(): void { this.valid = false; }

  advance(matrix: Matrix4, metresPerUnit = 1, localPoint?: Vector3): boolean {
    matrix.decompose(this.nextPosition, this.nextRotation, this.scale);
    if (localPoint) this.nextPosition.copy(localPoint).applyMatrix4(matrix);
    this.nextPosition.multiplyScalar(metresPerUnit);
    const jumped = !this.valid || this.position.distanceToSquared(this.nextPosition) > JUMP_DISTANCE ** 2
      || Math.abs(this.rotation.dot(this.nextRotation)) < JUMP_DOT;
    this.valid = true;
    this.position.copy(this.nextPosition);
    this.rotation.copy(this.nextRotation);
    return jumped;
  }
}
