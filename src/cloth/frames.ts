// The solver uses row-major 3x4 affine transforms and runs without Three.js.
const BASIS = [0, 1, 2, 4, 5, 6, 8, 9, 10];

type FrameParts = { rotation: Float64Array; stretch: Float64Array };

function splitFrame(m: Float64Array, { rotation, stretch }: FrameParts): void {
  // Orthonormalize the basis. The remaining upper triangular matrix preserves scale and shear.
  const sx = Math.hypot(m[0], m[4], m[8]);
  const xx = m[0] / sx, xy = m[4] / sx, xz = m[8] / sx;
  const sxy = xx * m[1] + xy * m[5] + xz * m[9];
  const yx0 = m[1] - xx * sxy, yy0 = m[5] - xy * sxy, yz0 = m[9] - xz * sxy;
  const sy = Math.hypot(yx0, yy0, yz0);
  const yx = yx0 / sy, yy = yy0 / sy, yz = yz0 / sy;
  const zx = xy * yz - xz * yy, zy = xz * yx - xx * yz, zz = xx * yy - xy * yx;
  stretch[0] = sx;
  stretch[1] = sxy;
  stretch[2] = xx * m[2] + xy * m[6] + xz * m[10];
  stretch[3] = sy;
  stretch[4] = yx * m[2] + yy * m[6] + yz * m[10];
  stretch[5] = zx * m[2] + zy * m[6] + zz * m[10];

  const trace = xx + yy + zz;
  if (trace > 0) {
    const s = 2 * Math.sqrt(1 + trace);
    rotation[0] = (yz - zy) / s; rotation[1] = (zx - xz) / s;
    rotation[2] = (xy - yx) / s; rotation[3] = s / 4;
  } else if (xx > yy && xx > zz) {
    const s = 2 * Math.sqrt(1 + xx - yy - zz);
    rotation[0] = s / 4; rotation[1] = (yx + xy) / s;
    rotation[2] = (zx + xz) / s; rotation[3] = (yz - zy) / s;
  } else if (yy > zz) {
    const s = 2 * Math.sqrt(1 + yy - xx - zz);
    rotation[0] = (yx + xy) / s; rotation[1] = s / 4;
    rotation[2] = (zy + yz) / s; rotation[3] = (zx - xz) / s;
  } else {
    const s = 2 * Math.sqrt(1 + zz - xx - yy);
    rotation[0] = (zx + xz) / s; rotation[1] = (zy + yz) / s;
    rotation[2] = s / 4; rotation[3] = (xy - yx) / s;
  }
}

/** Prepare once per pose pair, then sample at each cloth substep. */
export class FrameInterpolation {
  private start!: Float64Array;
  private end!: Float64Array;
  private readonly from: FrameParts = { rotation: new Float64Array(4), stretch: new Float64Array(6) };
  private readonly to: FrameParts = { rotation: new Float64Array(4), stretch: new Float64Array(6) };
  private sameBasis = true;
  private halfAngle = 0;
  private inverseSin = 0;

  set(a: Float64Array, b: Float64Array): void {
    this.start = a;
    this.end = b;
    this.sameBasis = BASIS.every((i) => a[i] === b[i]);
    if (this.sameBasis) return;
    splitFrame(a, this.from);
    splitFrame(b, this.to);
    const p = this.from.rotation, q = this.to.rotation;
    const dot = p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3];
    if (dot < 0) for (let i = 0; i < 4; i++) q[i] = -q[i];
    this.halfAngle = Math.acos(Math.min(1, Math.abs(dot)));
    this.inverseSin = this.halfAngle > 0.03 ? 1 / Math.sin(this.halfAngle) : 0;
  }

  at(t: number, out: Float64Array): void {
    const a = this.start, b = this.end;
    if (t === 0 || t === 1) { out.set(t === 0 ? a : b); return; }
    const u = 1 - t;
    if (this.sameBasis) {
      out.set(a);
    } else {
      const p = this.from.rotation, q = this.to.rotation;
      const wp = this.inverseSin ? Math.sin(u * this.halfAngle) * this.inverseSin : u;
      const wq = this.inverseSin ? Math.sin(t * this.halfAngle) * this.inverseSin : t;
      let x = wp * p[0] + wq * q[0], y = wp * p[1] + wq * q[1];
      let z = wp * p[2] + wq * q[2], w = wp * p[3] + wq * q[3];
      const length = Math.hypot(x, y, z, w);
      x /= length; y /= length; z /= length; w /= length;
      const xx = x + x, yy = y + y, zz = z + z;
      const r00 = 1 - y * yy - z * zz, r01 = x * yy - w * zz, r02 = x * zz + w * yy;
      const r10 = x * yy + w * zz, r11 = 1 - x * xx - z * zz, r12 = y * zz - w * xx;
      const r20 = x * zz - w * yy, r21 = y * zz + w * xx, r22 = 1 - x * xx - y * yy;
      const s = this.from.stretch, e = this.to.stretch;
      const sx = u * s[0] + t * e[0], sxy = u * s[1] + t * e[1], sxz = u * s[2] + t * e[2];
      const sy = u * s[3] + t * e[3], syz = u * s[4] + t * e[4], sz = u * s[5] + t * e[5];
      out[0] = r00 * sx; out[1] = r00 * sxy + r01 * sy; out[2] = r00 * sxz + r01 * syz + r02 * sz;
      out[4] = r10 * sx; out[5] = r10 * sxy + r11 * sy; out[6] = r10 * sxz + r11 * syz + r12 * sz;
      out[8] = r20 * sx; out[9] = r20 * sxy + r21 * sy; out[10] = r20 * sxz + r21 * syz + r22 * sz;
    }
    out[3] = u * a[3] + t * b[3];
    out[7] = u * a[7] + t * b[7];
    out[11] = u * a[11] + t * b[11];
  }
}
