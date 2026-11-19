import * as THREE from 'three';
import { describePart } from './parts';
import { weld, capRims, buildSDF } from './sdf';
import { subdivide, createCloth, type Cloth, type ClothCollider, type ClothOptions } from './solver';
import type { FabricSpec } from './fabric';
import type { ClothWind } from './SkinnedCloth';
import { ClothPose, clothSubsteps, MAX_CLOTH_FRAME } from './timing';

/**
 * 骨のないメッシュ（ふつうの Mesh）を布にする。部品に分かれているだけで骨のないモデル（3D 生成のモデルなど）の
 * スカートを、上端で吊って垂らす。
 *
 * - 布にするメッシュのジオメトリを、細かく分割したものに差し替え、頂点を毎フレーム書き換える。材質には触らない。
 * - 留める点（既定は上端）は、follow の物体に乗って動く。モデル全体を動かす・回すと、布が遅れて付いてくる。
 * - 当たる体のメッシュは、それぞれ形の変わらない固い物として、自分の動き（matrixWorld）に付いていく。
 * - 大きさの単位は metresPerUnit で渡す。中の計算はメートルで行う（布の厚みや目の細かさをメートルで決めているため）。
 *
 * 使い方：モデルが基準の姿勢のときに create。毎フレーム、モデルを動かした後に update。
 * 部品に分かれたモデルから自動で選ぶのは mesh.ts の createMeshSkirt。
 */

export interface MeshClothOptions {
  /** 布にするメッシュ。ジオメトリを差し替える（setEnabled(false)・dispose で戻る） */
  mesh: THREE.Mesh;
  /** 布が当たる体のメッシュ。それぞれ固い物として、自分の動きに付いていく。省くと当たり判定なし */
  colliders?: THREE.Mesh[];
  /** 留める点が乗る物体（省くと mesh の親、なければ mesh）。この物体を動かす・回すと、布の留めた縁が付いていく */
  follow?: THREE.Object3D;
  /**
   * どこを留めるか。省くと上端（上の開いた縁と、上端から pinBelowTop の範囲。solver の設定）。
   * 配列なら頂点ごと（mesh.geometry の頂点順、0.5 以上で留める）。関数なら、基準の姿勢のワールド座標と頂点番号から決める
   */
  held?: ArrayLike<number> | ((position: THREE.Vector3, vertex: number) => boolean);
  /** モデルの 1 ユニットが何メートルか（既定 1） */
  metresPerUnit?: number;
  /** 三角形を4分割する回数。'auto' は辺が edge くらいになる回数 */
  sub?: number | 'auto';
  /** 目の細かさ（m）。布になる部分の辺がこのくらいになるまで分割する（既定 1.5cm） */
  edge?: number;
  maxTriangles?: number;
  /** 重力で垂れる分の補正の回数（既定 2、0 で補正なし） */
  restFit?: number;
  /** 体の距離の格子の目（m） */
  cell?: number;
  /** ソルバーの設定（solver.ts の ClothOptions） */
  solver?: Partial<ClothOptions>;
  /** 生地（fabric.ts の名前か、曲げ剛性 N·m と重さ kg/m²）。曲げにくさと重さが決まる。既定はスーツ地 */
  fabric?: FabricSpec;
}

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** 基準の姿勢からの動き（今の行列 × 基準の逆行列）を、ソルバーの 3x4 にする。並進はメートルへ */
function frameOf(now: THREE.Matrix4, restInverse: THREE.Matrix4, scale: number, out: Float64Array): void {
  const e = _m4.multiplyMatrices(now, restInverse).elements;
  out[0] = e[0]; out[1] = e[4]; out[2] = e[8]; out[3] = e[12] * scale;
  out[4] = e[1]; out[5] = e[5]; out[6] = e[9]; out[7] = e[13] * scale;
  out[8] = e[2]; out[9] = e[6]; out[10] = e[10]; out[11] = e[14] * scale;
}

export class MeshCloth {
  /** ソルバー。摘む（startGrab / moveGrab / endGrab）・計測（measure）はここから。座標はメートル */
  public readonly cloth: Cloth;
  public readonly info: { mesh: string; splits: number; cloth: number; held: number; colliders: { name: string; triangles: number; grid: [number, number, number] }[]; metresPerUnit: number };
  private enabled = true;
  private time = 0;
  private readonly posed: Float64Array;
  private readonly followRestInverse = new THREE.Matrix4();
  private readonly colliderRestInverse: THREE.Matrix4[];
  private readonly meshInverse = new THREE.Matrix4();
  private readonly clothPose = new ClothPose();
  private readonly followPoint: THREE.Vector3;

  private constructor(
    private readonly mesh: THREE.Mesh,
    private readonly original: THREE.BufferGeometry,
    private readonly geometry: THREE.BufferGeometry,
    cloth: Cloth,
    private readonly follow: THREE.Object3D,
    private readonly colliderMeshes: THREE.Mesh[],
    private readonly scale: number,
    info: MeshCloth['info'],
  ) {
    this.cloth = cloth;
    this.info = info;
    this.posed = new Float64Array(cloth.n * 3);
    this.followRestInverse.copy(follow.matrixWorld).invert();
    this.followPoint = new THREE.Vector3().fromArray(cloth.X0).divideScalar(scale).applyMatrix4(this.followRestInverse);
    this.colliderRestInverse = colliderMeshes.map((m) => new THREE.Matrix4().copy(m.matrixWorld).invert());
    mesh.geometry = geometry;
    mesh.frustumCulled = false;
    this.settle();
  }

  /** create の options に指定がない項目の既定値（調整・検証用） */
  static defaults: Partial<MeshClothOptions> = {};

  /** 直前の create が null を返した理由（調べる用） */
  static skipped = '';

  /** モデルが基準の姿勢のときに呼ぶ。布になる頂点がなければ null */
  static create(given: MeshClothOptions): MeshCloth | null {
    const options: MeshClothOptions = { ...MeshCloth.defaults, ...given, solver: { ...MeshCloth.defaults.solver, ...given.solver } };
    MeshCloth.skipped = '';
    const skip = (reason: string): null => { MeshCloth.skipped = reason; return null; };
    const { mesh, metresPerUnit: S = 1, sub = 'auto', edge = 0.015, maxTriangles = 20000, cell = 0.006, restFit = 2, solver = {}, fabric = 'suiting' } = options;
    if (!mesh.geometry.index) return skip('メッシュに index がない');
    const follow = options.follow ?? mesh.parent ?? mesh;
    let root: THREE.Object3D = mesh;
    while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    for (const c of options.colliders ?? []) c.updateWorldMatrix(true, false);
    follow.updateWorldMatrix(true, false);

    // ---- 布のメッシュ：基準の姿勢のワールド座標（メートル） ----
    const part = describePart(mesh, new Set());
    const g0 = part.geometry;
    const count = g0.attributes.position.count;
    const uv0 = g0.attributes.uv ? g0.attributes.uv.array : new Float32Array(count * 2);
    // どこを留めるかの指定があれば、頂点ごとの「布の度合い」にする（部品は自分の頂点だけに詰めてあるので、番号の対応を取る）
    let free: Float32Array | null = null;
    if (options.held) {
      const idx = mesh.geometry.index.array, used = new Int32Array(mesh.geometry.attributes.position.count).fill(-1);
      let next = 0;
      for (let i = 0; i < idx.length; i++) if (used[idx[i]] < 0) used[idx[i]] = next++;
      free = new Float32Array(count).fill(1);
      const P = g0.attributes.position;
      for (let v = 0; v < used.length; v++) {
        const i = used[v];
        if (i < 0) continue;
        const held = typeof options.held === 'function' ? options.held(_v.fromBufferAttribute(P, i), v) : (options.held[v] ?? 0) >= 0.5;
        if (held) free[i] = 0;
      }
      if (!free.some((f) => f >= 0.5)) return skip('布になる頂点がない（全部を留める指定になっている）');
    }
    let sp: { position: Float32Array; uv: Float32Array; index: Uint32Array; extra: Float32Array | null } = {
      position: Float32Array.from(g0.attributes.position.array, (x) => x * S), uv: Float32Array.from(uv0), index: Uint32Array.from(g0.index!.array), extra: free,
    };
    let topY = -Infinity, hemY = Infinity;
    for (let i = 1; i < sp.position.length; i += 3) { topY = Math.max(topY, sp.position[i]); hemY = Math.min(hemY, sp.position[i]); }
    const len = topY - hemY;

    const lengths: number[] = [];
    for (let f = 0; f < sp.index.length; f += 3) {
      if (sp.extra && (!sp.extra[sp.index[f]] || !sp.extra[sp.index[f + 1]])) continue;
      const a = sp.index[f] * 3, b = sp.index[f + 1] * 3;
      lengths.push(Math.hypot(sp.position[a] - sp.position[b], sp.position[a + 1] - sp.position[b + 1], sp.position[a + 2] - sp.position[b + 2]));
    }
    lengths.sort((a, b) => a - b);
    let splits = 0;
    if (sub === 'auto') {
      splits = lengths.length ? Math.max(0, Math.min(3, Math.round(Math.log2(lengths[lengths.length >> 1] / edge)))) : 0;
      while (splits > 0 && (sp.index.length / 3) * 4 ** splits > maxTriangles) splits--;
    } else splits = sub;
    for (let s = 0; s < splits; s++) {
      const next = subdivide(sp.position, sp.uv, sp.index, sp.extra);
      sp = { position: next.position, uv: next.uv, index: next.index, extra: next.extra };
    }
    const nR = sp.position.length / 3;

    // ---- 当たる体：メッシュごとに、基準の姿勢のワールド座標（メートル）で距離の格子を作る ----
    const colliders: ClothCollider[] = [], colliderMeshes: THREE.Mesh[] = [];
    const colliderInfo: MeshCloth['info']['colliders'] = [];
    const lo = hemY - 0.9 * len - 0.05, hi = topY + 0.08;
    for (const body of options.colliders ?? []) {
      if (body === mesh || !body.geometry.index) continue;
      const bp = describePart(body, new Set());
      const P = bp.geometry.attributes.position.array, I = bp.geometry.index!.array;
      const pos: number[] = [], idx: number[] = [], id = new Map<number, number>();
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let f = 0; f < I.length; f += 3) {
        const ya = P[I[f] * 3 + 1] * S, yb = P[I[f + 1] * 3 + 1] * S, yc = P[I[f + 2] * 3 + 1] * S;
        if (Math.max(ya, yb, yc) < lo || Math.min(ya, yb, yc) > hi) continue;   // 布が届かない高さ
        for (let k = 0; k < 3; k++) {
          const t = I[f + k];
          let i = id.get(t);
          if (i === undefined) {
            i = pos.length / 3; id.set(t, i);
            for (let c = 0; c < 3; c++) { const x = P[t * 3 + c] * S; pos.push(x); min[c] = Math.min(min[c], x); max[c] = Math.max(max[c], x); }
          }
          idx.push(i);
        }
      }
      if (idx.length < 90) continue;
      const pad = 0.05;
      const sdf = buildSDF(capRims(weld(pos, idx)), { min: min.map((m) => m - pad), max: max.map((m) => m + pad), cell, band: 0.04 });
      colliders.push({ sdf });
      colliderMeshes.push(body);
      colliderInfo.push({ name: bp.name, triangles: idx.length / 3, grid: sdf.dims });
    }

    // 上端の中心（「外向き」と裾の広がりの計測に使う）
    let px = 0, pz = 0, pn = 0;
    for (let i = 0; i < sp.position.length; i += 3) if (sp.position[i + 1] > topY - 0.066 * len) { px += sp.position[i]; pz += sp.position[i + 2]; pn++; }

    const cloth = createCloth({ position: sp.position, index: sp.index, colliders, pivot: [px / pn, pz / pn], free: sp.extra, opts: solver, fabric });
    cloth.driven = true;
    if (cloth.n === cloth.pinned.length) return skip('布になる点がない');
    if (restFit > 0) cloth.fitRestToGravity(restFit);

    // ---- 同じメッシュに持たせる新しいジオメトリ（頂点はメッシュのローカル座標で書く） ----
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('uv', new THREE.BufferAttribute(sp.uv, 2));
    geometry.setIndex(new THREE.BufferAttribute(sp.index, 1));
    if (Array.isArray(mesh.material)) for (let m = 0; m < mesh.material.length; m++) geometry.addGroup(0, sp.index.length, m);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

    return new MeshCloth(mesh, mesh.geometry, geometry, cloth, follow, colliderMeshes, S, {
      mesh: part.name, splits, cloth: cloth.n - cloth.pinned.length, held: cloth.pinned.length, colliders: colliderInfo, metresPerUnit: S,
    });
  }

  /** 物体の今の位置・向きを、ソルバーの枠（全体・体のメッシュ・留める点の行き先）へ渡す */
  private readFrames(): void {
    this.follow.updateWorldMatrix(true, false);
    const frames = this.cloth.frames, m = frames.ref.M, X0 = this.cloth.X0;
    frameOf(this.follow.matrixWorld, this.followRestInverse, this.scale, m);
    for (let q = 0; q < this.colliderMeshes.length; q++) {
      this.colliderMeshes[q].updateWorldMatrix(true, false);
      frameOf(this.colliderMeshes[q].matrixWorld, this.colliderRestInverse[q], this.scale, frames.colliders[q].M);
    }
    for (const i of this.cloth.pinned) {
      const k = i * 3, x = X0[k], y = X0[k + 1], z = X0[k + 2];
      frames.pinTarget[k] = m[0] * x + m[1] * y + m[2] * z + m[3];
      frames.pinTarget[k + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
      frames.pinTarget[k + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
  }

  /** 布の位置と法線を、メッシュのローカル座標へ書く */
  private write(): void {
    this.mesh.updateWorldMatrix(true, false);
    const w = this.mesh.matrixWorld.elements, e = this.meshInverse.copy(this.mesh.matrixWorld).invert().elements, s = 1 / this.scale;
    const { x, nrm, map } = this.cloth;
    const position = this.geometry.attributes.position as THREE.BufferAttribute, normal = this.geometry.attributes.normal as THREE.BufferAttribute;
    const P = position.array, N = normal.array;
    for (let r = 0; r < map.length; r++) {
      const k = map[r] * 3, wx = x[k] * s, wy = x[k + 1] * s, wz = x[k + 2] * s, nx = nrm[k], ny = nrm[k + 1], nz = nrm[k + 2];
      P[r * 3] = e[0] * wx + e[4] * wy + e[8] * wz + e[12]; P[r * 3 + 1] = e[1] * wx + e[5] * wy + e[9] * wz + e[13]; P[r * 3 + 2] = e[2] * wx + e[6] * wy + e[10] * wz + e[14];
      // 法線はワールド→ローカル：行列の転置を掛ける（描画時の法線行列で元に戻る）
      N[r * 3] = w[0] * nx + w[1] * ny + w[2] * nz; N[r * 3 + 1] = w[4] * nx + w[5] * ny + w[6] * nz; N[r * 3 + 2] = w[8] * nx + w[9] * ny + w[10] * nz;
    }
    position.needsUpdate = true; normal.needsUpdate = true;
  }

  /** 布全体を、基準の形のまま今の位置・向きへ置き直して、そこから始める */
  /** 外から動かすものがなく、布が止まって計算を休んでいるか（solver の sleep。cloth.o.sleep = false で止めない） */
  get sleeping(): boolean { return this.cloth.sleeping; }

  settle(): void {
    if (!this.enabled) return;
    this.readFrames();
    this.clothPose.advance(this.follow.matrixWorld, this.scale, this.followPoint);
    this.resetToPose();
  }

  private resetToPose(): void {
    const m = this.cloth.frames.ref.M, X0 = this.cloth.X0;
    for (let k = 0; k < X0.length; k += 3) {
      const x = X0[k], y = X0[k + 1], z = X0[k + 2];
      this.posed[k] = m[0] * x + m[1] * y + m[2] * z + m[3]; this.posed[k + 1] = m[4] * x + m[5] * y + m[6] * z + m[7]; this.posed[k + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
    }
    this.cloth.reset(this.posed);
    this.write();
  }

  /** 1フレーム進める。モデルを動かした後に呼ぶ。wind は null で無風（速度は m/s） */
  update(delta: number, wind?: ClothWind | null): void {
    if (!this.enabled || !(delta > 0)) return;
    this.time += delta;
    for (let o: THREE.Object3D | null = this.mesh; o; o = o.parent) if (!o.visible) { this.clothPose.invalidate(); return; }
    this.readFrames();
    const jumped = this.clothPose.advance(this.follow.matrixWorld, this.scale, this.followPoint);
    if (jumped || delta > MAX_CLOTH_FRAME) {
      this.resetToPose();
      return;
    }
    const w = this.cloth.wind;
    w[0] = w[1] = w[2] = 0;
    if (wind) {
      const t = this.time, gust = wind.gust ?? 0.6;
      const swell = 0.5 * Math.sin(t * 1.1) + 0.3 * Math.sin(t * 2.3 + 1.7) + 0.2 * Math.sin(t * 0.47 + 4.1);
      _v.set(wind.velocity.x, wind.velocity.y, wind.velocity.z);
      if (_v.lengthSq() > 0) {
        _v.applyAxisAngle(_up, 0.25 * gust * Math.sin(t * 0.31 + 0.6)).multiplyScalar(Math.max(0, 1 + gust * swell));
        w[0] = _v.x; w[1] = _v.y; w[2] = _v.z;
      }
    }
    const dt = delta;
    this.cloth.o.substeps = clothSubsteps(dt, this.cloth.stats.substepMs);
    this.cloth.step(dt);
    this.write();
  }

  /** 布を止めて元のジオメトリ（動かない形）に戻す／布に戻す */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.mesh.geometry = enabled ? this.geometry : this.original;
    if (enabled) this.settle();
  }

  /** ワールド座標の光線が布に当たる、いちばん手前の点（摘む操作用）。point はモデルの単位のワールド座標 */
  raycast(ray: THREE.Ray): { point: THREE.Vector3; distance: number } | null {
    const F = this.cloth.F, x = this.cloth.x, s = 1 / this.scale;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { point: THREE.Vector3; distance: number } | null = null;
    for (let f = 0; f < F.length; f += 3) {
      a.fromArray(x, F[f] * 3).multiplyScalar(s); b.fromArray(x, F[f + 1] * 3).multiplyScalar(s); c.fromArray(x, F[f + 2] * 3).multiplyScalar(s);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { point: hit.clone(), distance };
    }
    return best;
  }

  /** 摘む。座標はモデルの単位のワールド座標（raycast の point をそのまま渡せる） */
  startGrab(point: THREE.Vector3): boolean { return this.cloth.startGrab(point.x * this.scale, point.y * this.scale, point.z * this.scale); }
  moveGrab(point: THREE.Vector3): void { this.cloth.moveGrab(point.x * this.scale, point.y * this.scale, point.z * this.scale); }
  endGrab(): void { this.cloth.endGrab(); }

  dispose(): void {
    this.mesh.geometry = this.original;
    this.geometry.dispose();
  }
}
