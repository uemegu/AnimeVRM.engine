import type { DistanceGrid } from './sdf';
import { fabricOf, type FabricSpec } from './fabric';
import { FrameInterpolation } from './frames';

/**
 * 布のソルバー（XPBD、CPU）。スカートを点と拘束の集まりとして解く。モデルや描画のことは知らない。
 * 外から渡すのは、体の動き（frames）と、摘む・風だけ。VRM へのつなぎ込みは VrmSkirt.ts。
 */
// The skirt as cloth: XPBD with small substeps on the CPU.
//   points       the skirt's vertices welded across UV seams (after `subdivide` splits every triangle in four)
//   stretch      every triangle edge keeps its length
//   bend         every inner edge keeps the signed fold angle between its two triangles. Flat edges (the cloth itself):
//                stiffness from the fabric's bending rigidity B (N m, measured: fabric.ts), as in Discrete Shells
//                (Grinspun et al. 2003): energy 1/2 k (angle - rest)^2 with k = 3 B |e|^2 / (A1 + A2), so the bending does
//                not depend on how finely the mesh is cut. XPBD compliance 1/k, for points of real mass (the fabric's weight
//                per area times the area each point stands for): with the solver's unit masses that is m / k.
//                (Until 2026-11-15 the two vertices facing each other across the edge kept their distance, with a
//                compliance of no unit: a distance hardly changes while the cloth is flat, and a blazer bent like a knit.)
//                creases (the pleats' folds, bent more than `creaseAngle` at rest): the same angle, kept stiffer, like a
//                heat-set pleat (`crease`: no measured value found for a pressed pleat, so still a compliance of its own)
//   self         points keep at least `thickness` apart (or their rest distance, where layers are stacked closer)
//   tether       no point gets further from its nearest pinned point than in the rest shape (stops rubber-band
//                stretch when the cloth is yanked)
//   body         signed distance grid of the legs and hips (sdf.js), with friction
//   air          per triangle, once a frame: pressure drag growing with the square of the speed through the air
//                (0.5 * rho * Cd / fabric weight per area), wind shielded on the side the body and the far wall
//                cover, and the air caught under the skirt when the body drops or the wind blows up into it
//                (stagnation pressure, pushes every wall outward). Plus a small linear drag per point for damping
// What moves the cloth from outside is given as frames (3x4 matrices, rest -> now), all interpolated over the substeps:
//   frames.ref         the body as a whole (the hips): the frame in which "who is near whom" and the air caught under
//                      the skirt are judged
//   frames.colliders   one per distance grid: where that piece of the body is now
//   frames.pinTarget   where each held point is now
// A driver fills them before step() and sets `driven`. Without one, the body is one rigid piece moved by
// `body` = (x, y, z, yaw about a vertical axis through `pivot`), and the held points follow it.

// `extra` (optional): one more number per vertex, averaged the same way (used for "how free is this vertex")
export function subdivide(position: ArrayLike<number>, uv: ArrayLike<number>, index: ArrayLike<number>, extra: ArrayLike<number> | null = null) {
  const pos = Array.from(position), uvs = Array.from(uv), idx: number[] = [], mid = new Map<number, number>(), ext = extra ? Array.from(extra) : null;
  const made: number[] = [];   // for every new vertex, the two it lies between
  const m = (a: number, b: number): number => {
    const k = a < b ? a * 1e7 + b : b * 1e7 + a;
    let i = mid.get(k);
    if (i === undefined) {
      i = pos.length / 3; mid.set(k, i);
      for (let c = 0; c < 3; c++) pos.push((pos[a * 3 + c] + pos[b * 3 + c]) / 2);
      for (let c = 0; c < 2; c++) uvs.push((uvs[a * 2 + c] + uvs[b * 2 + c]) / 2);
      if (ext) ext.push((ext[a] + ext[b]) / 2);
      made.push(a, b);
    }
    return i;
  };
  for (let f = 0; f < index.length; f += 3) {
    const a = index[f], b = index[f + 1], c = index[f + 2], ab = m(a, b), bc = m(b, c), ca = m(c, a);
    idx.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  return { position: new Float32Array(pos), uv: new Float32Array(uvs), index: new Uint32Array(idx), extra: ext ? new Float32Array(ext) : null, made: new Uint32Array(made), before: position.length / 3 };
}

// signed fold angle across the edge a-b, with c and d the third corners of its two triangles; 0 when flat
export function foldAngle(X: ArrayLike<number>, a: number, b: number, c: number, d: number): number {
  const p = (i: number, k: number) => X[i * 3 + k];
  const sub = (i: number, j: number) => [p(i, 0) - p(j, 0), p(i, 1) - p(j, 1), p(i, 2) - p(j, 2)];
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const e = sub(b, a), n1 = cross(sub(c, a), sub(c, b)), n2 = cross(sub(d, b), sub(d, a));
  return Math.atan2(dot(cross(n1, n2), e) / Math.hypot(...e), dot(n1, n2));
}
const GRAD_SIGN = -1;   // solveHinges' u is -d(angle)/dx (checked by finite differences, test-fold.mjs)

// fold angles: keep the signed angle across each edge (C: [edge end, edge end, wing, wing] per edge, T: the angles to
// keep). The compliance is `alpha` for every edge, or per edge `alphas[q] * scale`. `invMass` (optional): each point's
// 1 / mass (kg), multiplied into `w`: with it the hinges move the points as their real masses would (the fabric's bending,
// compliance 1 / k), without it every point weighs 1 (the creases, whose compliance has no unit). (Until the review of
// 2026-11-15 the fabric's hinges used every point at 1 and a compliance of their 4 points' mean mass / k: right only for
// equal masses, and the knit's samples differ up to 30 times, so the bending alone moved their centre of mass.)
export function solveHinges(x: Float64Array, w: ArrayLike<number>, C: Uint32Array, T: Float64Array, alpha: number, alphas: Float64Array | null = null, scale = 0, invMass: ArrayLike<number> | null = null): void {
  for (let q = 0; q < T.length; q++) {
    const i3 = C[q * 4], i4 = C[q * 4 + 1], i1 = C[q * 4 + 2], i2 = C[q * 4 + 3];
    const w1 = invMass ? w[i1] * invMass[i1] : w[i1], w2 = invMass ? w[i2] * invMass[i2] : w[i2], w3 = invMass ? w[i3] * invMass[i3] : w[i3], w4 = invMass ? w[i4] * invMass[i4] : w[i4];
    if (!(w1 + w2 + w3 + w4)) continue;
    const k1 = i1 * 3, k2 = i2 * 3, k3 = i3 * 3, k4 = i4 * 3;
    const ex = x[k4] - x[k3], ey = x[k4 + 1] - x[k3 + 1], ez = x[k4 + 2] - x[k3 + 2];
    const ax = x[k1] - x[k3], ay = x[k1 + 1] - x[k3 + 1], az = x[k1 + 2] - x[k3 + 2];   // wing 1 from the edge's ends
    const bx = x[k1] - x[k4], by = x[k1 + 1] - x[k4 + 1], bz = x[k1 + 2] - x[k4 + 2];
    const cx = x[k2] - x[k4], cy = x[k2 + 1] - x[k4 + 1], cz = x[k2 + 2] - x[k4 + 2];   // wing 2
    const dx = x[k2] - x[k3], dy = x[k2 + 1] - x[k3 + 1], dz = x[k2 + 2] - x[k3 + 2];
    const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx;
    const n2x = cy * dz - cz * dy, n2y = cz * dx - cx * dz, n2z = cx * dy - cy * dx;
    const s1 = n1x * n1x + n1y * n1y + n1z * n1z, s2 = n2x * n2x + n2y * n2y + n2z * n2z, el = Math.sqrt(ex * ex + ey * ey + ez * ez);
    if (s1 < 1e-16 || s2 < 1e-16 || el < 1e-9) continue;
    const cos = n1x * n2x + n1y * n2y + n1z * n2z;
    const sin = ((n1y * n2z - n1z * n2y) * ex + (n1z * n2x - n1x * n2z) * ey + (n1x * n2y - n1y * n2x) * ez) / el;
    let Cq = Math.atan2(sin, cos) - T[q];
    if (Cq > Math.PI) Cq -= 2 * Math.PI; else if (Cq < -Math.PI) Cq += 2 * Math.PI;
    // gradient of the angle (Bridson et al. 2003, "Simulation of clothing with folds and wrinkles")
    const f1 = el / s1, f2 = el / s2;
    const invEdge2 = 1 / (ex * ex + ey * ey + ez * ez);
    const g3a = (bx * ex + by * ey + bz * ez) * (invEdge2 * f1), g3b = (cx * ex + cy * ey + cz * ez) * (invEdge2 * f2);
    const g4a = -(ax * ex + ay * ey + az * ez) * (invEdge2 * f1), g4b = -(dx * ex + dy * ey + dz * ez) * (invEdge2 * f2);
    const u1x = f1 * n1x, u1y = f1 * n1y, u1z = f1 * n1z, u2x = f2 * n2x, u2y = f2 * n2y, u2z = f2 * n2z;
    const u3x = g3a * n1x + g3b * n2x, u3y = g3a * n1y + g3b * n2y, u3z = g3a * n1z + g3b * n2z;
    const u4x = g4a * n1x + g4b * n2x, u4y = g4a * n1y + g4b * n2y, u4z = g4a * n1z + g4b * n2z;
    const den = w1 * (u1x * u1x + u1y * u1y + u1z * u1z) + w2 * (u2x * u2x + u2y * u2y + u2z * u2z)
      + w3 * (u3x * u3x + u3y * u3y + u3z * u3z) + w4 * (u4x * u4x + u4y * u4y + u4z * u4z) + (alphas ? alphas[q] * scale : alpha);
    const lam = -GRAD_SIGN * Cq / den;
    x[k1] += lam * w1 * u1x; x[k1 + 1] += lam * w1 * u1y; x[k1 + 2] += lam * w1 * u1z;
    x[k2] += lam * w2 * u2x; x[k2 + 1] += lam * w2 * u2y; x[k2 + 2] += lam * w2 * u2z;
    x[k3] += lam * w3 * u3x; x[k3 + 1] += lam * w3 * u3y; x[k3 + 2] += lam * w3 * u3z;
    x[k4] += lam * w4 * u4x; x[k4 + 1] += lam * w4 * u4y; x[k4 + 2] += lam * w4 * u4z;
  }
}

/**
 * 生地の曲げの拘束（Discrete Shells：Grinspun ほか 2003）。三角形の内側の辺ごとに、2 枚の面の角度を保つ。
 * 強さ k = 3 B |e|^2 / (A1 + A2)（B は生地の曲げ剛性 N·m）。返す alphas は柔らかさ 1 / k で、solveHinges に点ごとの
 * 1 / 重さ（kg）を渡して解く。faces の向きはそろっていること。辺がちょうど 2 枚の面に挟まれているときだけ拘束にする。
 * keep(a, b, c, d, angle) が false の辺は外す（折り目を別に扱うときなど）
 */
export function fabricHinges(P: ArrayLike<number>, faces: ArrayLike<number>, bending: number,
  keep: ((a: number, b: number, c: number, d: number, angle: number) => boolean) | null = null) {
  const area = (a: number, b: number, c: number) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const edges = new Map<string, number[]>();
  for (let f = 0; f < faces.length; f += 3) for (let k = 0; k < 3; k++) {
    const a = faces[f + k], b = faces[f + (k + 1) % 3], c = faces[f + (k + 2) % 3], key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = edges.get(key);
    if (e) e.push(c); else edges.set(key, [a, b, c]);
  }
  const C: number[] = [], T: number[] = [], A: number[] = [];
  for (const e of edges.values()) {
    if (e.length !== 4) continue;
    const [a, b, c, d] = e, angle = foldAngle(P, a, b, c, d);
    if (keep && !keep(a, b, c, d, angle)) continue;
    const len2 = (P[a * 3] - P[b * 3]) ** 2 + (P[a * 3 + 1] - P[b * 3 + 1]) ** 2 + (P[a * 3 + 2] - P[b * 3 + 2]) ** 2;
    const k = 3 * bending * len2 / Math.max(1e-12, area(a, b, c) + area(a, b, d));
    C.push(a, b, c, d); T.push(angle); A.push(1 / k);
  }
  return { C: new Uint32Array(C), T: new Float64Array(T), alphas: new Float64Array(A) };
}

// `free` (optional): per vertex, 1 = cloth, 0 = held to the body (from a rig's weights); without it the top is held
// 3x4 matrices, row-major: [r00 r01 r02 tx  r10 r11 r12 ty  r20 r21 r22 tz]
const I12 = () => Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);
function inv12(m: Float64Array, out: Float64Array): void {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C, q = 1 / det;
  const r0 = A * q, r1 = (c * h - b * i) * q, r2 = (b * f - c * e) * q;
  const r3 = B * q, r4 = (a * i - c * g) * q, r5 = (c * d - a * f) * q;
  const r6 = C * q, r7 = (b * g - a * h) * q, r8 = (a * e - b * d) * q;
  out[0] = r0; out[1] = r1; out[2] = r2; out[3] = -(r0 * m[3] + r1 * m[7] + r2 * m[11]);
  out[4] = r3; out[5] = r4; out[6] = r5; out[7] = -(r3 * m[3] + r4 * m[7] + r5 * m[11]);
  out[8] = r6; out[9] = r7; out[10] = r8; out[11] = -(r6 * m[3] + r7 * m[7] + r8 * m[11]);
}

// `colliders` (optional): [{ sdf, rest }] distance grids of pieces of the body, each in its own space; `rest` is the
// 3x4 matrix from that space to the world in the pose the cloth is given in (identity when left out). `sdf` alone is
// one grid in world space.
export interface ClothOptions {
  substeps: number; gravity: number;
  stretch: number; crease: number; creaseAngle: number;
  thickness: number; selfEvery: number; pairSlack: number; selfFriction: number;
  shapeEvery: number; maxRebuilds: number; minEdge: number; maxSpeed: number;
  shape: number; shapeMin: number; shapeMax: number; shapePer: number; shapeScale: number;
  tetherSlack: number; margin: number; friction: number;
  air: number; drag: number; inflate: number; shield: number; gust: number; maxAero: number;
  damping: number; pinBelowTop: number; grabRadius: number; handMargin: number; handFriction: number;
  groundMargin: number; groundFriction: number;
  sleep: boolean; quietAccel: number; quietSpeed: number; quietAir: number; calmAfter: number; sleepAfter: number; sleepSpeed: number;
  calmDamping: number; wakeDist: number; wakeAngle: number;
}
export interface ClothCollider { sdf: DistanceGrid; rest?: Float64Array }
/**
 * 布の下の、動かない面（床・椅子の座面・ベッドなど）を真上から測った高さの地図（ワールド座標、y が上）。
 * 格子の 1 マスごとに、上から順に最大 `layers` 枚の面の高さを持つ（使わない所は -Infinity）。机の天板とその下の床のように、
 * 上に物がある所も表せる。布の点は、自分の高さから band（solver の groundBand）より上にない面のうち、いちばん高い面の上に乗る
 */
export interface GroundField {
  /** 格子の角（ワールドの x と z、m） */
  x0: number; z0: number;
  /** 1 マスの大きさ（m） */
  cell: number;
  nx: number; nz: number;
  layers: number;
  /** マス (i, j) の面の高さ：h[(j * nx + i) * layers + l]。l が小さいほど高い面 */
  h: Float32Array;
}
export interface ClothInput {
  position: ArrayLike<number>;
  index: ArrayLike<number>;
  sdf?: DistanceGrid | null;
  colliders?: ClothCollider[] | null;
  pivot: [number, number];
  free?: ArrayLike<number> | null;
  opts?: Partial<ClothOptions>;
  /**
   * 生地（fabric.ts）。曲げの強さと点の重さを、生地の曲げ剛性（N·m）と面積あたりの重さ（kg/m²）から決める。
   * 位置はメートルで渡すこと。既定はスーツ地
   */
  fabric?: FabricSpec;
}
interface Grab { ids: number[]; off: number[]; centre: number; target: number[]; prev: number[] }
export type Cloth = ReturnType<typeof createCloth>;

export function createCloth({ position, index, sdf = null, colliders = null, pivot, free = null, opts = {}, fabric: fabricSpec = 'suiting' }: ClothInput) {
  const fabric = fabricOf(fabricSpec);
  const o: ClothOptions = {
    substeps: 16, gravity: -9.8,
    stretch: 0,        // compliance of the edges (0 = as stiff as the substeps allow)
    crease: 2e-3, creaseAngle: 0.35,   // compliance of the fold angles (rad), and how bent an edge must be to count
    thickness: 0.008, selfEvery: 1, pairSlack: 0.006, selfFriction: 0.15,
    // selfEvery 1: solved every other substep, cloth folded on itself never came to rest. The other constraints pulled
    // the layers together in the substeps between and this pushed them apart again (a seated skirt: 141 of 1097
    // points above 0.3 m/s; solved every substep, 5)
    shapeEvery: 2, maxRebuilds: 3,
    minEdge: 0.0025,   // points closer than this along an edge are merged (Tripo leaves sub-millimetre triangles)
    maxSpeed: 6,
    shape: 2e-3,       // compliance of the long distances (see below); larger = the flare sags more
    shapeMin: 0.05, shapeMax: 0.09, shapePer: 4,
    // how much of the long distances is kept, 0-1 (may be changed while running). They hold the skirt's flare as modelled;
    // with the thighs raised (sitting, lying) that is not how the cloth falls any more, and at 1 a seated skirt stood out
    // round its thighs like a bell. SkinnedCloth lowers it to 0 then (`legs`): the cloth lies on the body as it falls
    shapeScale: 1,
    tetherSlack: 1.06,
    // margin: how far out of the body the points are kept (m). Between points the cloth is a flat triangle that a rounded body
    // (a bent knee) can cut through: at 4 mm a seated skirt still showed the knee in a 1 cm sliver, at 6 mm none.
    // Points nearer the body than this as modelled keep that distance instead (col.margin), so a fitted skirt does not swell
    margin: 0.006, friction: 0.5,
    air: 1,            // linear drag along the normal, 1/s
    drag: 0.72 / fabric.weight,     // quadratic drag, 1/m: 0.5 * 1.2 kg/m3 * Cd 1.2 / the fabric's weight per area
    inflate: 0.48 / fabric.weight,  // caught air, 1/m: 0.5 * 1.2 / weight, times 0.8 for what leaks out
    shield: 0.3,       // share of the wind that reaches a wall from its inner side
    gust: 0.3,         // how much the wind differs from place to place
    maxAero: 80,       // m/s2
    damping: 0.4,      // plain velocity damping, 1/s
    pinBelowTop: 0.012,   // points this close under the top rim are held too
    grabRadius: 0.03,
    // hands (setCapsules): how far out of the capsule the cloth is kept (m), and how much of its slide along the hand it loses
    handMargin: 0.003, handFriction: 0.6,   // 0.9: cloth blown against a hand hanging at the side wrapped round it and stayed on it
    // ground (setGround): how far above a surface the points are kept (m); the friction coefficient against it (Coulomb, applied as in Macklin et al. 2014 "Unified Particle Physics": the slide is stopped
    // while it is shorter than coefficient x the push, otherwise shortened by that much. 0.6: cotton on upholstery and wood
    // measure about 0.5-0.7)
    groundMargin: 0.004, groundFriction: 0.6,
    // ---- sleep: with nothing moving the cloth from outside, it is brought to rest and then not simulated at all ----
    // "Nothing from outside": the hips do not change speed (quietAccel), the body's pieces and the held points do not move
    // against the hips (quietSpeed), no wind, no pinch. After calmAfter seconds of that the damping grows (to calmDamping),
    // and the cloth is put to sleep once its points are slower than sleepSpeed against the hips, or sleepAfter seconds
    // after the quiet began whatever they do (so it always comes to rest; a skirt still swinging from a spin has had time
    // to swing out by then). Asleep, every point rides rigidly on the hips. It wakes when the hips change speed, a piece of
    // the body or a held point has moved wakeDist from where it was against the hips, the hips have tilted wakeAngle
    // (gravity now pulls another way), the wind blows or the cloth is pinched. Waking goes on from where it was, at the speed
    // it was carried at: nothing jumps either way. Off (sleep: false) for cloth that must keep moving with nothing driving
    // it (slow motion of a small sway, say).
    sleep: true,
    quietAccel: 2,      // m/s2
    quietSpeed: 0.05,   // m/s
    // m/s: the hips carry the cloth through the air no faster than this (the air against the cloth is what the drag works on:
    // without it a character slid along at 1 m/s fell asleep and stopped being blown back. Codex's review, 2026-11-15).
    // At 0.3 m/s the drag is 0.3 m/s2 at most, 3% of gravity
    quietAir: 0.3,
    calmAfter: 0.3, sleepAfter: 1.2,   // s
    sleepSpeed: 0.03,   // m/s
    calmDamping: 8,     // 1/s
    wakeDist: 0.004,    // m
    wakeAngle: 0.05,    // rad
    ...opts,
  };
  const nR = position.length / 3;
  // ---- weld ----
  const ids = new Map<string, number>(), map = new Uint32Array(nR), rest: number[] = [];
  for (let i = 0; i < nR; i++) {
    const k = `${Math.round(position[i * 3] * 1e5)},${Math.round(position[i * 3 + 1] * 1e5)},${Math.round(position[i * 3 + 2] * 1e5)}`;
    let id = ids.get(k);
    if (id === undefined) { id = rest.length / 3; ids.set(k, id); rest.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]); }
    map[i] = id;
  }
  {
    const m = rest.length / 3, par = Int32Array.from({ length: m }, (_, i) => i);
    const find = (a: number): number => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let f = 0; f < index.length; f += 3) for (let k = 0; k < 3; k++) {
      const a = map[index[f + k]], b = map[index[f + (k + 1) % 3]];
      if (a !== b && Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1], rest[a * 3 + 2] - rest[b * 3 + 2]) < o.minEdge) par[find(a)] = find(b);
    }
    const id = new Int32Array(m).fill(-1), sum: number[] = [], cnt: number[] = [];
    for (let i = 0; i < m; i++) {
      const r = find(i);
      if (id[r] < 0) { id[r] = cnt.length; cnt.push(0); sum.push(0, 0, 0); }
      const q = id[r]; cnt[q]++; sum[q * 3] += rest[i * 3]; sum[q * 3 + 1] += rest[i * 3 + 1]; sum[q * 3 + 2] += rest[i * 3 + 2];
    }
    for (let i = 0; i < nR; i++) map[i] = id[find(map[i])];
    rest.length = 0;
    for (let q = 0; q < cnt.length; q++) rest.push(sum[q * 3] / cnt[q], sum[q * 3 + 1] / cnt[q], sum[q * 3 + 2] / cnt[q]);
  }
  const n = rest.length / 3;
  const X0 = new Float64Array(rest), x = new Float64Array(rest), xp = new Float64Array(rest), v = new Float64Array(n * 3);
  const faces: number[] = [];
  for (let f = 0; f < index.length; f += 3) {
    const a = map[index[f]], b = map[index[f + 1]], c = map[index[f + 2]];
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  const F = new Uint32Array(faces), nF = F.length / 3;

  // ---- edges, bend pairs, rim ----
  const edge = new Map<number, [number, number, number, number]>();   // key -> [i, j, opposite vertex of first face, of second face]
  for (let f = 0; f < nF; f++) for (let k = 0; k < 3; k++) {
    const a = F[f * 3 + k], b = F[f * 3 + (k + 1) % 3], c = F[f * 3 + (k + 2) % 3];
    const key = a < b ? a * 1e7 + b : b * 1e7 + a;
    const e = edge.get(key);
    if (e) e[3] = c; else edge.set(key, [a, b, c, -1]);
  }
  const dist0 = (i: number, j: number) => Math.hypot(X0[i * 3] - X0[j * 3], X0[i * 3 + 1] - X0[j * 3 + 1], X0[i * 3 + 2] - X0[j * 3 + 2]);
  const cs: number[] = [], cd: number[] = [], cth: number[] = [];
  let topY = -Infinity;
  for (let i = 0; i < n; i++) topY = Math.max(topY, X0[i * 3 + 1]);
  const midY = (topY + Math.min(...Array.from({ length: n }, (_, i) => X0[i * 3 + 1]))) / 2;
  const w = new Float64Array(n).fill(1);
  const hemY = midY - (topY - midY) * 0.6;
  const botY = 2 * midY - topY, rimTop: number[] = [];
  let rimLow = topY;
  for (const [a, b, c, d] of edge.values()) {
    cs.push(a, b);
    if (d >= 0) {
      const th = foldAngle(X0, a, b, c, d);
      if (Math.abs(th) > o.creaseAngle) { cd.push(a, b, c, d); cth.push(th); }
    } else if (!free && X0[a * 3 + 1] > topY - 0.15 * (topY - botY) && X0[b * 3 + 1] > topY - 0.15 * (topY - botY)) { w[a] = 0; w[b] = 0; rimTop.push(X0[a * 3 + 1], X0[b * 3 + 1]); }
  }
  // What is held to the waist: the open rim at the top, and everything above `pinY`. Normally that is a narrow band
  // under the top; when the top is a waistband folded over (its open rim sits lower, inside), the whole band.
  const anchors: number[] = [];   // the points held at the waist: what the rest of the cloth is tethered to
  rimTop.sort((a, b) => a - b);
  const pinY = rimTop.length ? Math.min(topY - o.pinBelowTop, rimTop[rimTop.length >> 1] - 0.002) : topY - Math.max(o.pinBelowTop, 0.04 * (topY - botY));
  rimLow = pinY;
  if (free) { for (let i = 0; i < nR; i++) if (free[i] < 0.5) w[map[i]] = 0; }
  else for (let i = 0; i < n; i++) if (X0[i * 3 + 1] > pinY) w[i] = 0;
  {   // a piece with nothing held (a stray fragment of the mesh) rides with the waist instead of falling
    const par = Int32Array.from({ length: n }, (_, i) => i);
    const find = (a: number): number => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    for (let k = 0; k < cs.length; k += 2) par[find(cs[k])] = find(cs[k + 1]);
    const held = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!w[i]) { held[find(i)] = 1; anchors.push(i); }
    for (let i = 0; i < n; i++) if (!held[find(i)]) w[i] = 0;
  }
  const pinned: number[] = []; for (let i = 0; i < n; i++) if (!w[i]) pinned.push(i);
  const CS = new Uint32Array(cs), LS = new Float64Array(cs.length / 2);
  // ---- the fabric: each point's mass (weight per area times a third of its triangles' area) and each flat edge's
  // bending stiffness (Discrete Shells), as a compliance for the solver's unit masses: mean mass of its 4 points / k ----
  const triArea = (P: ArrayLike<number>, a: number, b: number, c: number) => {
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  };
  const mass = new Float64Array(n);
  for (let f = 0; f < nF; f++) { const A = triArea(X0, F[f * 3], F[f * 3 + 1], F[f * 3 + 2]) / 3; for (let k = 0; k < 3; k++) mass[F[f * 3 + k]] += A * fabric.weight; }
  const { C: CB, T: TB, alphas: AB } = fabricHinges(X0, F, fabric.bending, (_a, _b, _c, _d, angle) => Math.abs(angle) <= o.creaseAngle);
  const invMass = Float64Array.from(mass, (m) => (m > 0 ? 1 / m : 0));
  for (let k = 0; k < LS.length; k++) LS[k] = dist0(CS[k * 2], CS[k * 2 + 1]);
  const CD = new Uint32Array(cd), TH = new Float64Array(cth);
  // ---- long distances: each point keeps its distance to a few points 5-9cm away, softly. Edge-to-edge bending alone
  // only carries stiffness a couple of centimetres per pass, so the flare of the pleated cone sags under its weight;
  // these carry it across a pleat. They tie cloth to cloth, never to the body, so a lifted skirt still falls freely.
  const cl: number[] = [];
  {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const count = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const cand: number[] = [];
      if (!(o.shapePer > 0)) break;
      const lo = o.shapeMin ** 2, hi = o.shapeMax ** 2, ax = X0[i * 3], ay = X0[i * 3 + 1], az = X0[i * 3 + 2];
      for (let j = 0; j < n; j++) {
        const dx = X0[j * 3] - ax, dy = X0[j * 3 + 1] - ay, dz = X0[j * 3 + 2] - az, d = dx * dx + dy * dy + dz * dz;
        if (d >= lo && d <= hi) cand.push(j);
      }
      for (let t = 0; t < 40 && count[i] < o.shapePer && cand.length; t++) {
        const j = cand[(rnd() * cand.length) | 0];
        if (count[j] >= o.shapePer + 2) continue;
        cl.push(i, j); count[i]++; count[j]++;
      }
    }
  }
  const CL = new Uint32Array(cl), LL = new Float64Array(cl.length / 2);
  for (let k = 0; k < LL.length; k++) LL[k] = dist0(CL[k * 2], CL[k * 2 + 1]);
  // ---- tether to the nearest pinned point ----
  const tPin = new Int32Array(n).fill(-1), tLen = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!w[i]) continue;
    let best = Infinity;
    for (const p of anchors) { const d = dist0(i, p); if (d < best) { best = d; tPin[i] = p; } }
    tLen[i] = best * o.tetherSlack;
  }
  // ---- how deep each point sits in the body at rest: it is not pushed further out than that ----
  const cols = (colliders ?? (sdf ? [{ sdf }] : [])).map((c) => {
    const col = { sdf: c.sdf, M: I12(), prev: I12(), cur: I12(), last: I12(), inv: I12(), margin: new Float64Array(n), motion: new FrameInterpolation() };
    if (c.rest) col.M.set(c.rest);
    col.prev.set(col.M); col.cur.set(col.M); col.last.set(col.M); inv12(col.M, col.inv);
    const m = col.inv;
    for (let i = 0; i < n; i++) {
      const px = X0[i * 3], py = X0[i * 3 + 1], pz = X0[i * 3 + 2];
      col.margin[i] = Math.min(o.margin, col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]) - 0.0005);
    }
    return col;
  });
  // how far each point is from the body at rest (m; the nearest piece, capped at the grids' band): room to press it in
  const restGap = new Float64Array(n).fill(Infinity);
  for (const col of cols) {
    const m = col.inv;
    for (let i = 0; i < n; i++) {
      const px = X0[i * 3], py = X0[i * 3 + 1], pz = X0[i * 3 + 2];
      restGap[i] = Math.min(restGap[i], col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]));
    }
  }
  const ref = { M: I12(), prev: I12(), cur: I12(), inv: I12(), motion: new FrameInterpolation() };
  const pinTarget = new Float64Array(X0), pinPrev = new Float64Array(X0);
  const frames = { ref, colliders: cols, pinTarget };

  const nrm = new Float64Array(n * 3);
  function normals() {
    nrm.fill(0);
    for (let f = 0; f < nF; f++) {
      const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      nrm[a] += nx; nrm[a + 1] += ny; nrm[a + 2] += nz; nrm[b] += nx; nrm[b + 1] += ny; nrm[b + 2] += nz; nrm[c] += nx; nrm[c + 1] += ny; nrm[c + 2] += nz;
    }
    for (let i = 0; i < n * 3; i += 3) {
      const l = Math.sqrt(nrm[i] * nrm[i] + nrm[i + 1] * nrm[i + 1] + nrm[i + 2] * nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
  }
  normals();

  // ---- air ----
  let outSign = 0;   // +1 when the triangles' normals point away from the body
  for (let f = 0; f < nF; f++) {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const ux = X0[b] - X0[a], uy = X0[b + 1] - X0[a + 1], uz = X0[b + 2] - X0[a + 2];
    const vx = X0[c] - X0[a], vy = X0[c + 1] - X0[a + 1], vz = X0[c + 2] - X0[a + 2];
    outSign += (uy * vz - uz * vy) * ((X0[a] + X0[b] + X0[c]) / 3 - pivot[0]) + (ux * vy - uy * vx) * ((X0[a + 2] + X0[b + 2] + X0[c + 2]) / 3 - pivot[1]);
  }
  outSign = outSign >= 0 ? 1 : -1;
  const aero = new Float64Array(n * 3), aeroW = new Float64Array(n);
  let clock = 0;
  function computeAero(dt: number): void {
    clock += dt;
    aero.fill(0); aeroW.fill(0);
    const wl = Math.hypot(wind[0], wind[1], wind[2]), wx = wl ? wind[0] / wl : 0, wy = wl ? wind[1] / wl : 0, wz = wl ? wind[2] / wl : 0;
    // air entering the hem from below: the wind's rise against how fast the waist is dropping
    const up = Math.max(0, wind[1] - ((ref.M[4] - ref.prev[4]) * pivot[0] + (ref.M[5] - ref.prev[5]) * topY + (ref.M[6] - ref.prev[6]) * pivot[1] + ref.M[7] - ref.prev[7]) / dt);
    const fill = o.inflate * up * up * outSign;
    for (let f = 0; f < nF; f++) {
      const i = F[f * 3], j = F[f * 3 + 1], l = F[f * 3 + 2], a = i * 3, b = j * 3, c = l * 3;
      const ux = x[b] - x[a], uy = x[b + 1] - x[a + 1], uz = x[b + 2] - x[a + 2];
      const vx = x[c] - x[a], vy = x[c + 1] - x[a + 1], vz = x[c + 2] - x[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const A2 = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (A2 < 1e-12) continue;
      nx /= A2; ny /= A2; nz /= A2;
      // the wind here: weaker where it would have to come through the body, and uneven in space and time
      const inner = (nx * wx + ny * wy + nz * wz) * outSign > 0;
      const k = !wl ? 1 : (inner ? o.shield : 1) * (1 + o.gust * Math.sin(9 * x[a] + 6 * x[a + 1] + 7 * x[a + 2] + 11 * clock) * Math.sin(5 * x[a + 2] - 7 * clock));
      const rx = (v[a] + v[b] + v[c]) / 3 - wind[0] * k, ry = (v[a + 1] + v[b + 1] + v[c + 1]) / 3 - wind[1] * k, rz = (v[a + 2] + v[b + 2] + v[c + 2]) / 3 - wind[2] * k;
      const vn = rx * nx + ry * ny + rz * nz;
      const m = (-o.drag * Math.abs(vn) * vn + fill) * A2;
      const fx = nx * m, fy = ny * m, fz = nz * m;
      aero[a] += fx; aero[a + 1] += fy; aero[a + 2] += fz; aero[b] += fx; aero[b + 1] += fy; aero[b + 2] += fz; aero[c] += fx; aero[c + 1] += fy; aero[c + 2] += fz;
      aeroW[i] += A2; aeroW[j] += A2; aeroW[l] += A2;
    }
    for (let i = 0; i < n; i++) {
      if (!aeroW[i]) continue;
      const k = i * 3, q = 1 / aeroW[i];
      let ax = aero[k] * q, ay = aero[k + 1] * q, az = aero[k + 2] * q;
      const l = Math.sqrt(ax * ax + ay * ay + az * az);
      if (l > o.maxAero) { const r = o.maxAero / l; ax *= r; ay *= r; az *= r; }
      aero[k] = ax; aero[k + 1] = ay; aero[k + 2] = az;
    }
  }

  // ---- body pose ----
  const body = { x: 0, y: 0, z: 0, yaw: 0 }, bodyPrev = { x: 0, y: 0, z: 0, yaw: 0 };
  const g: number[] = [0, 0, 0];
  let driven = false;
  // without a driver: one rigid body, the held points and every collider ride on it
  function followBody() {
    const c = Math.cos(body.yaw), s = Math.sin(body.yaw), m = ref.M;
    m[0] = c; m[1] = 0; m[2] = s; m[3] = pivot[0] + body.x - c * pivot[0] - s * pivot[1];
    m[4] = 0; m[5] = 1; m[6] = 0; m[7] = body.y;
    m[8] = -s; m[9] = 0; m[10] = c; m[11] = pivot[1] + body.z + s * pivot[0] - c * pivot[1];
    for (const col of cols) col.M.set(m);
    for (const i of pinned) {
      const k = i * 3, px = X0[k], py = X0[k + 1], pz = X0[k + 2];
      pinTarget[k] = m[0] * px + m[1] * py + m[2] * pz + m[3]; pinTarget[k + 1] = m[4] * px + m[5] * py + m[6] * pz + m[7]; pinTarget[k + 2] = m[8] * px + m[9] * py + m[10] * pz + m[11];
    }
  }
  // make "now" the start of the next step too (after a jump in the pose, so nothing is swept across the gap)
  function snapFrames() {
    ref.prev.set(ref.M);
    for (const col of cols) { col.prev.set(col.M); col.cur.set(col.M); col.last.set(col.M); }
    pinPrev.set(pinTarget);
    for (const i of pinned) { const k = i * 3; x[k] = pinTarget[k]; x[k + 1] = pinTarget[k + 1]; x[k + 2] = pinTarget[k + 2]; }
  }

  // ---- grab ----
  let grab: Grab | null = null;   // { ids, off, centre, target:[x,y,z], prev:[x,y,z] }
  function startGrab(px: number, py: number, pz: number): boolean {
    const ids: number[] = [], off: number[] = [];
    let centre = -1, best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      const dx = x[i * 3] - px, dy = x[i * 3 + 1] - py, dz = x[i * 3 + 2] - pz, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < best) { best = d; centre = i; }
      if (d < o.grabRadius) { ids.push(i); off.push(dx, dy, dz); }
    }
    if (centre < 0) return false;
    if (!ids.includes(centre)) { ids.push(centre); off.push(x[centre * 3] - px, x[centre * 3 + 1] - py, x[centre * 3 + 2] - pz); }
    for (const i of ids) w[i] = 0;
    grab = { ids, off, centre, target: [px, py, pz], prev: [px, py, pz] };
    return true;
  }
  function moveGrab(px: number, py: number, pz: number): void { if (grab) grab.target = [px, py, pz]; }
  function endGrab() { if (grab) { for (const i of grab.ids) w[i] = 1; grab = null; } }
  // the pinch is knocked away: let go, and send the cloth that was held off at this velocity
  function knock(vx: number, vy: number, vz: number): void {
    if (!grab) return;
    const ids = grab.ids;
    endGrab();
    for (const i of ids) { v[i * 3] = vx; v[i * 3 + 1] = vy; v[i * 3 + 2] = vz; }
  }

  // ---- hands: capsules moved from outside (setCapsules, world, every frame before step) ----
  // The hand is not pushed by the cloth: the cloth makes way for it (the cloth yields to the hand). Each capsule is a segment
  // a-b with a radius; between the frame before and now it is moved linearly over the substeps, so a hand sweeping down
  // carries the cloth with it instead of passing through it. Touching cloth is dragged along by the hand's own motion
  // (`handFriction`, 1 = it does not slide on the palm at all): a palm on the hem keeps it there, as a hand holding a skirt
  // down does. Tested after the body, so the body still has the last word (cloth caught between the palm and the thigh
  // never ends up in the thigh; the hand placement leaves room for the cloth: avatar/skirtHold.ts).
  const MAX_CAPS = 64, CAP = 7;   // [ax, ay, az, bx, by, bz, radius]
  const capCur = new Float64Array(MAX_CAPS * CAP), capPrev = new Float64Array(MAX_CAPS * CAP);
  let capN = 0, capFresh = true;   // capFresh: no frame before to move from (the first frame they are given)
  const capA = new Float64Array(MAX_CAPS * CAP), capB = new Float64Array(MAX_CAPS * CAP);   // this substep and the one before
  const capCandN = new Uint8Array(n);
  let capCand = new Uint8Array(n * 4);
  const capRel = new Float64Array(MAX_CAPS * 6), capSlept = new Float64Array(MAX_CAPS * 6);
  let capsTouch = false;   // some capsule was near the cloth this frame
  function setCapsules(data: ArrayLike<number> | null, count: number): void {
    const c = data ? Math.min(MAX_CAPS, count) : 0;
    if (c !== capN) capFresh = true;
    capN = c;
    for (let k = 0; k < c * CAP; k++) capCur[k] = data![k];
  }
  // which capsules each point may touch this frame: near the capsule's box swept from the frame before, grown by how far
  // a point can travel in a frame
  function findCapCands(dt: number): void {
    capsTouch = false;
    if (!capN) { capCandN.fill(0); return; }
    const reach = o.maxSpeed * dt + o.handMargin + 0.01, per = Math.min(capN, 255);
    if (capCand.length < n * per) capCand = new Uint8Array(n * per);
    const box = new Float64Array(capN * 6);
    for (let q = 0; q < capN; q++) {
      const c = q * CAP, r = capCur[c + 6] + reach;
      for (let a = 0; a < 3; a++) {
        const lo = Math.min(capCur[c + a], capCur[c + 3 + a], capPrev[c + a], capPrev[c + 3 + a]);
        const hi = Math.max(capCur[c + a], capCur[c + 3 + a], capPrev[c + a], capPrev[c + 3 + a]);
        box[q * 6 + a] = lo - r; box[q * 6 + 3 + a] = hi + r;
      }
    }
    for (let i = 0; i < n; i++) {
      let cn = 0;
      if (w[i]) {
        const k = i * 3, px = x[k], py = x[k + 1], pz = x[k + 2];
        for (let q = 0; q < capN; q++) {
          const b = q * 6;
          if (px < box[b] || px > box[b + 3] || py < box[b + 1] || py > box[b + 4] || pz < box[b + 2] || pz > box[b + 5]) continue;
          capCand[i * per + cn++] = q;
        }
      }
      capCandN[i] = cn;
      if (cn) capsTouch = true;
    }
  }
  function capsAt(a: number, out: Float64Array): void {
    for (let k = 0; k < capN * CAP; k++) out[k] = capPrev[k] + (capCur[k] - capPrev[k]) * a;
  }
  function solveCapsules(): void {
    const per = Math.min(capN, 255), m = o.handMargin, fr = o.handFriction;
    for (let i = 0; i < n; i++) {
      const cn = capCandN[i];
      if (!cn || !w[i]) continue;
      const k = i * 3;
      for (let e = 0; e < cn; e++) {
        const c = capCand[i * per + e] * CAP;
        const ax = capA[c], ay = capA[c + 1], az = capA[c + 2], ux = capA[c + 3] - ax, uy = capA[c + 4] - ay, uz = capA[c + 5] - az;
        const px = x[k], py = x[k + 1], pz = x[k + 2], uu = ux * ux + uy * uy + uz * uz;
        let t = uu > 1e-12 ? ((px - ax) * ux + (py - ay) * uy + (pz - az) * uz) / uu : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const cx = ax + ux * t, cy = ay + uy * t, cz = az + uz * t;
        let dx = px - cx, dy = py - cy, dz = pz - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz), r = capA[c + 6] + m;
        if (d >= r) continue;
        if (d < 1e-7) continue;   // on the axis: no side to push to
        dx /= d; dy /= d; dz /= d;
        const push = r - d;
        x[k] += dx * push; x[k + 1] += dy * push; x[k + 2] += dz * push;
        // friction: the slide along the surface, against how the hand moved this spot in the substep
        const bx = capB[c] + (capB[c + 3] - capB[c]) * t, by = capB[c + 1] + (capB[c + 4] - capB[c + 1]) * t, bz = capB[c + 2] + (capB[c + 5] - capB[c + 2]) * t;
        const sx = (x[k] - xp[k]) - (cx - bx), sy = (x[k + 1] - xp[k + 1]) - (cy - by), sz = (x[k + 2] - xp[k + 2]) - (cz - bz);
        const sn = sx * dx + sy * dy + sz * dz;
        x[k] -= (sx - sn * dx) * fr; x[k + 1] -= (sy - sn * dy) * fr; x[k + 2] -= (sz - sn * dz) * fr;
      }
    }
  }

  // ---- ground: surfaces that do not move (setGround, world, y up): the floor, a chair's seat, a bed ----
  // Three sources, the highest one under a point wins:
  //   floor   a level plane (y), everything below it is solid
  //   field   surfaces measured from above (GroundField): only those under the `ceiling` (the waist) count. Cloth hangs
  //           from the waist, so it cannot have got under a surface lower than that (a seat), but it can be under a higher
  //           one (the knees and the lap under a desk top). (Counting only the surfaces a little above each point left a
  //           skirt put straight into a sitting pose through the seat: its back was already 10-20 cm under it.)
  //   boxes   level rectangles (centre x, z, the angle of their first side, half lengths, top y), same rule as the field
  //           (SkinnedCloth puts a seat under the thighs here when nothing measured holds a sitting body up)
  // A point under its surface comes back to it straight up, unless it came in from the side (it was outside a substep ago,
  // over a lower surface, at a height already under this one): then it goes back sideways to the edge, when that is the
  // shorter way (cloth hanging down past the front of a seat is not lifted onto it). Tested before the body, which has
  // the last word (cloth caught between the seat and the buttocks stays out of the body).
  let gField: GroundField | null = null, gFloor = -Infinity, gCeil = Infinity, gBoxes = new Float64Array(0), gBoxN = 0, gOn = false, gFresh = false;
  const BOX = 7;   // [cx, cz, cos, sin, half length along (cos, sin), half length across, top]
  // points the ground pushed up in this substep. Pushed back down by the body after that, they are caught between the two
  // (under the buttocks on a seat) and held there by friction from both sides: they do not slide sideways. Without this,
  // the body's push out (down and forward under a thigh) and the seat's push up walked the caught cloth forward every
  // substep, and a skirt sat on piled up into a wad in front of the seat
  const gPushed = new Uint8Array(n);
  function setGround(field: GroundField | null, floor = -Infinity, boxes: ArrayLike<number> | null = null, boxCount = 0, ceiling = Infinity): void {
    if (field !== gField) gFresh = true;
    gField = field; gFloor = floor; gCeil = ceiling;
    gBoxN = boxes ? boxCount : 0;
    if (gBoxes.length < gBoxN * BOX) gBoxes = new Float64Array(gBoxN * BOX);
    for (let k = 0; k < gBoxN * BOX; k++) gBoxes[k] = boxes![k];
    gOn = !!field || floor > -Infinity || gBoxN > 0;
    if (!gOn) gPushed.fill(0);
  }
  // the surface cloth at (px, pz) rests on: the highest one under the ceiling (or under `below`, when given lower)
  function surfaceAt(px: number, pz: number, below = Infinity): number {
    let s = gFloor;
    const top = Math.min(gCeil, below);
    const f = gField;
    if (f) {
      const i = Math.floor((px - f.x0) / f.cell), j = Math.floor((pz - f.z0) / f.cell);
      if (i >= 0 && j >= 0 && i < f.nx && j < f.nz) {
        const b = (j * f.nx + i) * f.layers;
        for (let l = 0; l < f.layers; l++) { const h = f.h[b + l]; if (h <= top) { if (h > s) s = h; break; } }   // highest first
      }
    }
    for (let q = 0; q < gBoxN; q++) {
      const c = q * BOX, t = gBoxes[c + 6];
      if (t > top || t <= s) continue;
      const dx = px - gBoxes[c], dz = pz - gBoxes[c + 1];
      if (Math.abs(dx * gBoxes[c + 2] + dz * gBoxes[c + 3]) <= gBoxes[c + 4] && Math.abs(-dx * gBoxes[c + 3] + dz * gBoxes[c + 2]) <= gBoxes[c + 5]) s = t;
    }
    return s;
  }
  function solveGround(): void {
    const m = o.groundMargin, mu = o.groundFriction;
    gPushed.fill(0);
    for (let i = 0; i < n; i++) {
      if (!w[i]) continue;
      const k = i * 3, px = x[k], py = x[k + 1], pz = x[k + 2];
      const s = surfaceAt(px, pz) + m;
      if (py >= s) continue;
      const up = s - py;
      // came in through a side: a substep ago it was clear of what was under it, at a height under this surface
      const qx = xp[k], qy = xp[k + 1], qz = xp[k + 2];
      if (qy < s && qy >= surfaceAt(qx, qz) + m && (qx !== px || qz !== pz)) {
        // where along the way back it leaves this surface: halve the step 7 times
        let lo = 0, hi = 1;
        {
          for (let it = 0; it < 7; it++) {
            const t = (lo + hi) / 2;
            if (surfaceAt(px + (qx - px) * t, pz + (qz - pz) * t) + m <= py) hi = t; else lo = t;
          }
          const side = Math.hypot(qx - px, qz - pz) * hi;
          if (side < up) { x[k] = px + (qx - px) * hi; x[k + 2] = pz + (qz - pz) * hi; continue; }
        }
      }
      x[k + 1] = s;
      gPushed[i] = 1;
      // friction against the still surface: the slide over it in this substep
      const sx = x[k] - qx, sz = x[k + 2] - qz, sl = Math.hypot(sx, sz);
      if (sl <= mu * up) { x[k] = qx; x[k + 2] = qz; } else if (sl > 0) { const r = (mu * up) / sl; x[k] -= sx * r; x[k + 2] -= sz * r; }
    }
  }

  const wind: number[] = [0, 0, 0];
  const stats = { asleep: false, ground: 0, watch: { accel: 0, speed: 0, drift: 0, tilt: 0, air: 0 }, ms: 0, substepMs: 0, strain: 0, depth: 0, speed: 0, rebuilds: 0, through: 0, pairs: 0, over: 0, dev: 0, devMax: 0, flare: 1, worst: null as { rest: number; y: number; w: number[] } | null };

  function solve(C: Uint32Array, L: Float64Array, alpha: number): void {
    for (let q = 0; q < L.length; q++) {
      const i = C[q * 2], j = C[q * 2 + 1], wi = w[i], wj = w[j], ws = wi + wj;
      if (!ws) continue;
      const ki = i * 3, kj = j * 3, dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2];
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (l < 1e-9) continue;
      const lam = (l - L[q]) / ((ws + alpha) * l);
      x[ki] += dx * lam * wi; x[ki + 1] += dy * lam * wi; x[ki + 2] += dz * lam * wi;
      x[kj] -= dx * lam * wj; x[kj + 1] -= dy * lam * wj; x[kj + 2] -= dz * lam * wj;
    }
  }

  const hinges = (C: Uint32Array, T: Float64Array, alpha: number, alphas: Float64Array | null = null, scale = 0, im: ArrayLike<number> | null = null) => solveHinges(x, w, C, T, alpha, alphas, scale, im);

  // ---- cloth against cloth: point pairs from a hash grid, refreshed a few times a frame ----
  const TS = 2 * n + 1, cellStart = new Int32Array(TS + 1), cellItem = new Int32Array(n), cellOf = new Int32Array(n);
  let pairs = new Int32Array(1 << 16), pairMin = new Float32Array(1 << 15), nPairs = 0;
  // the forward half of the 27 neighbouring cells: each pair of cells is visited once
  const HALF: number[] = [];
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) if (a > 0 || (a === 0 && (b > 0 || (b === 0 && c > 0)))) HALF.push(a, b, c);
  const xr = new Float64Array(n * 3);   // where the points were when the pairs were last found
  let pairsValid = false, rebuildsThisFrame = 0;
  function pairsStale() {
    if (!pairsValid) return true;
    if (rebuildsThisFrame >= o.maxRebuilds) return false;
    // measured in the body's frame: a spin or a jump carries the whole skirt along without changing who is near whom
    const lim = (o.pairSlack / 2) ** 2;
    const m = ref.inv;
    for (let k = 0; k < n * 3; k += 3) {
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      const dx = m[0] * px + m[1] * py + m[2] * pz + m[3] - xr[k], dy = m[4] * px + m[5] * py + m[6] * pz + m[7] - xr[k + 1], dz = m[8] * px + m[9] * py + m[10] * pz + m[11] - xr[k + 2];
      if (dx * dx + dy * dy + dz * dz > lim) return true;
    }
    return false;
  }
  function findPairs() {
    const m = ref.inv;
    for (let k = 0; k < n * 3; k += 3) {
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      xr[k] = m[0] * px + m[1] * py + m[2] * pz + m[3]; xr[k + 1] = m[4] * px + m[5] * py + m[6] * pz + m[7]; xr[k + 2] = m[8] * px + m[9] * py + m[10] * pz + m[11];
    }
    pairsValid = true; stats.rebuilds++; rebuildsThisFrame++;
    const r = o.thickness + o.pairSlack, inv = 1 / r, r2 = r * r;
    cellStart.fill(0);
    for (let i = 0; i < n; i++) {
      const h = (Math.imul(Math.floor(x[i * 3] * inv), 92837111) ^ Math.imul(Math.floor(x[i * 3 + 1] * inv), 689287499) ^ Math.imul(Math.floor(x[i * 3 + 2] * inv), 283923481)) >>> 0;
      cellOf[i] = h % TS; cellStart[cellOf[i]]++;
    }
    let acc = 0;
    for (let c = 0; c < TS; c++) { acc += cellStart[c]; cellStart[c] = acc; }
    cellStart[TS] = acc;
    for (let i = 0; i < n; i++) cellItem[--cellStart[cellOf[i]]] = i;
    nPairs = 0;
    const add = (i: number, j: number) => {
      const ki = i * 3, kj = j * 3;
      const dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2];
      if (dx * dx + dy * dy + dz * dz >= r2 || !(w[i] + w[j])) return;
      const rx = X0[kj] - X0[ki], ry = X0[kj + 1] - X0[ki + 1], rz = X0[kj + 2] - X0[ki + 2];
      if (nPairs * 2 >= pairs.length) {
        const p2 = new Int32Array(pairs.length * 2); p2.set(pairs); pairs = p2;
        const m2 = new Float32Array(pairMin.length * 2); m2.set(pairMin); pairMin = m2;
      }
      pairs[nPairs * 2] = i; pairs[nPairs * 2 + 1] = j;
      pairMin[nPairs++] = Math.min(o.thickness, 0.8 * Math.sqrt(rx * rx + ry * ry + rz * rz));
    };
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(x[i * 3] * inv), cy = Math.floor(x[i * 3 + 1] * inv), cz = Math.floor(x[i * 3 + 2] * inv);
      const own = cellOf[i];
      for (let e = cellStart[own], end = cellStart[own + 1]; e < end; e++) { const j = cellItem[e]; if (j > i) add(i, j); }
      for (let q = 0; q < HALF.length; q += 3) {
        const h = ((Math.imul(cx + HALF[q], 92837111) ^ Math.imul(cy + HALF[q + 1], 689287499) ^ Math.imul(cz + HALF[q + 2], 283923481)) >>> 0) % TS;
        if (h === own) continue;   // two cells in one bucket: already covered above
        for (let e = cellStart[h], end = cellStart[h + 1]; e < end; e++) add(i, cellItem[e]);
      }
    }
  }
  function solveSelf() {
    const fr = o.selfFriction;
    for (let q = 0; q < nPairs; q++) {
      const i = pairs[q * 2], j = pairs[q * 2 + 1], ki = i * 3, kj = j * 3, m = pairMin[q];
      const dx = x[kj] - x[ki], dy = x[kj + 1] - x[ki + 1], dz = x[kj + 2] - x[ki + 2], d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= m * m || d2 < 1e-18) continue;
      const wi = w[i], wj = w[j], ws = wi + wj;
      if (!ws) continue;
      const d = Math.sqrt(d2), c = (m - d) / (d * ws);
      x[ki] -= dx * c * wi; x[ki + 1] -= dy * c * wi; x[ki + 2] -= dz * c * wi;
      x[kj] += dx * c * wj; x[kj + 1] += dy * c * wj; x[kj + 2] += dz * c * wj;
      // touching layers drag each other: move both part of the way to their shared travel this substep
      for (let a = 0; a < 3; a++) {
        const vi = x[ki + a] - xp[ki + a], vj = x[kj + a] - xp[kj + a], av = (vi * wj + vj * wi) / ws;
        x[ki + a] += (av - vi) * fr * (wi ? 1 : 0); x[kj + a] += (av - vj) * fr * (wj ? 1 : 0);
      }
    }
  }

  // ---- which pieces of the body each point is tested against: chosen every CAND_EVERY substeps, not all of them every
  // substep (2026-11-15: 1,097 points x 6 pieces x 16 substeps = 105,000 lookups a frame, most of them for a piece nowhere
  // near the point). A piece is kept for a point if the point, in the piece's own space now or CAND_EVERY substeps ahead,
  // is inside the piece's grid grown by how far a point can travel in that time (its speed is limited) plus a little.
  // Outside its grid a piece reports "far", so leaving it out changes nothing: the cloth's motion is the same to the bit
  // (checked on a breakdance and a walk, scratch/animevrm-cloth/fingerprint.mjs in 360toAvator).
  const CAND_EVERY = 4, NC = Math.max(1, cols.length);
  const candN = new Uint8Array(n), cand = new Uint8Array(n * NC), aheadM = I12(), aheadInv = cols.map(() => I12());
  function findCands(s: number, ns: number, h: number): void {
    const reach = grab ? Infinity : o.maxSpeed * CAND_EVERY * h + 0.015, a2 = Math.min(1, (s + CAND_EVERY) / ns);
    for (let q = 0; q < cols.length; q++) { cols[q].motion.at(a2, aheadM); inv12(aheadM, aheadInv[q]); }
    for (let i = 0; i < n; i++) {
      let cn = 0;
      if (w[i]) {
        const k = i * 3, px = x[k], py = x[k + 1], pz = x[k + 2], base = i * NC;
        for (let q = 0; q < cols.length; q++) {
          const b = cols[q].sdf.box, m = cols[q].inv, m2 = aheadInv[q];
          const ax = m[0] * px + m[1] * py + m[2] * pz + m[3], bx = m2[0] * px + m2[1] * py + m2[2] * pz + m2[3];
          if ((ax < bx ? ax : bx) > b[3] + reach || (ax > bx ? ax : bx) < b[0] - reach) continue;
          const ay = m[4] * px + m[5] * py + m[6] * pz + m[7], by = m2[4] * px + m2[5] * py + m2[6] * pz + m2[7];
          if ((ay < by ? ay : by) > b[4] + reach || (ay > by ? ay : by) < b[1] - reach) continue;
          const az = m[8] * px + m[9] * py + m[10] * pz + m[11], bz = m2[8] * px + m2[9] * py + m2[10] * pz + m2[11];
          if ((az < bz ? az : bz) > b[5] + reach || (az > bz ? az : bz) < b[2] - reach) continue;
          cand[base + cn++] = q;
        }
      }
      candN[i] = cn;
    }
  }

  // ---- sleep ----
  // A few points on the cloth's own scale, in the rest pose, to tell how the hips move (a change of speed or of turn).
  const half = Math.max(0.05, (topY - botY) / 2);
  const refPts = Float64Array.of(pivot[0], topY, pivot[1], pivot[0], botY, pivot[1], pivot[0] + half, midY, pivot[1], pivot[0], midY, pivot[1] + half);
  const refPos = new Float64Array(12), refVel = new Float64Array(12);
  // per piece of the body: the middle of its grid and three of its corners, in its own space
  const colPts = new Float64Array(cols.length * 12);
  cols.forEach((col, q) => {
    const b = col.sdf.box, cx = (b[0] + b[3]) / 2, cy = (b[1] + b[4]) / 2, cz = (b[2] + b[5]) / 2;
    colPts.set([cx, cy, cz, b[3], cy, cz, cx, b[4], cz, cx, cy, b[5]], q * 12);
  });
  const colRel = new Float64Array(cols.length * 12), colSlept = new Float64Array(cols.length * 12);
  const pinRel = new Float64Array(pinned.length * 3), pinSlept = new Float64Array(pinned.length * 3);
  const xSlept = new Float64Array(n * 3), vRigid = new Float64Array(n * 3), upSlept = [0, 1, 0], wInv = I12();
  let asleep = false, quietT = 0, watched = 0, fitting = false, shapeSeen = o.shapeScale;   // watched: frames seen since a reset (speeds need 2, changes of speed 3)
  // everything that moves the cloth from outside, this frame: is it quiet, and has it moved away from where the cloth fell asleep?
  function watch(dt: number): { quiet: boolean; moved: boolean } {
    const M = ref.M, idt = 1 / dt;
    inv12(M, wInv);
    const m = wInv;
    let acc = 0, speed = 0, drift = 0, carry = 0;
    for (let k = 0; k < 12; k += 3) {
      const px = refPts[k], py = refPts[k + 1], pz = refPts[k + 2];
      const wx = M[0] * px + M[1] * py + M[2] * pz + M[3], wy = M[4] * px + M[5] * py + M[6] * pz + M[7], wz = M[8] * px + M[9] * py + M[10] * pz + M[11];
      const vx = (wx - refPos[k]) * idt, vy = (wy - refPos[k + 1]) * idt, vz = (wz - refPos[k + 2]) * idt;
      if (watched >= 2) acc = Math.max(acc, Math.hypot(vx - refVel[k], vy - refVel[k + 1], vz - refVel[k + 2]) * idt);
      if (watched >= 1) carry = Math.max(carry, Math.hypot(vx - wind[0], vy - wind[1], vz - wind[2]));
      refPos[k] = wx; refPos[k + 1] = wy; refPos[k + 2] = wz; refVel[k] = vx; refVel[k + 1] = vy; refVel[k + 2] = vz;
    }
    // a point given in the world, against the hips: its speed since the frame before, and how far it is from where it was asleep
    const against = (wx: number, wy: number, wz: number, rel: Float64Array, slept: Float64Array, k: number) => {
      const lx = m[0] * wx + m[1] * wy + m[2] * wz + m[3], ly = m[4] * wx + m[5] * wy + m[6] * wz + m[7], lz = m[8] * wx + m[9] * wy + m[10] * wz + m[11];
      if (watched >= 1) speed = Math.max(speed, Math.hypot(lx - rel[k], ly - rel[k + 1], lz - rel[k + 2]) * idt);
      if (asleep) drift = Math.max(drift, Math.hypot(lx - slept[k], ly - slept[k + 1], lz - slept[k + 2]));
      rel[k] = lx; rel[k + 1] = ly; rel[k + 2] = lz;
    };
    for (let q = 0; q < cols.length; q++) {
      const C = cols[q].M;
      for (let k = q * 12, e = k + 12; k < e; k += 3) {
        const px = colPts[k], py = colPts[k + 1], pz = colPts[k + 2];
        against(C[0] * px + C[1] * py + C[2] * pz + C[3], C[4] * px + C[5] * py + C[6] * pz + C[7], C[8] * px + C[9] * py + C[10] * pz + C[11], colRel, colSlept, k);
      }
    }
    for (let p = 0; p < pinned.length; p++) { const k = pinned[p] * 3; against(pinTarget[k], pinTarget[k + 1], pinTarget[k + 2], pinRel, pinSlept, p * 3); }
    // a hand near the cloth keeps it awake while it moves against the hips (a hand that just rests there does not)
    if (capsTouch) for (let q = 0; q < capN; q++) for (let e = 0; e < 2; e++) { const c = q * CAP + e * 3; against(capCur[c], capCur[c + 1], capCur[c + 2], capRel, capSlept, q * 6 + e * 3); }
    watched++;
    // which way is up for the hips: asleep, the cloth hangs as it did when it fell asleep
    const ux = m[1], uy = m[5], uz = m[9], ul = Math.hypot(ux, uy, uz) || 1;
    const tilt = asleep ? Math.acos(Math.max(-1, Math.min(1, (ux * upSlept[0] + uy * upSlept[1] + uz * upSlept[2]) / ul))) : 0;
    if (!asleep) { upSlept[0] = ux / ul; upSlept[1] = uy / ul; upSlept[2] = uz / ul; }
    const calmAir = !wind[0] && !wind[1] && !wind[2], shapeSteady = Math.abs(o.shapeScale - shapeSeen) < 1e-3;
    shapeSeen = o.shapeScale;
    stats.watch = { accel: acc, speed, drift, tilt, air: carry };   // for tuning: what keeps the cloth awake
    return { quiet: calmAir && carry < o.quietAir && shapeSteady && !grab && acc < o.quietAccel && speed < o.quietSpeed, moved: drift > o.wakeDist || tilt > o.wakeAngle };
  }
  function fallAsleep(): void {
    asleep = true;
    const m = wInv;   // the hips' inverse of this frame (from watch)
    for (let k = 0; k < n * 3; k += 3) {
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      xSlept[k] = m[0] * px + m[1] * py + m[2] * pz + m[3]; xSlept[k + 1] = m[4] * px + m[5] * py + m[6] * pz + m[7]; xSlept[k + 2] = m[8] * px + m[9] * py + m[10] * pz + m[11];
    }
    colSlept.set(colRel); pinSlept.set(pinRel); capSlept.set(capRel);
  }
  function wake(): void { asleep = false; }
  // asleep: every point where the hips carry it, at the speed they carry it
  function stepAsleep(dt: number): void {
    const M = ref.M, idt = 1 / dt;
    for (let k = 0; k < n * 3; k += 3) {
      const px = xSlept[k], py = xSlept[k + 1], pz = xSlept[k + 2];
      const wx = M[0] * px + M[1] * py + M[2] * pz + M[3], wy = M[4] * px + M[5] * py + M[6] * pz + M[7], wz = M[8] * px + M[9] * py + M[10] * pz + M[11];
      v[k] = (wx - x[k]) * idt; v[k + 1] = (wy - x[k + 1]) * idt; v[k + 2] = (wz - x[k + 2]) * idt;
      x[k] = wx; x[k + 1] = wy; x[k + 2] = wz;
    }
    for (const i of pinned) { const k = i * 3; x[k] = pinTarget[k]; x[k + 1] = pinTarget[k + 1]; x[k + 2] = pinTarget[k + 2]; }
    xp.set(x);
  }
  // how fast the hips carry each point this frame (what the cloth is calmed toward, and measured against)
  function rigidSpeeds(dt: number): void {
    const M = ref.M, P = ref.prev, m = wInv, idt = 1 / dt;
    for (let k = 0; k < n * 3; k += 3) {
      const px = x[k], py = x[k + 1], pz = x[k + 2];
      const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      vRigid[k] = ((M[0] - P[0]) * lx + (M[1] - P[1]) * ly + (M[2] - P[2]) * lz + M[3] - P[3]) * idt;
      vRigid[k + 1] = ((M[4] - P[4]) * lx + (M[5] - P[5]) * ly + (M[6] - P[6]) * lz + M[7] - P[7]) * idt;
      vRigid[k + 2] = ((M[8] - P[8]) * lx + (M[9] - P[9]) * ly + (M[10] - P[10]) * lz + M[11] - P[11]) * idt;
    }
  }

  const bendWeights = new Float64Array(n);
  function step(dt: number): void {
    const t0 = performance.now();
    const ns = o.substeps, h = dt / ns, aS = o.stretch / (h * h), aL = o.shape / (h * h), aC = o.crease / (h * h);
    const vmax = o.maxSpeed;
    rebuildsThisFrame = 0;
    if (!driven) followBody();
    if (capFresh) { capPrev.set(capCur); capFresh = false; }
    findCapCands(dt);
    let calmK = 0;
    if (o.sleep && !fitting) {
      const { quiet, moved } = watch(dt);
      if (asleep) {
        if (quiet && !moved) { stepAsleep(dt); endFrame(t0); return; }
        wake();
        quietT = quiet ? o.calmAfter : 0;   // only drifted away (a slow shift of the weight): calm down again from here
      } else quietT = quiet ? quietT + dt : 0;
      if (quietT > o.calmAfter) {
        calmK = o.calmDamping * Math.min(1, (quietT - o.calmAfter) / Math.max(1e-3, o.sleepAfter - o.calmAfter));
        rigidSpeeds(dt);
      }
    } else if (asleep) wake();
    // a new ground (moved to another place, or the set came in): settle on it
    if (gFresh) { if (asleep) wake(); quietT = 0; gFresh = false; }
    computeAero(dt);
    ref.motion.set(ref.prev, ref.M);
    for (const col of cols) col.motion.set(col.prev, col.M);
    const damp = Math.max(0, 1 - o.damping * h), air = Math.min(0.9, o.air * h), calm = Math.max(0, 1 - calmK * h);
    for (let i = 0; i < n; i++) bendWeights[i] = w[i] * invMass[i];
    const gFrom = grab ? grab.prev.slice() : null;
    for (let s = 0; s < ns; s++) {
      const a = (s + 1) / ns;
      ref.motion.at(a, ref.cur); inv12(ref.cur, ref.inv);
      for (const col of cols) { col.last.set(s === 0 ? col.prev : col.cur); col.motion.at(a, col.cur); inv12(col.cur, col.inv); }
      if (cols.length && s % CAND_EVERY === 0) findCands(s, ns, h);
      // predict
      for (let i = 0; i < n; i++) {
        const k = i * 3;
        xp[k] = x[k]; xp[k + 1] = x[k + 1]; xp[k + 2] = x[k + 2];
        if (!w[i]) continue;
        const rel = ((v[k] - wind[0]) * nrm[k] + (v[k + 1] - wind[1]) * nrm[k + 1] + (v[k + 2] - wind[2]) * nrm[k + 2]) * air;
        v[k] += aero[k] * h - rel * nrm[k]; v[k + 1] += (o.gravity + aero[k + 1]) * h - rel * nrm[k + 1]; v[k + 2] += aero[k + 2] * h - rel * nrm[k + 2];
        const sp = Math.sqrt(v[k] * v[k] + v[k + 1] * v[k + 1] + v[k + 2] * v[k + 2]);
        if (sp > vmax) { const r = vmax / sp; v[k] *= r; v[k + 1] *= r; v[k + 2] *= r; }
        x[k] += v[k] * h; x[k + 1] += v[k + 1] * h; x[k + 2] += v[k + 2] * h;
      }
      // pinned waist follows the body
      for (const i of pinned) {
        const k = i * 3;
        x[k] = pinPrev[k] + (pinTarget[k] - pinPrev[k]) * a; x[k + 1] = pinPrev[k + 1] + (pinTarget[k + 1] - pinPrev[k + 1]) * a; x[k + 2] = pinPrev[k + 2] + (pinTarget[k + 2] - pinPrev[k + 2]) * a;
      }
      // fingers
      if (grab && gFrom) {
        let tx = gFrom[0] + (grab.target[0] - gFrom[0]) * a, ty = gFrom[1] + (grab.target[1] - gFrom[1]) * a, tz = gFrom[2] + (grab.target[2] - gFrom[2]) * a;
        // the cloth cannot be pulled further from the waist than it is long
        const c = grab.centre, p = tPin[c] * 3, ci = grab.ids.indexOf(c) * 3;
        let dx = tx + grab.off[ci] - x[p], dy = ty + grab.off[ci + 1] - x[p + 1], dz = tz + grab.off[ci + 2] - x[p + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > tLen[c]) { const r = tLen[c] / d - 1; tx += dx * r; ty += dy * r; tz += dz * r; }
        for (let q = 0; q < grab.ids.length; q++) {
          const k = grab.ids[q] * 3;
          x[k] = tx + grab.off[q * 3]; x[k + 1] = ty + grab.off[q * 3 + 1]; x[k + 2] = tz + grab.off[q * 3 + 2];
        }
        if (s === ns - 1) grab.prev = [tx, ty, tz];
      }
      if (LL.length && o.shapeScale > 0.01 && s % o.shapeEvery === 0) solve(CL, LL, aL / (o.shapeEvery * o.shapeEvery) / Math.min(1, o.shapeScale));
      solveHinges(x, bendWeights, CB, TB, 0, AB, 1 / (h * h));
      hinges(CD, TH, aC); solve(CS, LS, aS);   // stretch last: it has the final say
      if (o.thickness > 0) {
        if (s % o.selfEvery === 0) { if (pairsStale()) findPairs(); solveSelf(); }
      }
      // hands, then the body (it has the last word)
      if (capsTouch) { capsAt(s / ns, capB); capsAt(a, capA); solveCapsules(); }
      if (gOn) solveGround();
      // tether and body
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const k = i * 3, p = tPin[i] * 3;
        let dx = x[k] - x[p], dy = x[k + 1] - x[p + 1], dz = x[k + 2] - x[p + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > tLen[i]) { const r = tLen[i] / d; x[k] = x[p] + dx * r; x[k + 1] = x[p + 1] + dy * r; x[k + 2] = x[p + 2] + dz * r; }
        for (let e = 0, cn = candN[i], base = i * NC; e < cn; e++) {
          const q = cand[base + e], col = cols[q], m = col.inv, px = x[k], py = x[k + 1], pz = x[k + 2];
          // into the piece's own space
          const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
          const margin = col.margin[i];
          const sd = col.sdf.sample(lx, ly, lz, g, margin);
          if (sd >= margin) continue;
          const c = col.cur;
          let gx = c[0] * g[0] + c[1] * g[1] + c[2] * g[2], gy = c[4] * g[0] + c[5] * g[1] + c[6] * g[2], gz = c[8] * g[0] + c[9] * g[1] + c[10] * g[2];
          const gl = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
          gx /= gl; gy /= gl; gz /= gl;
          const push = col.margin[i] - sd;
          x[k] += gx * push; x[k + 1] += gy * push; x[k + 2] += gz * push;
          if (gPushed[i] && gy < -0.2) { x[k] = xp[k]; x[k + 2] = xp[k + 2]; continue; }   // caught between the body and the ground
          // friction: lose part of the slide along the surface, measured against where the piece carried this spot from
          const l = col.last;
          const bx = l[0] * lx + l[1] * ly + l[2] * lz + l[3], by = l[4] * lx + l[5] * ly + l[6] * lz + l[7], bz = l[8] * lx + l[9] * ly + l[10] * lz + l[11];
          const sx = (x[k] - xp[k]) - (px - bx), sy = (x[k + 1] - xp[k + 1]) - (py - by), sz = (x[k + 2] - xp[k + 2]) - (pz - bz);
          const sn = sx * gx + sy * gy + sz * gz, fr = o.friction;
          x[k] -= (sx - sn * gx) * fr; x[k + 1] -= (sy - sn * gy) * fr; x[k + 2] -= (sz - sn * gz) * fr;
        }
      }
      // velocities
      const ih = 1 / h;
      for (let i = 0; i < n * 3; i++) v[i] = (x[i] - xp[i]) * ih * damp;
      // calming down: the speed against what the hips carry dies out
      if (calmK > 0) for (let i = 0; i < n * 3; i++) v[i] = vRigid[i] + (v[i] - vRigid[i]) * calm;
    }
    if (calmK > 0) {
      let fastest = 0;
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const k = i * 3;
        fastest = Math.max(fastest, Math.hypot(v[k] - vRigid[k], v[k + 1] - vRigid[k + 1], v[k + 2] - vRigid[k + 2]));
      }
      if (fastest < o.sleepSpeed || quietT >= o.sleepAfter) fallAsleep();
    }
    endFrame(t0);
  }
  function endFrame(t0: number): void {
    ref.prev.set(ref.M);
    for (const col of cols) col.prev.set(col.M);
    for (const i of pinned) { const k = i * 3; pinPrev[k] = pinTarget[k]; pinPrev[k + 1] = pinTarget[k + 1]; pinPrev[k + 2] = pinTarget[k + 2]; }
    capPrev.set(capCur);
    normals();
    const elapsed = performance.now() - t0;
    stats.ms += (elapsed - stats.ms) * 0.1;
    if (!asleep) {
      const cost = elapsed / o.substeps;
      stats.substepMs += (cost - stats.substepMs) * 0.1;
    }
    stats.asleep = asleep;
  }

  // numbers for tuning: worst edge stretch, deepest point inside the body (beyond what it had at rest), fastest point
  function measure() {
    let strain = 0, depth = 0, speed = 0, over = 0, worst = -1;
    for (let q = 0; q < LS.length; q++) {
      const i = CS[q * 2] * 3, j = CS[q * 2 + 1] * 3;
      const e = Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]) / LS[q] - 1;
      if (e > strain) { strain = e; worst = q; }
      if (e > 0.05) over++;
    }
    let touch = 0;
    if (o.thickness > 0) {
      inv12(ref.M, ref.inv); findPairs(); stats.rebuilds--;
      for (let q = 0; q < nPairs; q++) {
        const i = pairs[q * 2] * 3, j = pairs[q * 2 + 1] * 3;
        if (Math.hypot(x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]) < 0.6 * pairMin[q]) touch++;
      }
    }
    stats.through = touch;   // point pairs closer than 60% of their allowed distance
    stats.pairs = nPairs;
    stats.over = over / LS.length;   // share of edges stretched more than 5%
    stats.worst = worst < 0 ? null : { rest: LS[worst], y: X0[CS[worst * 2] * 3 + 1], w: [w[CS[worst * 2]], w[CS[worst * 2 + 1]]] };
    for (const col of cols) {
      inv12(col.M, col.inv);
      const m = col.inv;
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        const px = x[i * 3], py = x[i * 3 + 1], pz = x[i * 3 + 2];
        depth = Math.max(depth, col.margin[i] - col.sdf.sample(m[0] * px + m[1] * py + m[2] * pz + m[3], m[4] * px + m[5] * py + m[6] * pz + m[7], m[8] * px + m[9] * py + m[10] * pz + m[11]));
      }
    }
    for (let k = 0; k < n * 3; k += 3) speed = Math.max(speed, Math.hypot(v[k], v[k + 1], v[k + 2]));
    // against the rest shape, in the body's frame
    let dev = 0, devMax = 0, r0 = 0, r1 = 0, nh = 0;
    inv12(ref.M, ref.inv);
    const m = ref.inv;
    for (let i = 0; i < n; i++) {
      const k = i * 3, px = x[k], py = x[k + 1], pz = x[k + 2];
      const lx = m[0] * px + m[1] * py + m[2] * pz + m[3], ly = m[4] * px + m[5] * py + m[6] * pz + m[7], lz = m[8] * px + m[9] * py + m[10] * pz + m[11];
      const d = Math.hypot(lx - X0[k], ly - X0[k + 1], lz - X0[k + 2]);
      dev += d; devMax = Math.max(devMax, d);
      if (X0[k + 1] < hemY) { r0 += Math.hypot(X0[k] - pivot[0], X0[k + 2] - pivot[1]); r1 += Math.hypot(lx - pivot[0], lz - pivot[1]); nh++; }
    }
    stats.dev = dev / n; stats.devMax = devMax; stats.flare = r1 / r0;   // flare: hem radius against the rest shape's
    // deepest point under the ground it rests on (m)
    let under = 0;
    if (gOn) for (let i = 0; i < n; i++) if (w[i]) { const k = i * 3; under = Math.max(under, surfaceAt(x[k], x[k + 2]) - x[k + 1]); }
    stats.ground = under;
    stats.strain = strain; stats.depth = depth; stats.speed = speed;
    return stats;
  }

  // The model's shape is how the skirt already hangs under gravity. Simulated from it, the cloth sags further (a long
  // skirt's hem narrowed to 87% of the model's). So the shape the soft constraints (long distances, bend, creases)
  // remember is moved the other way: let the cloth settle in the pose it was given in, measure how far each point
  // sagged, shift the remembered shape by that much against the sag, repeat. Edge lengths are left alone (cloth does
  // not stretch). Call once after creation, with the frames still at the given pose.
  function fitRestToGravity(iterations = 2, frames = 60, gain = 0.9): void {
    const target = new Float64Array(X0), wasDriven = driven;
    const dist = (i: number, j: number) => Math.hypot(target[i * 3] - target[j * 3], target[i * 3 + 1] - target[j * 3 + 1], target[i * 3 + 2] - target[j * 3 + 2]);
    driven = true; fitting = true;
    const calm = () => { pairsValid = false; x.set(X0); xp.set(X0); v.fill(0); snapFrames(); normals(); };
    for (let it = 0; it < iterations; it++) {
      calm();
      for (let f = 0; f < frames; f++) step(1 / 60);
      for (let i = 0; i < n; i++) {
        if (!w[i]) continue;
        for (let c = 0; c < 3; c++) target[i * 3 + c] -= (x[i * 3 + c] - X0[i * 3 + c]) * gain;
      }
      for (let k = 0; k < LL.length; k++) LL[k] = dist(CL[k * 2], CL[k * 2 + 1]);
      for (let k = 0; k < TB.length; k++) TB[k] = foldAngle(target, CB[k * 4], CB[k * 4 + 1], CB[k * 4 + 2], CB[k * 4 + 3]);
      for (let k = 0; k < TH.length; k++) TH[k] = foldAngle(target, CD[k * 4], CD[k * 4 + 1], CD[k * 4 + 2], CD[k * 4 + 3]);
    }
    calm();
    driven = wasDriven; fitting = false;
  }

  // back to the rest shape; a driver passes where the points are in the pose of the moment instead (`positions`)
  function reset(positions: ArrayLike<number> | null = null): void {
    pairsValid = false; asleep = false; quietT = 0; watched = 0; stats.asleep = false;
    endGrab(); v.fill(0); capFresh = true;
    if (positions) x.set(positions);
    else {
      x.set(X0);
      for (const b of [body, bodyPrev]) { b.x = b.y = b.z = b.yaw = 0; }
      followBody();
    }
    xp.set(x);
    snapFrames();
    normals();
  }

  // write the points and normals to the render vertices
  function write(posAttr: { array: ArrayLike<number> & { [i: number]: number }; needsUpdate: boolean }, nrmAttr: { array: ArrayLike<number> & { [i: number]: number }; needsUpdate: boolean }): void {
    const P = posAttr.array, N = nrmAttr.array;
    for (let i = 0; i < nR; i++) {
      const k = map[i] * 3;
      P[i * 3] = x[k]; P[i * 3 + 1] = x[k + 1]; P[i * 3 + 2] = x[k + 2];
      N[i * 3] = nrm[k]; N[i * 3 + 1] = nrm[k + 1]; N[i * 3 + 2] = nrm[k + 2];
    }
    posAttr.needsUpdate = true; nrmAttr.needsUpdate = true;
  }

  return { o, n, nF, F, x, v, w, X0, nrm, map, body, bodyPrev, frames, snapFrames, fitRestToGravity, tPin,
    get sleeping() { return asleep; },
    get driven() { return driven; }, set driven(d) { driven = d; }, restGap, wind, stats, step, measure, reset, write, startGrab, moveGrab, endGrab, setCapsules, setGround, surfaceAt, pinned, rimLow, pinY, topY, botY, hemY,
    solveHinges: hinges, CD, TH, mass, fabric,
    knock,
    get grabbing() { return !!grab; },
    get grabPoint() { return grab ? grab.prev : null; },   // where the fingers are
    // how far the pinched cloth has been raised above where it hangs at rest
    get grabLift() { return grab ? x[grab.centre * 3 + 1] - body.y - X0[grab.centre * 3 + 1] : 0; }, counts: { points: n, stretch: LS.length, bend: TB.length, crease: TH.length, shape: LL.length, pinned: pinned.length } };
}
