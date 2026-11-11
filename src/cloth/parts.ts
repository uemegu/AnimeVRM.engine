import * as THREE from 'three';
import { weld } from './sdf';

/**
 * モデルを部品（材質ごとのメッシュ）に分けて、スカートと、その下の体を見分ける。
 *
 * VRoid は1つのメッシュの頂点を体・スカート・上着が共有し、部品ごとにその一部だけを使う。ここで部品ごとに
 * 自分の頂点だけを取り出し、今の姿勢（ボーン変形後）のワールド座標に直す。
 */

/** 開いた縁（穴のふち）。n は頂点数、y は高さの平均、r は縁の中心からの距離の平均 */
export interface OpenRim {
  n: number;
  y: number;
  r: number;
}

export interface ModelPart {
  mesh: THREE.SkinnedMesh;
  name: string;
  materialName: string;
  /** 今の姿勢のワールド座標。position・normal・uv と、リグの skinIndex・skinWeight、変形前の bindPosition を持つ */
  geometry: THREE.BufferGeometry;
  box: THREE.Box3;
  /** 大きい順 */
  rims: OpenRim[];
  /** 頂点ごとに、揺れもの（スプリングボーン）の骨に付いている重みの割合。揺れものがなければ null */
  free: Float32Array | null;
}

function openRims(position: ArrayLike<number>, index: ArrayLike<number>): OpenRim[] {
  const { pos, faces } = weld(position, index);
  const count = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * 1e7 + b : b * 1e7 + a);
  for (let f = 0; f < faces.length; f += 3) for (let k = 0; k < 3; k++) {
    const q = key(faces[f + k], faces[f + (k + 1) % 3]);
    count.set(q, (count.get(q) ?? 0) + 1);
  }
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const [q, c] of count) {
    if (c !== 1) continue;
    const a = Math.floor(q / 1e7), b = q % 1e7;
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map<number, number[]>();
  for (const v of parent.keys()) {
    const r = find(v);
    const list = groups.get(r);
    if (list) list.push(v); else groups.set(r, [v]);
  }
  const rims: OpenRim[] = [];
  for (const ids of groups.values()) {
    let cx = 0, cy = 0, cz = 0;
    for (const v of ids) { cx += pos[v * 3]; cy += pos[v * 3 + 1]; cz += pos[v * 3 + 2]; }
    cx /= ids.length; cy /= ids.length; cz /= ids.length;
    let r = 0;
    for (const v of ids) r += Math.hypot(pos[v * 3] - cx, pos[v * 3 + 2] - cz);
    rims.push({ n: ids.length, y: cy, r: r / ids.length });
  }
  return rims.sort((a, b) => b.n - a.n);
}

/** root の下の、リグの付いたメッシュを部品にする。freeBones は揺れものの骨 */
export function describeParts(root: THREE.Object3D, freeBones: Set<THREE.Object3D>): ModelPart[] {
  root.updateMatrixWorld(true);
  const parts: ModelPart[] = [];
  const v = new THREE.Vector3();
  root.traverse((object) => {
    const o = object as THREE.SkinnedMesh;
    if (!o.isSkinnedMesh || !o.geometry.index) return;
    const g = o.geometry.clone();
    g.morphAttributes = {};
    g.setAttribute('bindPosition', g.attributes.position.clone());
    // 今の骨の姿勢へ
    o.skeleton.update();
    const P = g.attributes.position;
    let moved = 0;
    for (let i = 0; i < P.count; i++) {
      o.getVertexPosition(i, v);
      moved = Math.max(moved, Math.abs(v.x - P.getX(i)), Math.abs(v.y - P.getY(i)), Math.abs(v.z - P.getZ(i)));
      P.setXYZ(i, v.x, v.y, v.z);
    }
    if (moved > 1e-4) g.computeVertexNormals();
    let free: Float32Array | null = null;
    if (freeBones.size) {
      const J = g.attributes.skinIndex, W = g.attributes.skinWeight, isFree = o.skeleton.bones.map((b) => freeBones.has(b));
      free = new Float32Array(P.count);
      for (let i = 0; i < P.count; i++) {
        let f = 0, t = 0;
        for (let k = 0; k < 4; k++) { const wt = W.getComponent(i, k); t += wt; if (isFree[J.getComponent(i, k)]) f += wt; }
        free[i] = t ? f / t : 0;
      }
    }
    // 共有している頂点バッファから、この部品が使う頂点だけを取り出す
    const idx = g.index!.array, nV = P.count, remap = new Int32Array(nV).fill(-1), keep: number[] = [];
    for (let i = 0; i < idx.length; i++) if (remap[idx[i]] < 0) { remap[idx[i]] = keep.length; keep.push(idx[i]); }
    if (keep.length < nV) {
      for (const [name, attribute] of Object.entries(g.attributes)) {
        const a = attribute as THREE.BufferAttribute;
        const out = new (a.array.constructor as new (n: number) => THREE.TypedArray)(keep.length * a.itemSize);
        for (let i = 0; i < keep.length; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.array[keep[i] * a.itemSize + k];
        g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize, a.normalized));
      }
      g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx, (i) => remap[i]), 1));
      if (free) { const all = free; free = Float32Array.from(keep, (i) => all[i]); }
    }
    g.applyMatrix4(o.matrixWorld);
    g.computeBoundingBox();
    const materialName = (Array.isArray(o.material) ? o.material[0] : o.material)?.name || '';
    parts.push({
      mesh: o, name: o.name || materialName, materialName, free, geometry: g, box: g.boundingBox!,
      rims: openRims(g.attributes.position.array, g.index!.array),
    });
  });
  return parts;
}

/** 部品の裾：下 1/3 にある開いた縁のうち、いちばん大きいもの（ワンピースは襟ぐりや袖口の縁のほうが大きいことがある） */
export function hemOf(part: ModelPart): OpenRim | null {
  const h = part.box.max.y - part.box.min.y;
  return part.rims.find((rim) => rim.n >= 12 && rim.y <= part.box.min.y + h / 3) ?? null;
}

/**
 * スカートらしい部品。下 1/3 に開いた縁（裾）があり、細い帯（ベルト）ではないもののうち、裾がいちばん広いもの。
 * ワンピースも入る
 */
export function pickSkirt(parts: ModelPart[]): ModelPart | null {
  const all = new THREE.Box3();
  for (const p of parts) all.union(p.box);
  const H = all.max.y - all.min.y;
  let best: ModelPart | null = null, bestRadius = 0;
  for (const p of parts) {
    const hem = hemOf(p), h = p.box.max.y - p.box.min.y;
    if (!hem || h < 0.15 * H) continue;
    if (hem.r > bestRadius) { best = p; bestRadius = hem.r; }
  }
  return best;
}

/** スカートが触れる体：裾より下まで伸び、スカートの高さと重なる部品（靴は下すぎ、上着は裾より下へ届かない） */
export function pickColliders(parts: ModelPart[], skirt: ModelPart): ModelPart[] {
  const hem = skirt.box.min.y, len = skirt.box.max.y - hem;
  return parts.filter((p) => p !== skirt && p.box.min.y < hem - 0.05 * len && p.box.max.y > hem + 0.2 * len);
}
