/**
 * 三角形メッシュ（体の部品）の符号付き距離の格子。布の点を体の外へ押し出すのに使う。
 */
// A signed distance grid of a triangle mesh (the legs and hips), for pushing cloth points out of the body.
// Distances are exact inside a band around the surface and clamped to the band beyond it. The sign comes from the
// nearest triangle's normal next to the surface and from a flood fill from the grid's corner everywhere else, so one
// badly oriented triangle cannot turn the inside of a thigh into "outside".

// weld by position and return { pos: Float64Array, faces: Uint32Array }
export interface WeldedMesh {
  pos: Float64Array;
  faces: Uint32Array;
}

/** 3成分を書き込む先。勾配を受け取る */
export type Vec3Out = { [index: number]: number };

export interface DistanceGrid {
  /** (x, y, z) の符号付き距離。out を渡すと勾配（単位ベクトル）を書く。格子の外は 1 */
  sample(x: number, y: number, z: number, out?: Vec3Out): number;
  dims: [number, number, number];
  band: number;
  /** the grid's box in the mesh's own space: [min x, y, z, max x, y, z] (outside it `sample` returns far) */
  box: [number, number, number, number, number, number];
}

export function weld(position: ArrayLike<number>, index: ArrayLike<number>): WeldedMesh & { map: Uint32Array } {
  const ids = new Map<string, number>(), map = new Uint32Array(position.length / 3), pos: number[] = [];
  for (let i = 0; i < map.length; i++) {
    const k = `${Math.round(position[i * 3] * 1e5)},${Math.round(position[i * 3 + 1] * 1e5)},${Math.round(position[i * 3 + 2] * 1e5)}`;
    let id = ids.get(k);
    if (id === undefined) { id = pos.length / 3; ids.set(k, id); pos.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]); }
    map[i] = id;
  }
  const faces: number[] = [];
  for (let f = 0; f < index.length; f += 3) {
    const a = map[index[f]], b = map[index[f + 1]], c = map[index[f + 2]];
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  return { pos: new Float64Array(pos), faces: new Uint32Array(faces), map };
}

// close every open rim whose centre is above `minY` with a fan to that centre (hips are open at the top under a
// waistband; a body cut off at the neck or the waist is open there)
export function capRims(mesh: WeldedMesh, minY = -Infinity): WeldedMesh {
  const { pos, faces } = mesh;
  const dir = new Set<string>();
  for (let f = 0; f < faces.length; f += 3) for (let k = 0; k < 3; k++) dir.add(faces[f + k] + '>' + faces[f + (k + 1) % 3]);
  const rim: number[] = [], par = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (par.get(r) !== r) r = par.get(r)!;
    par.set(a, r);
    return r;
  };
  for (let f = 0; f < faces.length; f += 3) for (let k = 0; k < 3; k++) {
    const a = faces[f + k], b = faces[f + (k + 1) % 3];
    if (dir.has(b + '>' + a)) continue;
    rim.push(a, b);
    if (!par.has(a)) par.set(a, a);
    if (!par.has(b)) par.set(b, b);
    par.set(find(a), find(b));
  }
  const loops = new Map<number, { edges: number[]; sum: number[]; n: number }>();
  for (let e = 0; e < rim.length; e += 2) {
    const r = find(rim[e]);
    let l = loops.get(r);
    if (!l) loops.set(r, l = { edges: [], sum: [0, 0, 0], n: 0 });
    l.edges.push(rim[e], rim[e + 1]);
    for (let c = 0; c < 3; c++) l.sum[c] += pos[rim[e] * 3 + c];
    l.n++;
  }
  const extraPos: number[] = [], extraFaces: number[] = [];
  let next = pos.length / 3;
  for (const l of loops.values()) {
    if (l.n < 3 || l.sum[1] / l.n <= minY) continue;
    extraPos.push(l.sum[0] / l.n, l.sum[1] / l.n, l.sum[2] / l.n);
    for (let e = 0; e < l.edges.length; e += 2) extraFaces.push(l.edges[e + 1], l.edges[e], next);
    next++;
  }
  if (!extraFaces.length) return mesh;
  const pos2 = new Float64Array(pos.length + extraPos.length); pos2.set(pos); pos2.set(extraPos, pos.length);
  const faces2 = new Uint32Array(faces.length + extraFaces.length); faces2.set(faces); faces2.set(extraFaces, faces.length);
  return { pos: pos2, faces: faces2 };
}

export function buildSDF(mesh: WeldedMesh, { min, max, cell = 0.006, band = 0.04 }: { min: number[]; max: number[]; cell?: number; band?: number }): DistanceGrid {
  const { pos, faces } = mesh;
  const nx = Math.ceil((max[0] - min[0]) / cell) + 1, ny = Math.ceil((max[1] - min[1]) / cell) + 1, nz = Math.ceil((max[2] - min[2]) / cell) + 1;
  const N = nx * ny * nz;
  const d2 = new Float32Array(N).fill(band * band), sign = new Int8Array(N).fill(1);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ax = pos[a], ay = pos[a + 1], az = pos[a + 2];
    const abx = pos[b] - ax, aby = pos[b + 1] - ay, abz = pos[b + 2] - az;
    const acx = pos[c] - ax, acy = pos[c + 1] - ay, acz = pos[c + 2] - az;
    const nX = aby * acz - abz * acy, nY = abz * acx - abx * acz, nZ = abx * acy - aby * acx;
    const lo = (v0: number, v1: number, v2: number, m: number) => Math.max(0, Math.floor((Math.min(v0, v1, v2) - band - m) / cell));
    const hi = (v0: number, v1: number, v2: number, m: number, n: number) => Math.min(n - 1, Math.ceil((Math.max(v0, v1, v2) + band - m) / cell));
    const i0 = lo(ax, pos[b], pos[c], min[0]), i1 = hi(ax, pos[b], pos[c], min[0], nx);
    const j0 = lo(ay, pos[b + 1], pos[c + 1], min[1]), j1 = hi(ay, pos[b + 1], pos[c + 1], min[1], ny);
    const k0 = lo(az, pos[b + 2], pos[c + 2], min[2]), k1 = hi(az, pos[b + 2], pos[c + 2], min[2], nz);
    const d00 = abx * abx + aby * aby + abz * abz, d01 = abx * acx + aby * acy + abz * acz, d11 = acx * acx + acy * acy + acz * acz;
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const px = min[0] + i * cell - ax, py = min[1] + j * cell - ay, pz = min[2] + k * cell - az;
      // closest point on the triangle, as (v, w) along ab and ac (Ericson, Real-Time Collision Detection 5.1.5)
      const e1 = abx * px + aby * py + abz * pz, e2 = acx * px + acy * py + acz * pz;
      let v: number, w: number;
      if (e1 <= 0 && e2 <= 0) { v = 0; w = 0; } else {
        const e3 = e1 - d00, e4 = e2 - d01;
        if (e3 >= 0 && e4 <= e3) { v = 1; w = 0; } else {
          const vc = e1 * e4 - e3 * e2;
          if (vc <= 0 && e1 >= 0 && e3 <= 0) { v = e1 / (e1 - e3); w = 0; } else {
            const e5 = e1 - d01, e6 = e2 - d11;
            if (e6 >= 0 && e5 <= e6) { v = 0; w = 1; } else {
              const vb = e5 * e2 - e1 * e6;
              if (vb <= 0 && e2 >= 0 && e6 <= 0) { v = 0; w = e2 / (e2 - e6); } else {
                const va = e3 * e6 - e5 * e4;
                if (va <= 0 && e4 - e3 >= 0 && e5 - e6 >= 0) { w = (e4 - e3) / (e4 - e3 + e5 - e6); v = 1 - w; } else {
                  const den = 1 / (va + vb + vc); v = vb * den; w = vc * den;
                }
              }
            }
          }
        }
      }
      const qx = px - abx * v - acx * w, qy = py - aby * v - acy * w, qz = pz - abz * v - acz * w;
      const dd = qx * qx + qy * qy + qz * qz, id = i + nx * (j + ny * k);
      if (dd < d2[id]) { d2[id] = dd; sign[id] = qx * nX + qy * nY + qz * nZ >= 0 ? 1 : -1; }
    }
  }
  // flood the outside from a corner through cells that are clear of the surface
  const clear = (cell * 1.01) ** 2, seen = new Uint8Array(N), stack = [0];
  seen[0] = 1;
  while (stack.length) {
    const id = stack.pop()!, i = id % nx, j = ((id / nx) | 0) % ny, k = (id / (nx * ny)) | 0;
    const go = (n: number) => { if (!seen[n] && d2[n] > clear) { seen[n] = 1; stack.push(n); } };
    if (i > 0) go(id - 1); if (i < nx - 1) go(id + 1);
    if (j > 0) go(id - nx); if (j < ny - 1) go(id + nx);
    if (k > 0) go(id - nx * ny); if (k < nz - 1) go(id + nx * ny);
  }
  const d = new Float32Array(N);
  for (let id = 0; id < N; id++) {
    const s = d2[id] > clear ? (seen[id] ? 1 : -1) : sign[id];
    d[id] = s * Math.sqrt(d2[id]);
  }
  const inv = 1 / cell, FAR = 1;
  // trilinear sample; `out` (optional) receives the gradient
  function sample(x: number, y: number, z: number, out?: Vec3Out): number {
    const fx = (x - min[0]) * inv, fy = (y - min[1]) * inv, fz = (z - min[2]) * inv;
    if (fx < 0 || fy < 0 || fz < 0 || fx >= nx - 1 || fy >= ny - 1 || fz >= nz - 1) return FAR;
    const i = fx | 0, j = fy | 0, k = fz | 0, tx = fx - i, ty = fy - j, tz = fz - k;
    const o = i + nx * (j + ny * k), sy = nx, sz = nx * ny;
    const c000 = d[o], c100 = d[o + 1], c010 = d[o + sy], c110 = d[o + sy + 1];
    const c001 = d[o + sz], c101 = d[o + sz + 1], c011 = d[o + sz + sy], c111 = d[o + sz + sy + 1];
    const x00 = c000 + (c100 - c000) * tx, x10 = c010 + (c110 - c010) * tx, x01 = c001 + (c101 - c001) * tx, x11 = c011 + (c111 - c011) * tx;
    const y0 = x00 + (x10 - x00) * ty, y1 = x01 + (x11 - x01) * ty;
    if (out) {
      const gx = ((c100 - c000) * (1 - ty) + (c110 - c010) * ty) * (1 - tz) + ((c101 - c001) * (1 - ty) + (c111 - c011) * ty) * tz;
      const gy = (x10 - x00) * (1 - tz) + (x11 - x01) * tz, gz = y1 - y0;
      const l = Math.sqrt(gx * gx + gy * gy + gz * gz) || 1;
      out[0] = gx / l; out[1] = gy / l; out[2] = gz / l;
    }
    return y0 + (y1 - y0) * tz;
  }
  return { sample, dims: [nx, ny, nz], band, box: [min[0], min[1], min[2], min[0] + (nx - 1) * cell, min[1] + (ny - 1) * cell, min[2] + (nz - 1) * cell] };
}
