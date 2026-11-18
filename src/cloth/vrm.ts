import * as THREE from 'three';
import { describeParts, pickSkirt, pickColliders } from './parts';
import { SkinnedCloth, type SkinnedClothOptions, type ClothWind } from './SkinnedCloth';
import { createVrmKnit } from './knit';
import type { FabricSpec } from './fabric';

/**
 * VRM のスカート（ワンピースの裾も）を布にする。SkinnedCloth へ渡すものを、VRM の決まりごとから埋める：
 *
 * - 布にするメッシュ：options.skirt（メッシュ名か材質名）。なければ、揺れもの（スプリングボーン）に付いた頂点を持つ部品
 *   のうち、形（下 1/3 に開いた裾があり、裾がいちばん広い）で選ぶ。材質名では選ばない
 * - 布にする骨：腰（か脚）から生えている揺れものと、脚の骨。袖・胸・髪の揺れものは、いちばん近い人体の骨が
 *   腕・胸・頭なので入らない（ワンピースの袖まで布にすると、腕に当たり判定がないので袖が腕を抜けて落ちる）。
 *   脚の骨を入れるのは、VRoid のスカートは上のほうに太ももの重みが少し入っていて、そこを脚に付けたまま留めると、
 *   座ったとき留めた点が太ももと一緒に 90 度前へ回り、布が引き伸ばされて震え続けるため。留めるのは腰と背骨の分だけ
 * - 当たる体：スカートの下まで伸びている部品（肌）を、腰・背骨・太もも・すねの骨ごとに切る
 * - 基準の骨：腰
 *
 * @pixiv/three-vrm には依存しない（下の VrmLike の形をしていればよい）。
 */

/** 使う VRM の項目（@pixiv/three-vrm の VRM はこの形をしている） */
export interface VrmLike {
  scene: THREE.Object3D;
  humanoid?: {
    getRawBoneNode(name: string): THREE.Object3D | null;
    /** 人体の骨の名前 → { node } */
    humanBones: object;
  } | null;
  springBoneManager?: { joints: Iterable<{ bone: THREE.Object3D }> } | null;
}

export type VrmSkirtOptions = Partial<Omit<SkinnedClothOptions, 'mesh' | 'clothBones' | 'reference' | 'colliders' | 'root'>> & {
  /** スカートの部品：メッシュそのもの、かメッシュ名・材質名。省くと形で選ぶ */
  skirt?: string | THREE.Object3D;
  /** 当たる体から外すメッシュ（ほかの布。布は形が変わるので、固い体としては当てない） */
  notColliders?: THREE.Object3D[];
  /** 当たる体を切る骨（人体の骨の名前）。省くと腰・背骨・太もも・すね */
  pieceBones?: string[];
};


/** 骨とその子孫を、stop の骨（人体の骨）の手前まで visit する（揺れものの骨と、それに運ばれる末端・補助の骨） */
function carried(root: THREE.Object3D, stop: Set<THREE.Object3D>, visit: (b: THREE.Object3D) => void): void {
  const walk = (o: THREE.Object3D) => { visit(o); for (const c of o.children) if (!stop.has(c)) walk(c); };
  walk(root);
}

const PIECE_BONES = ['hips', 'spine', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
const LOWER_BODY = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];

/** 左右の [太もも, ひざ]。どれか欠けていれば undefined */
function legsOf(bone: (name: string) => THREE.Object3D | null): SkinnedClothOptions['legs'] {
  const l = bone('leftUpperLeg'), lk = bone('leftLowerLeg'), r = bone('rightUpperLeg'), rk = bone('rightLowerLeg');
  return l && lk && r && rk ? [[l, lk], [r, rk]] : undefined;
}

/** 読み込み直後（モーションを当てる前の姿勢）に呼ぶ。布にできるスカートがなければ null（理由は SkinnedCloth.skipped） */
export function createVrmSkirt(vrm: VrmLike, options: VrmSkirtOptions = {}): SkinnedCloth | null {
  const skip = (reason: string): null => { SkinnedCloth.skipped = reason; return null; };
  const humanoid = vrm.humanoid;
  if (!humanoid) return skip('humanoid がない');
  const bone = (name: string): THREE.Object3D | null => humanoid.getRawBoneNode(name);
  const hips = bone('hips');
  if (!hips) return skip('腰の骨がない');
  vrm.scene.updateMatrixWorld(true);

  const humanBones = new Set<THREE.Object3D>(
    Object.values(humanoid.humanBones as Record<string, { node?: THREE.Object3D } | undefined>).map((b) => b?.node).filter((b): b is THREE.Object3D => !!b),
  );
  const lowerBody = new Set<THREE.Object3D>(LOWER_BODY.map(bone).filter((b): b is THREE.Object3D => !!b));
  const clothBones = new Set<THREE.Object3D>();
  // 腰・脚から生えた揺れもの（と、揺れものに運ばれる子の骨。人体の骨で止める）と、脚の骨
  for (const joint of vrm.springBoneManager?.joints ?? []) {
    let o: THREE.Object3D | null = joint.bone;
    while (o && !humanBones.has(o)) o = o.parent;
    if (o && lowerBody.has(o)) carried(joint.bone, humanBones, (b) => clothBones.add(b));
  }
  for (const name of ['leftUpperLeg', 'rightUpperLeg']) bone(name)?.traverse((b) => clothBones.add(b));

  const freeFrom = options.freeFrom ?? SkinnedCloth.defaults.freeFrom ?? 0.05;
  const parts = describeParts(vrm.scene, clothBones);
  const withCloth = parts.filter((p) => p.free?.some((f) => f >= freeFrom));
  const given = options.skirt;
  const sk = given
    ? parts.find((p) => (typeof given === 'string' ? p.name === given || bareName(p.materialName) === bareName(given) : p.mesh === given))
    : pickSkirt(withCloth);
  if (!sk) return skip(`スカートの部品が見つからない（揺れものに付いた部品：${withCloth.map((p) => p.materialName || p.name).join('、') || 'なし'}）`);
  // 布になる頂点（腰・脚の揺れものか脚の骨に付いた頂点）がなければ作れない
  if (!sk.free?.some((f) => f >= freeFrom)) return skip(`「${sk.materialName || sk.name}」に、腰・脚の揺れものか脚の骨に付いた頂点がない`);

  const { skirt: _skirt, notColliders = [], pieceBones = PIECE_BONES, ...rest } = options;
  return SkinnedCloth.create({
    ...rest,
    mesh: sk.mesh,
    root: vrm.scene,
    clothBones,
    reference: hips,
    legs: rest.legs ?? legsOf(bone),
    fabric: rest.fabric ?? 'suiting',
    colliders: {
      meshes: pickColliders(parts, sk).map((p) => p.mesh).filter((m) => !notColliders.includes(m)),
      bones: pieceBones.map(bone).filter((b): b is THREE.Object3D => !!b),
      stopBones: humanBones,
    },
  });
}

/**
 * 布にする服 1 着の指定（アバターごと）。布にするのは、ここに書いた服だけ。
 * キー（createVrmGarments の garments）は材質名かメッシュ名（材質名の末尾の「 (Instance)」は付けても付けなくてもよい）
 */
export interface GarmentSpec {
  /** 生地（fabric.ts の名前か、曲げ剛性 N·m と重さ kg/m²） */
  fabric: FabricSpec;
  /**
   * 布の動かし方。hang：腰から吊って垂れる（スカート・ワンピースの裾。SkinnedCloth）。rest：肩と腕に乗せる（上着。knit.ts）。
   * 省くと骨の付き方で決める：頂点の重みが腰・脚の骨（と、そこから生えた揺れもの）に多ければ hang、ほかは rest
   */
  kind?: 'hang' | 'rest';
  /**
   * この服がどの服の外側に重なるか（ほかの服のキー）。いまは「上着（rest）の裾が、吊った服（hang）の外側に乗る」ときだけ効く。
   * 書かなければ、どの服とも当てない（シャツの裾をスカートの中に入れる着方もあるので、決め打ちしない）
   */
  over?: string[];
}

/** 布にした服 1 着。スカート（SkinnedCloth）も上着（knit）もこの形で扱える */
export interface GarmentCloth {
  mesh: THREE.SkinnedMesh;
  info: { mesh?: string; [key: string]: unknown };
  update(delta: number, wind?: ClothWind | null): void;
  settle(): void;
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

const materialNameOf = (m: THREE.Mesh): string => (Array.isArray(m.material) ? m.material[0] : m.material)?.name ?? '';
const bareName = (name: string): string => name.replace(/ \(Instance\)$/, '');

/**
 * 頂点の重みのうち、bones の骨に付いている割合。三角形が使う頂点だけを数える（VRoid などは、服の部品どうしで
 * 1 つの頂点の並びを共有し、部品ごとに使う頂点の番号だけが違う。並び全部を数えると、スカートに頭や胸の重みが入った）
 */
function weightShare(mesh: THREE.SkinnedMesh, bones: (bone: THREE.Object3D) => boolean): number {
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  if (!si || !sw) return 0;
  const list = mesh.skeleton.bones.map(bones);
  const used = new Uint8Array(si.count), index = mesh.geometry.index;
  if (index) for (let f = 0; f < index.count; f++) used[index.getX(f)] = 1; else used.fill(1);
  let on = 0, all = 0;
  for (let v = 0; v < si.count; v++) if (used[v]) for (let c = 0; c < 4; c++) {
    const wt = sw.getComponent(v, c);
    if (!wt) continue;
    all += wt;
    if (list[si.getComponent(v, c)]) on += wt;
  }
  return all ? on / all : 0;
}

/**
 * 上着の裾を乗せる吊った服を、knit.ts の readSkirt が読む形（布の点・法線・元の位置・点の数と、軸の位置）にまとめる。
 * 2 着以上なら点を 1 つの並びにつなぎ、毎フレーム refresh で写す。眠っているかは「全部が眠っているか」
 */
function underOf(list: SkinnedCloth[]) {
  if (!list.length) return null;
  const parts = list.map((s) => s.cloth);
  const n = parts.reduce((a, c) => a + c.n, 0), X0 = new Float64Array(n * 3);
  let px = 0, pz = 0, pn = 0, off = 0;
  for (const c of parts) {
    X0.set(c.X0, off * 3); off += c.n;
    for (const q of c.pinned) { px += c.X0[q * 3]; pz += c.X0[q * 3 + 2]; pn++; }
  }
  const single = parts.length === 1;
  const x = single ? parts[0].x : new Float64Array(n * 3), nrm = single ? parts[0].nrm : new Float64Array(n * 3);
  const o = { get sleep() { return parts.every((c) => c.o.sleep); } };
  return {
    cloth: { n, x, nrm, X0, o, get sleeping() { return parts.every((c) => c.sleeping); } },
    pivot: [px / Math.max(1, pn), pz / Math.max(1, pn)] as [number, number],
    refresh(): void {
      if (single) return;
      let at = 0;
      for (const c of parts) { x.set(c.x, at * 3); nrm.set(c.nrm, at * 3); at += c.n; }
    },
  };
}

/**
 * 指定した服だけを布にする（garments：材質名かメッシュ名 → 指定。GarmentSpec）。名前から服の種類を推すことはしない。
 * 吊る服（hang）は createVrmSkirt、乗せる服（rest）は knit.ts の方式（留める輪がなく、肩と腕の上の点を「支え」にして、
 * ほかは体への当たりと布の長さで止める）。
 * 上着が当たる体は、布にしない服と体のうち、揺れもの（髪など）に付いていない部品（材質名では選ばない）。
 * 布どうしは over で指定した組だけ当てる。読み込み直後（モーションを当てる前の姿勢）に呼ぶ。
 */
export function createVrmGarments(vrm: VrmLike, garments: Record<string, GarmentSpec>, { skirt: skirtOptions = {}, knit: knitOptions = {} }: { skirt?: VrmSkirtOptions; knit?: Record<string, unknown> } = {}): GarmentCloth[] {
  const cloths: GarmentCloth[] = [];
  const humanoid = vrm.humanoid;
  if (!humanoid || !Object.keys(garments).length) return cloths;
  vrm.scene.updateMatrixWorld(true);
  // 指定された服のメッシュ
  // 名前は、指定の側もモデルの側も末尾の「 (Instance)」を外して比べる
  const keyOf = new Map(Object.keys(garments).map((k) => [bareName(k), k]));
  const meshes: { key: string; mesh: THREE.SkinnedMesh; spec: GarmentSpec }[] = [];
  vrm.scene.traverse((object) => {
    const m = object as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh || !m.geometry.index) return;
    for (const name of [materialNameOf(m), m.name]) {
      const key = keyOf.get(bareName(name));
      if (key) { meshes.push({ key, mesh: m, spec: garments[key] }); return; }
    }
  });
  const missing = Object.keys(garments).filter((k) => !meshes.some((g) => g.key === k));
  if (missing.length) console.warn('布にする服が見つからない:', missing.join('、'));
  // 骨の分類：人体の骨（腰・脚とそれ以外）と揺れもの
  const bone = (name: string): THREE.Object3D | null => humanoid.getRawBoneNode(name);
  const humanBones = new Set<THREE.Object3D>(
    Object.values(humanoid.humanBones as Record<string, { node?: THREE.Object3D } | undefined>).map((b) => b?.node).filter((b): b is THREE.Object3D => !!b),
  );
  const lowerBody = new Set<THREE.Object3D>(LOWER_BODY.map(bone).filter((b): b is THREE.Object3D => !!b));
  const humanOf = (b: THREE.Object3D): THREE.Object3D | null => { let o: THREE.Object3D | null = b; while (o && !humanBones.has(o)) o = o.parent; return o; };
  // 揺れものの骨と、それに運ばれる子の骨（揺れものに登録されていない末端・補助の骨。人体の骨で止める）
  const springBones = new Set<THREE.Object3D>();
  for (const joint of vrm.springBoneManager?.joints ?? []) carried(joint.bone, humanBones, (b) => springBones.add(b));
  const kindOf = (g: { mesh: THREE.SkinnedMesh; spec: GarmentSpec }): 'hang' | 'rest' =>
    g.spec.kind ?? (weightShare(g.mesh, (b) => { const h = humanOf(b); return !!h && lowerBody.has(h); }) > 0.5 ? 'hang' : 'rest');
  const clothMeshes = new Set<THREE.Object3D>(meshes.map((g) => g.mesh));
  // 上着が当たる体：布にしない部品のうち、揺れものにほとんど付いていないもの（体・顔・布にしない服。髪は外れる）
  const bodyMeshes = new Set<THREE.Object3D>();
  vrm.scene.traverse((object) => {
    const m = object as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && !clothMeshes.has(m) && weightShare(m, (b) => springBones.has(b)) < 0.1) bodyMeshes.add(m);
  });

  const hung = new Map<string, SkinnedCloth[]>();
  for (const g of meshes) {
    if (kindOf(g) !== 'hang') continue;
    const sk = createVrmSkirt(vrm, { ...skirtOptions, skirt: g.mesh, fabric: g.spec.fabric, notColliders: [...clothMeshes] });
    if (sk) { cloths.push(sk); hung.set(g.key, [...(hung.get(g.key) ?? []), sk]); } else console.warn(`「${g.key}」を吊る布にできなかった:`, SkinnedCloth.skipped);
  }
  for (const g of meshes) {
    if (kindOf(g) !== 'rest') continue;
    // 裾が外側に乗る、吊った服（over で指定したもの全部）
    const unders = (g.spec.over ?? []).flatMap((k) => hung.get(keyOf.get(bareName(k)) ?? k) ?? []);
    const under = underOf(unders);
    const firstHung = hung.values().next().value?.[0] ?? null;
    try {
      // knit.ts はまだ型を付けていない
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const knit = (createVrmKnit as unknown as (vrm: VrmLike, options: object) => any)(vrm, { part: g.mesh, bodyFilter: (p: { mesh: THREE.Object3D }) => bodyMeshes.has(p.mesh), opts: { ...knitOptions, fabric: g.spec.fabric } });
      cloths.push({
        mesh: knit.mesh,
        info: { ...knit.info, mesh: g.key },
        // 吊った布がこのフレームで骨の行列を更新し直していたら、上着は同じ更新を繰り返さない。
        // 配列の順（吊る服→上着）で続けて update を呼ぶこと：間に骨を動かすと、上着が古い行列を使う
        update: (() => {
          let seen = -1;
          return (delta: number, wind?: ClothWind | null) => {
            if (!knit.enabled) return;
            const fresh = firstHung && firstHung.rigVersion !== seen ? firstHung.mesh.skeleton : null;
            if (firstHung) seen = firstHung.rigVersion;
            under?.refresh();
            knit.update(delta, under, fresh, wind?.velocity ?? null);
          };
        })(),
        settle: knit.settle,
        setEnabled: knit.setEnabled,
        dispose: knit.dispose,
        knit,
      } as unknown as GarmentCloth);
    } catch (error) {
      console.warn(`「${g.key}」を布にできなかった`, error);
    }
  }
  return cloths;
}
