import * as THREE from 'three';
import type { GroundField } from './solver';

/**
 * 布の下の、動かない物（床・椅子・ベッドなど）を真上から測って、高さの地図（solver の GroundField）を作る。
 *
 * 中心のまわり size 四方を cell ごとに区切り、上を向いた三角形を地図に描き込む（マスの中心の真上・真下にある三角形の
 * 高さを、上から順に layers 枚まで覚える）。真上から光線を飛ばして当たる面と同じものになるが、光線は 1 本ごとに
 * メッシュの三角形をすべて調べるので、部屋 1 つ（11,000 本）に 5〜6 秒かかった。描き込みは 10ms 前後。
 * 机の天板とその下の床のように、上に物がある所も表せる（布は腰より低い面にだけ乗る：solver の setGround）。
 *
 * 数えるのは、描かれているメッシュの、上から見える面だけ（片面の材質は表が上を向いた三角形、裏面の材質は裏が上を
 * 向いた三角形、両面の材質はすべて）。透明で奥行きを書かない材質（影だけを受ける板など）は除く。絵の透明な所（葉の板の
 * 抜き）も面として数える。
 */
export interface GroundFieldOptions {
  /** 地図の中心（ワールドの x と z） */
  centre: { x: number; z: number };
  /** これより上の物は測らない（ワールドの y、m） */
  top: number;
  /** これより下の物は測らない（ワールドの y、m） */
  bottom: number;
  /** 一辺の長さ（m、既定 1.6） */
  size?: number;
  /** 1 マスの大きさ（m、既定 0.015） */
  cell?: number;
  /** 1 マスに覚える面の数（既定 8。多いときは高いほうから） */
  layers?: number;
  /** 同じ物とみなす高さの差（m、既定 0.01）。これより近い面は上の 1 枚にまとめる */
  merge?: number;
  /** 測る物から外すもの（キャラなど）。true を返すと、その物と子は測らない */
  exclude?: (object: THREE.Object3D) => boolean;
}

const _box = new THREE.Box3(), _m = new THREE.Matrix4(), _mi = new THREE.Matrix4();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

/** objects（とその子）のメッシュを真上から測る。何もなければ、すべてのマスが -Infinity の地図を返す */
export function groundField(objects: Iterable<THREE.Object3D>, options: GroundFieldOptions): GroundField {
  const { centre, top, bottom, size = 1.6, cell = 0.015, layers = 8, merge = 0.01, exclude } = options;
  const nx = Math.max(1, Math.ceil(size / cell)), nz = nx;
  const x0 = centre.x - (nx * cell) / 2, z0 = centre.z - (nz * cell) / 2, x1 = x0 + nx * cell, z1 = z0 + nz * cell;
  const h = new Float32Array(nx * nz * layers).fill(-Infinity);
  const region = new THREE.Box3(new THREE.Vector3(x0, bottom, z0), new THREE.Vector3(x1, top, z1));

  // マス b に高さ y を入れる（高い順に並べ、近い面はまとめる）
  const insert = (b: number, y: number): void => {
    for (let l = 0; l < layers; l++) {
      const cur = h[b + l];
      if (Math.abs(cur - y) < merge) { if (y > cur) h[b + l] = y; return; }
      if (y > cur) {
        for (let k = layers - 1; k > l; k--) h[b + k] = h[b + k - 1];
        h[b + l] = y;
        return;
      }
    }
  };
  // ワールド座標の三角形を描き込む。sideSign：1 = 上を向いた面だけ、-1 = 下を向いた面だけ、0 = 両方
  const triangle = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, sideSign: number): void => {
    if (Math.max(a.y, b.y, c.y) < bottom || Math.min(a.y, b.y, c.y) > top) return;
    // xz に投影した面積（符号つき）。真上から見て反時計回りなら上を向いている
    const ux = b.x - a.x, uz = b.z - a.z, vx = c.x - a.x, vz = c.z - a.z;
    const det = vz * ux - vx * uz;   // = (b-a) x (c-a) の y 成分の符号を反転したもの（右手系で上向きなら負）
    if (Math.abs(det) < 1e-12) return;   // 垂直な面
    if (sideSign !== 0 && Math.sign(-det) !== sideSign) return;
    const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell - 0.5) + 0), i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x, c.x) - x0) / cell - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell - 0.5)), j1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z, c.z) - z0) / cell - 0.5));
    const inv = 1 / det;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cell;
        // 重心座標（xz）
        const wx = px - a.x, wz = pz - a.z;
        const s = (wx * vz - vx * wz) * inv, t = (ux * wz - wx * uz) * inv;
        if (s < -1e-9 || t < -1e-9 || s + t > 1 + 1e-9) continue;
        const y = a.y + (b.y - a.y) * s + (c.y - a.y) * t;
        if (y < bottom || y > top) continue;
        insert((j * nx + i) * layers, y);
      }
    }
  };

  const draw = (mesh: THREE.Mesh, world: THREE.Matrix4): void => {
    const g = mesh.geometry, P = g.attributes.position as THREE.BufferAttribute | undefined;
    if (!P) return;
    const index = g.index;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: index ? index.count : P.count, materialIndex: 0 }];
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    // 鏡に映した行列（大きさが負）では三角形の向きが裏返る
    const flip = world.determinant() < 0 ? -1 : 1;
    for (const group of groups) {
      const m = mats[group.materialIndex ?? 0] ?? mats[0];
      if (!m || !m.visible || (m.transparent && !m.depthWrite) || (m as THREE.ShadowMaterial).isShadowMaterial) continue;
      const sideSign = m.side === THREE.DoubleSide ? 0 : (m.side === THREE.BackSide ? -1 : 1) * flip;
      const end = Math.min(group.start + group.count, index ? index.count : P.count);
      for (let k = group.start; k + 2 < end; k += 3) {
        const ia = index ? index.getX(k) : k, ib = index ? index.getX(k + 1) : k + 1, ic = index ? index.getX(k + 2) : k + 2;
        _a.fromBufferAttribute(P, ia).applyMatrix4(world);
        _b.fromBufferAttribute(P, ib).applyMatrix4(world);
        _c.fromBufferAttribute(P, ic).applyMatrix4(world);
        triangle(_a, _b, _c, sideSign);
      }
    }
  };

  const visit = (object: THREE.Object3D): void => {
    if (!object.visible || exclude?.(object)) return;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh && !(object as THREE.SkinnedMesh).isSkinnedMesh && mesh.geometry?.attributes.position) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const instanced = (object as THREE.InstancedMesh).isInstancedMesh ? (object as THREE.InstancedMesh) : null;
      if (instanced) {
        for (let q = 0; q < instanced.count; q++) {
          instanced.getMatrixAt(q, _mi);
          _m.multiplyMatrices(instanced.matrixWorld, _mi);
          _box.copy(mesh.geometry.boundingBox!).applyMatrix4(_m);
          if (_box.intersectsBox(region)) draw(mesh, _m.clone());
        }
      } else {
        _box.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
        if (_box.intersectsBox(region)) draw(mesh, mesh.matrixWorld);
      }
    }
    for (const child of object.children) visit(child);
  };
  for (const object of objects) { object.updateMatrixWorld(true); visit(object); }
  return { x0, z0, cell, nx, nz, layers, h };
}
