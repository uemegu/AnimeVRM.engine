import * as THREE from 'three';
import { describePart } from './parts';
import { weld, capRims, buildSDF, type DistanceGrid } from './sdf';
import { subdivide, createCloth, type Cloth, type ClothCollider, type ClothOptions } from './solver';
import type { FabricSpec } from './fabric';
import { ClothPose, MAX_CLOTH_FRAME } from './timing';

/**
 * 骨で動くメッシュ（SkinnedMesh）の一部を布にする。VRM に限らない。
 *
 * モデルは骨で動くまま、材質にも触らない。布にするメッシュのジオメトリだけを差し替え、頂点を毎フレーム書き換える。
 *
 * - メッシュに、細かく分割した新しいジオメトリを持たせる。全頂点の重みを基準の骨（reference）100% にして、毎フレーム、
 *   布のワールド座標を「その骨のスキニング行列の逆」に通して書き戻す。描画側のふつうのスキニングで布の位置に
 *   ちょうど出るので、シェーダー・輪郭線・影のパスは変えなくてよい。
 * - どこが布でどこが体に付いたままかは、リグで決める。clothBones の骨の重みが freeFrom 以上の頂点が布。残りは
 *   ほかの骨に付いたまま（ここで CPU スキニングして、布の縁にする）。頂点ごとに直接指定もできる（clothWeights）。
 * - 布の下の体は、骨ごとの剛体に切る（colliders.bones）。部品ごとに骨の座標で距離の格子を作り、骨と一緒に動かす。
 *
 * 使い方：モデルが基準の姿勢（布の形を覚えさせたい姿勢）のときに create。毎フレーム、姿勢が決まった後に update。
 * VRM のスカートは vrm.ts の createVrmSkirt が、ここへ渡すものを VRM の決まりごとから埋める。
 */

// THREE.Matrix4 (column-major 4x4) -> the solver's 3x4 row-major
function to12(m4: THREE.Matrix4, out: Float64Array): Float64Array {
  const e = m4.elements;
  out[0] = e[0]; out[1] = e[4]; out[2] = e[8]; out[3] = e[12];
  out[4] = e[1]; out[5] = e[5]; out[6] = e[9]; out[7] = e[13];
  out[8] = e[2]; out[9] = e[6]; out[10] = e[10]; out[11] = e[14];
  return out;
}

/** 布が当たる体 */
export interface SkinnedClothColliders {
  /** 体のメッシュ（リグ付き）。布と別のメッシュ */
  meshes: THREE.SkinnedMesh[];
  /**
   * 体を切り分ける骨。三角形は、重みがいちばん大きい骨の部品になる。ここにない骨は、親をたどって最初に当たる
   * この中の骨に属する（ねじり骨など）
   */
  bones: THREE.Object3D[];
  /** たどる途中でこの骨に当たったら、どの部品にも入れない（人体なら胸・腕・足など、布が届かない部位の骨） */
  stopBones?: Iterable<THREE.Object3D>;
}

export interface SkinnedClothOptions {
  /** 布にするメッシュ。ジオメトリを差し替える（setEnabled(false)・dispose で戻る） */
  mesh: THREE.SkinnedMesh;
  /**
   * 布にする骨。この骨に付いた重みが freeFrom 以上の頂点が布になり、留める頂点からはこの骨の重みを除く
   * （揺れものの骨、布の下で大きく動く骨＝脚など）
   */
  clothBones: Iterable<THREE.Object3D>;
  /**
   * 頂点ごとの布の度合い（0〜1、mesh.geometry の頂点順）。指定すると、布にする頂点はこれで決める
   * （clothBones は留める頂点から除く重みにだけ使う）
   */
  clothWeights?: ArrayLike<number>;
  /**
   * 基準の骨（人体なら腰）。布全体がこの骨に乗っているとみなす：近い点の組の作り直しや、姿勢が飛んだかの判定の基準。
   * mesh の骨格にある骨なら、書き戻す頂点はこの骨に付ける
   */
  reference: THREE.Object3D;
  /** 布が当たる体。省くと当たり判定なし */
  colliders?: SkinnedClothColliders | null;
  /** 行列を更新する根（省くと mesh のいちばん上の親） */
  root?: THREE.Object3D;
  /**
   * 頂点が布になるのに要る、clothBones の骨の重みの割合。小さいほど布の範囲が広い（上げた太ももをよけられる）。
   * VRoid のスカートは 0.5 だと上半分が腰に付いたままで、水平まで上げた太ももが 44mm めり込む。0.05 で 1mm 未満
   */
  freeFrom?: number;
  /** 三角形を4分割する回数。'auto' は辺が edge くらいになる回数 */
  sub?: number | 'auto';
  /**
   * 目の細かさ（m）。布になる部分の辺がこのくらいになるまで分割する。既定 1.5cm で、VRoid のスカート・ワンピースは
   * 1 回分割（布 1000 点前後、ソルバー 3〜5ms）。1cm まで細かくすると 16ms かかり、めり込みは減らない
   */
  edge?: number;
  maxTriangles?: number;
  /**
   * 重力で垂れる分の補正の回数（0 で補正なし）。補正しないと、長いスカートは裾の広がりがモデルの 87% まで狭まる。
   * 1 回につき 60 フレーム分を作成時に計算する
   */
  restFit?: number;
  /** 体の距離の格子の目（m） */
  cell?: number;
  /** ソルバーの設定（solver.ts の ClothOptions） */
  solver?: Partial<ClothOptions>;
  /** 生地（fabric.ts の名前か、曲げ剛性 N·m と重さ kg/m²）。曲げにくさと重さが決まる。既定はスーツ地 */
  fabric?: FabricSpec;
  /**
   * 左右の脚の [太ももの骨, ひざの骨]。指定すると、両方の太ももが上がった姿勢（座る・寝る・しゃがむ）で、スカートの
   * 広がった形を覚えさせる力（solver の shapeScale）を抜く。布は体に沿って垂れ、形は体との当たりで決まる。
   * 片脚だけ上げた（蹴り上げ）ときは抜かない。drapeWhenRaised = false で止める
   */
  legs?: [[THREE.Object3D, THREE.Object3D], [THREE.Object3D, THREE.Object3D]];
}

/** 風。velocity は吹いていく向きと速さ（m/s、ワールド座標） */
export interface ClothWind {
  velocity: { x: number; y: number; z: number };
  /** 強弱の揺らぎ（0 = 一定、1 = 止む瞬間がある。既定 0.6） */
  gust?: number;
}

/** ソルバーの刻み（秒）。フレームの長さに合わせてサブステップ数を決める */
const SUBSTEP = 1 / 960;
/** 1フレームのサブステップ数の上限（60fps のときの数） */
const MAX_SUBSTEPS = 16;

const _m4 = new THREE.Matrix4();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
/** 太ももが真下からこの角度（ラジアン）を超えて上がり始めると、形を覚えさせる力を抜き始め、RAISED_TO で抜ききる */
const RAISED_FROM = (45 * Math.PI) / 180, RAISED_TO = (70 * Math.PI) / 180;
/** 抜く・戻すの時定数（秒）。1 フレームに dt / DRAPE_TIME ずつ寄る */
const DRAPE_TIME = 0.4;
/** 体の三角形を当たり判定の部品に入れる重みの割合。これ以上の重みがある部品のすべてに入れる（関節をまたぐ三角形は両側へ） */
const JOINT_SHARE = 0.25;
const _up = new THREE.Vector3(0, 1, 0);

/** リグの重み：[骨の番号, 重み] の並び */
type Weights = [number, number][];

export class SkinnedCloth {
  /** ソルバー。摘む（startGrab / moveGrab / endGrab）・計測（measure）はここから */
  public readonly cloth: Cloth;
  public readonly info: {
    mesh: string; splits: number; cloth: number; held: number;
    pieces: { bone: string; triangles: number; grid: [number, number, number] }[];
  };
  private enabled = true;
  private time = 0;
  private readonly posed: Float64Array;
  private readonly hipsRestInverse = new THREE.Matrix4();
  private readonly hipsSkin = new THREE.Matrix4();
  private readonly hipsSkinInverse = new THREE.Matrix4();
  private readonly clothPose = new ClothPose();

  private constructor(
    private readonly root: THREE.Object3D,
    public readonly mesh: THREE.SkinnedMesh,
    private readonly original: THREE.BufferGeometry,
    private readonly geometry: THREE.BufferGeometry,
    cloth: Cloth,
    private readonly hips: THREE.Object3D,
    private readonly hipsIndex: number,
    private readonly pieceBones: THREE.Object3D[],
    /** 描画頂点ごとの、変形前の位置（メッシュの bindMatrix を通した後） */
    private readonly bind: number[],
    private readonly skin: Weights[],
    /** 体の骨だけの重み（固定する点用） */
    private readonly skinHeld: Weights[],
    /** 布の点ごとの代表の描画頂点 */
    private readonly rep: Int32Array,
    info: SkinnedCloth['info'],
  ) {
    this.cloth = cloth;
    this.info = info;
    this.posed = new Float64Array(cloth.n * 3);
    this.hipsRestInverse.copy(hips.matrixWorld).invert();
    mesh.geometry = geometry;
    mesh.frustumCulled = false;
    this.settle();
  }

  /** create の options に指定がない項目の既定値（調整・検証用。ここを書き換えてから作る） */
  static defaults: Partial<SkinnedClothOptions> = {};

  /** 直前の create が null を返した理由（調べる用） */
  static skipped = '';

  /** モデルが基準の姿勢のときに呼ぶ。布になる頂点がなければ null */
  static create(given: SkinnedClothOptions): SkinnedCloth | null {
    const options: SkinnedClothOptions = { ...SkinnedCloth.defaults, ...given, solver: { ...SkinnedCloth.defaults.solver, ...given.solver } };
    SkinnedCloth.skipped = '';
    const skip = (reason: string): null => { SkinnedCloth.skipped = reason; return null; };
    const { mesh, freeFrom = 0.05, sub = 'auto', edge = 0.015, maxTriangles = 20000, cell = 0.006, restFit = 2, solver = {}, fabric = 'suiting' } = options;
    let root = options.root ?? mesh as THREE.Object3D;
    if (!options.root) while (root.parent) root = root.parent;
    root.updateMatrixWorld(true);
    if (!mesh.geometry.index || !mesh.geometry.attributes.uv) return skip('メッシュに index か uv がない');
    const freeBones = new Set<THREE.Object3D>(options.clothBones);
    const sk = describePart(mesh, freeBones);
    if (options.clothWeights) {
      // 頂点ごとの指定は mesh.geometry の頂点順。部品は自分の頂点だけに詰めてあるので、位置で対応を取る
      const all = options.clothWeights, P = mesh.geometry.attributes.position, used = new Int32Array(P.count).fill(-1);
      const idx = mesh.geometry.index.array;
      let next = 0;
      for (let i = 0; i < idx.length; i++) if (used[idx[i]] < 0) used[idx[i]] = next++;
      const free = new Float32Array(next);
      for (let i = 0; i < P.count; i++) if (used[i] >= 0) free[used[i]] = all[i] ?? 0;
      sk.free = free;
    }
    if (!sk.free || !sk.free.some((f) => f >= freeFrom)) return skip('布になる頂点がない（clothBones の骨に付いた頂点がない）');
    const skeleton = mesh.skeleton;
    const topY = sk.box.max.y, hemY = sk.box.min.y, len = topY - hemY;

    // ---- 布の下の体を、骨ごとの剛体に切る ----
    const pieceBones = options.colliders?.bones ?? [];
    const stopBones = new Set<THREE.Object3D>(options.colliders?.stopBones ?? []);
    const colliders: ClothCollider[] = [];
    const pieces: { bone: THREE.Object3D; triangles: number; grid: [number, number, number] }[] = [];
    for (const bodyMesh of options.colliders?.meshes ?? []) {
      if (bodyMesh === mesh || !bodyMesh.geometry.index) continue;
      const body = describePart(bodyMesh, freeBones);
      // 骨は、親をたどって最初に当たる部品の骨に属する。先に stopBones の骨に当たるものは含めない
      const pieceOf = body.mesh.skeleton.bones.map((b) => {
        for (let o: THREE.Object3D | null = b; o; o = o.parent) {
          const k = pieceBones.indexOf(o);
          if (k >= 0) return k;
          if (stopBones.has(o)) return -1;
        }
        return -1;
      });
      const P = body.geometry.attributes.position.array, J = body.geometry.attributes.skinIndex, W = body.geometry.attributes.skinWeight, I = body.geometry.index!.array;
      const tris: number[][] = pieceBones.map(() => []);
      const lo = hemY - 0.9 * len - 0.05, hi = topY + 0.08, sum = new Float64Array(pieceBones.length);
      for (let f = 0; f < I.length; f += 3) {
        const a = I[f], b = I[f + 1], c = I[f + 2];
        if (Math.max(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]) < lo || Math.min(P[a * 3 + 1], P[b * 3 + 1], P[c * 3 + 1]) > hi) continue;
        sum.fill(0);
        for (const vertex of [a, b, c]) for (let k = 0; k < 4; k++) { const q = pieceOf[J.getComponent(vertex, k)]; if (q >= 0) sum[q] += W.getComponent(vertex, k); }
        // 重みが JOINT_SHARE 以上ある部品のすべてに入れる（関節をまたぐ三角形は両側の部品に入る）。
        // いちばん重い部品だけに入れていたときは、膝を曲げると、描画される膝（太ももとすねの重みが混ざって動く）が
        // どちらの固い部品からも最大 9mm 外へ出て、座った膝がスカートを突き抜けた。両側に入れると外へ出る量は 0mm
        let total = 0;
        for (let q = 0; q < sum.length; q++) total += sum[q];
        if (total > 0) for (let q = 0; q < sum.length; q++) if (sum[q] >= JOINT_SHARE * total) tris[q].push(a, b, c);
      }
      for (let q = 0; q < pieceBones.length; q++) {
        if (tris[q].length < 90) continue;
        // 部品を、今の骨の座標に移す
        _m4.copy(pieceBones[q].matrixWorld).invert();
        const pos: number[] = [], idx: number[] = [], id = new Map<number, number>();
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const t of tris[q]) {
          let i = id.get(t);
          if (i === undefined) {
            i = pos.length / 3; id.set(t, i);
            _v.set(P[t * 3], P[t * 3 + 1], P[t * 3 + 2]).applyMatrix4(_m4);
            pos.push(_v.x, _v.y, _v.z);
            for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], _v.getComponent(c)); max[c] = Math.max(max[c], _v.getComponent(c)); }
          }
          idx.push(i);
        }
        const pad = 0.05;
        const sdf: DistanceGrid = buildSDF(capRims(weld(pos, idx)), { min: min.map((m) => m - pad), max: max.map((m) => m + pad), cell, band: 0.04 });
        colliders.push({ sdf, rest: to12(pieceBones[q].matrixWorld, new Float64Array(12)) });
        pieces.push({ bone: pieceBones[q], triangles: tris[q].length / 3, grid: sdf.dims });
      }
    }

    // ---- 布のメッシュを細かく分割する。リグの重みと変形前の位置は、新しい頂点へ引き継ぐ ----
    const g0 = sk.geometry;
    const free0 = sk.free;
    let sp = subdividable(g0.attributes.position.array, g0.attributes.uv.array, g0.index!.array, Float32Array.from(free0, (f) => (f >= freeFrom ? 1 : 0)));
    const bind = Array.from(g0.attributes.bindPosition.array);
    const skin: Weights[] = [];
    for (let i = 0; i < g0.attributes.position.count; i++) {
      const list: Weights = [];
      for (let k = 0; k < 4; k++) { const wt = g0.attributes.skinWeight.getComponent(i, k); if (wt > 0) list.push([g0.attributes.skinIndex.getComponent(i, k), wt]); }
      skin.push(list);
    }
    const lengths: number[] = [];
    // 目の細かさは、布になる部分の辺で測る（ワンピースは襟や袖のまわりが細かく、裾のほうが粗い）
    for (let f = 0; f < sp.index.length; f += 3) {
      if (!sp.extra[sp.index[f]] || !sp.extra[sp.index[f + 1]]) continue;
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
      for (let q = 0; q < next.made.length; q += 2) {
        const a = next.made[q], b = next.made[q + 1];
        for (let c = 0; c < 3; c++) bind.push((bind[a * 3 + c] + bind[b * 3 + c]) / 2);
        const merged = new Map<number, number>();
        for (const [bone, wt] of skin[a]) merged.set(bone, (merged.get(bone) ?? 0) + wt / 2);
        for (const [bone, wt] of skin[b]) merged.set(bone, (merged.get(bone) ?? 0) + wt / 2);
        skin.push([...merged].sort((x, y) => y[1] - x[1]).slice(0, 4));
      }
      sp = { position: next.position, uv: next.uv, index: next.index, extra: next.extra! };
    }
    const nR = sp.position.length / 3;
    // 変形前の位置は、メッシュの bindMatrix をここで1回通しておく
    for (let i = 0; i < nR; i++) {
      _v.set(bind[i * 3], bind[i * 3 + 1], bind[i * 3 + 2]).applyMatrix4(mesh.bindMatrix);
      bind[i * 3] = _v.x; bind[i * 3 + 1] = _v.y; bind[i * 3 + 2] = _v.z;
    }

    // 上端の中心（「外向き」と裾の広がりの計測に使う）
    let px = 0, pz = 0, pn = 0;
    for (let i = 0; i < sp.position.length; i += 3) if (sp.position[i + 1] > topY - 0.066 * len) { px += sp.position[i]; pz += sp.position[i + 2]; pn++; }

    const cloth = createCloth({ position: sp.position, index: sp.index, colliders, pivot: [px / pn, pz / pn], free: sp.extra, opts: solver, fabric });
    cloth.driven = true;
    if (cloth.n === cloth.pinned.length) return skip('布になる点がない');
    // モデルの形は、重力で垂れた後の形。そこからさらに垂れないよう、垂れる分を見込んで覚える形を補正する
    if (restFit > 0) cloth.fitRestToGravity(restFit);

    // ---- 同じメッシュに持たせる新しいジオメトリ ----
    const hips = options.reference;
    const hipsIndex = Math.max(0, skeleton.bones.indexOf(hips as THREE.Bone));
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const normal = new THREE.BufferAttribute(new Float32Array(nR * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const skinIndex = new Uint16Array(nR * 4), skinWeight = new Float32Array(nR * 4);
    for (let i = 0; i < nR; i++) { skinIndex[i * 4] = hipsIndex; skinWeight[i * 4] = 1; }
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    // 輪郭線用の法線（shader/SmoothNormalHelper.ts）。布の法線は溶接した点から作るので、縫い目をまたいで滑らか。
    // 同じ属性を指しておけば、法線の切り替え（toggleSmoothNormalsInHierarchy）でも毎フレームの書き換えが効く
    geometry.setAttribute('smoothNormal', normal);
    geometry.setAttribute('origNormal', normal);
    geometry.setAttribute('curvature', new THREE.BufferAttribute(new Float32Array(nR), 1));
    geometry.setAttribute('uv', new THREE.BufferAttribute(sp.uv, 2));
    geometry.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
    geometry.setIndex(new THREE.BufferAttribute(sp.index, 1));
    // 材質が複数（本体＋輪郭線）なら、どのパスも全体を描く
    if (Array.isArray(mesh.material)) for (let m = 0; m < mesh.material.length; m++) geometry.addGroup(0, sp.index.length, m);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, (topY + hemY) / 2, 0), 5);

    // 留める点からは、布にする骨（スカートの揺れもの・脚）の重みを除く。残すと、その骨が勝手に揺れて布の縁が震える。
    // 袖など他の揺れものの重みは残すので、ワンピースの袖は今までどおり揺れものの骨で動く
    const isFree = skeleton.bones.map((b) => freeBones.has(b));
    const skinHeld = skin.map((list): Weights => {
      const body = list.filter(([bone]) => !isFree[bone]), total = body.reduce((a, [, wt]) => a + wt, 0);
      return total > 0 ? body.map(([bone, wt]) => [bone, wt / total]) : list;
    });
    const rep = new Int32Array(cloth.n).fill(-1);
    for (let r = 0; r < nR; r++) if (rep[cloth.map[r]] < 0) rep[cloth.map[r]] = r;

    const made = new SkinnedCloth(root, mesh, mesh.geometry, geometry, cloth, hips, hipsIndex, pieces.map((p) => p.bone), bind, skin, skinHeld, rep, {
      mesh: sk.materialName || sk.name, splits, cloth: cloth.n - cloth.pinned.length, held: cloth.pinned.length,
      pieces: pieces.map((p) => ({ bone: p.bone.name, triangles: p.triangles, grid: p.grid })),
    });
    made.legs = options.legs ?? null;
    return made;
  }

  /** 今の骨の姿勢で、リグが点 i を置く位置（skeleton.update() の後） */
  private pose(i: number, out: Float64Array, offset: number, weights: Weights[]): void {
    const r = this.rep[i], bm = this.mesh.skeleton.boneMatrices!, bx = this.bind[r * 3], by = this.bind[r * 3 + 1], bz = this.bind[r * 3 + 2];
    let x = 0, y = 0, z = 0;
    for (const [bone, wt] of weights[r]) {
      const e = bone * 16;
      x += wt * (bm[e] * bx + bm[e + 4] * by + bm[e + 8] * bz + bm[e + 12]);
      y += wt * (bm[e + 1] * bx + bm[e + 5] * by + bm[e + 9] * bz + bm[e + 13]);
      z += wt * (bm[e + 2] * bx + bm[e + 6] * by + bm[e + 10] * bz + bm[e + 14]);
    }
    out[offset] = x; out[offset + 1] = y; out[offset + 2] = z;
  }

  /** 骨の今の姿勢を、ソルバーの枠（体全体・体の部品・固定する点の行き先）へ渡す */
  private readRig(): void {
    this.root.updateMatrixWorld(true);
    this.mesh.skeleton.update();
    this.rigVersion++;
    const frames = this.cloth.frames;
    to12(_m4.multiplyMatrices(this.hips.matrixWorld, this.hipsRestInverse), frames.ref.M);
    for (let q = 0; q < this.pieceBones.length; q++) to12(this.pieceBones[q].matrixWorld, frames.colliders[q].M);
    for (const i of this.cloth.pinned) this.pose(i, frames.pinTarget, i * 3, this.skinHeld);
  }

  /** 布の位置と法線を、腰のスキニング行列の逆を通して頂点へ書く */
  private write(): void {
    this.hipsSkin.fromArray(this.mesh.skeleton.boneMatrices!, this.hipsIndex * 16).multiply(this.mesh.bindMatrix);
    this.hipsSkinInverse.copy(this.hipsSkin).invert();
    const e = this.hipsSkinInverse.elements, { x, nrm, map } = this.cloth;
    const position = this.geometry.attributes.position as THREE.BufferAttribute, normal = this.geometry.attributes.normal as THREE.BufferAttribute;
    const P = position.array, N = normal.array;
    for (let r = 0; r < map.length; r++) {
      const k = map[r] * 3, wx = x[k], wy = x[k + 1], wz = x[k + 2], nx = nrm[k], ny = nrm[k + 1], nz = nrm[k + 2];
      P[r * 3] = e[0] * wx + e[4] * wy + e[8] * wz + e[12]; P[r * 3 + 1] = e[1] * wx + e[5] * wy + e[9] * wz + e[13]; P[r * 3 + 2] = e[2] * wx + e[6] * wy + e[10] * wz + e[14];
      N[r * 3] = e[0] * nx + e[4] * ny + e[8] * nz; N[r * 3 + 1] = e[1] * nx + e[5] * ny + e[9] * nz; N[r * 3 + 2] = e[2] * nx + e[6] * ny + e[10] * nz;
    }
    position.needsUpdate = true; normal.needsUpdate = true;
  }

  /** スカート全体を、今リグが置いている位置へ置き直して、そこから始める（読み込み後・カットで姿勢が飛んだ後） */
  /** 左右の脚の [太もも, ひざ]（options.legs） */
  private legs: SkinnedClothOptions['legs'] | null = null;
  /** 両方の太ももが上がった姿勢で、広がった形を覚えさせる力を抜くか（legs があるときだけ効く） */
  public drapeWhenRaised = true;
  /** 太ももの上がり具合（0 = 立っている、1 = 座る・寝る）。抜く度合いはこれに時定数 0.4 秒で寄る（1 秒で 9 割） */
  public raised = 0;

  /** 両方の太ももが、真下からどれだけ上がっているか（0〜1）。下がっているほうの脚で決める */
  private legsRaised(): number {
    if (!this.legs) return 0;
    let low = Infinity;
    for (const [thigh, knee] of this.legs) {
      thigh.getWorldPosition(_v); knee.getWorldPosition(_v2);
      const d = _v2.sub(_v), l = d.length();
      if (l < 1e-6) return 0;
      low = Math.min(low, Math.acos(Math.max(-1, Math.min(1, -d.y / l))));   // 0 = straight down
    }
    // 45 度までは立ち・歩き（走りで前の脚が 50 度）、70 度で座る（太ももがほぼ水平）
    const t = Math.max(0, Math.min(1, (low - RAISED_FROM) / (RAISED_TO - RAISED_FROM)));
    return t * t * (3 - 2 * t);
  }

  /** 外から動かすものがなく、布が止まって計算を休んでいるか（solver の sleep。cloth.o.sleep = false で止めない） */
  get sleeping(): boolean { return this.cloth.sleeping; }

  settle(): void {
    if (!this.enabled) return;
    this.readRig();
    this.clothPose.advance(this.hips.matrixWorld);
    this.resetToPose();
  }

  private resetToPose(): void {
    for (let i = 0; i < this.cloth.n; i++) this.pose(i, this.posed, i * 3, this.skin);
    this.cloth.reset(this.posed);
    if (this.legs) {
      this.raised = this.drapeWhenRaised ? this.legsRaised() : 0;
      this.cloth.o.shapeScale = 1 - this.raised;
    }
    this.write();
  }

  /**
   * 1フレーム進める。姿勢が決まった後（モーションや揺れものの更新の後）に呼ぶ。wind は null で無風
   */
  /**
   * 骨の行列を更新し直すたびに 1 増える。同じフレームで後から更新するほかの布（上着）が、
   * 行列の更新を省いてよいかを知るために見る（cloth/vrm.ts）
   */
  public rigVersion = 0;

  update(delta: number, wind?: ClothWind | null): void {
    if (!this.enabled || !(delta > 0)) return;
    this.time += delta;
    for (let o: THREE.Object3D | null = this.mesh; o; o = o.parent) if (!o.visible) { this.clothPose.invalidate(); return; }
    this.readRig();
    const jumped = this.clothPose.advance(this.hips.matrixWorld);
    if (jumped || delta > MAX_CLOTH_FRAME) {
      this.resetToPose();
      return;
    }
    const w = this.cloth.wind;
    w[0] = w[1] = w[2] = 0;
    if (wind) {
      const t = this.time, gust = wind.gust ?? 0.6;
      // ゆっくりした強弱（周期の違う正弦波の和）と、向きの小さな振れ
      const swell = 0.5 * Math.sin(t * 1.1) + 0.3 * Math.sin(t * 2.3 + 1.7) + 0.2 * Math.sin(t * 0.47 + 4.1);
      _v.set(wind.velocity.x, wind.velocity.y, wind.velocity.z);
      if (_v.lengthSq() > 0) {
        _v.applyAxisAngle(_up, 0.25 * gust * Math.sin(t * 0.31 + 0.6)).multiplyScalar(Math.max(0, 1 + gust * swell));
        w[0] = _v.x; w[1] = _v.y; w[2] = _v.z;
      }
    }
    const dt = delta;
    if (this.legs) {
      const goal = this.drapeWhenRaised ? this.legsRaised() : 0;
      this.raised += (goal - this.raised) * Math.min(1, dt / DRAPE_TIME);
      if (Math.abs(goal - this.raised) < 1e-3) this.raised = goal;
      this.cloth.o.shapeScale = 1 - this.raised;
    }
    // 速いフレーム（120Hz など）では減らす。遅いフレームでは増やさない：増やすと計算が延びてさらに遅くなる
    // （36fps のとき 26 サブステップになり、布の計算が 4ms から 18ms になった）
    this.cloth.o.substeps = Math.max(4, Math.min(MAX_SUBSTEPS, Math.round(dt / SUBSTEP)));
    this.cloth.step(dt);
    this.write();
  }

  /** 布を止めて元のジオメトリ（元の骨で動くメッシュ）に戻す／布に戻す */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.mesh.geometry = enabled ? this.geometry : this.original;
    if (enabled) this.settle();
  }

  /** ワールド座標の光線が布に当たる、いちばん手前の点（摘む操作用） */
  raycast(ray: THREE.Ray): { point: THREE.Vector3; distance: number } | null {
    const F = this.cloth.F, x = this.cloth.x;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
    let best: { point: THREE.Vector3; distance: number } | null = null;
    for (let f = 0; f < F.length; f += 3) {
      a.fromArray(x, F[f] * 3); b.fromArray(x, F[f + 1] * 3); c.fromArray(x, F[f + 2] * 3);
      if (!ray.intersectTriangle(a, b, c, false, hit)) continue;
      const distance = hit.distanceTo(ray.origin);
      if (!best || distance < best.distance) best = { point: hit.clone(), distance };
    }
    return best;
  }

  /** 摘む。座標はワールド座標（raycast の point をそのまま渡せる） */
  startGrab(point: THREE.Vector3): boolean { return this.cloth.startGrab(point.x, point.y, point.z); }
  moveGrab(point: THREE.Vector3): void { this.cloth.moveGrab(point.x, point.y, point.z); }
  endGrab(): void { this.cloth.endGrab(); }

  /** 新しいジオメトリを捨てる。元のジオメトリはメッシュに戻すだけ（モデルの破棄で一緒に捨てられる） */
  dispose(): void {
    this.mesh.geometry = this.original;
    this.geometry.dispose();
  }
}

/** subdivide に渡す形 */
function subdividable(position: ArrayLike<number>, uv: ArrayLike<number>, index: ArrayLike<number>, extra: Float32Array) {
  return { position: Float32Array.from(position), uv: Float32Array.from(uv), index: Uint32Array.from(index), extra };
}
