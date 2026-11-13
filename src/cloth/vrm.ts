import * as THREE from 'three';
import { describeParts, pickSkirt, pickColliders } from './parts';
import { SkinnedCloth, type SkinnedClothOptions } from './SkinnedCloth';

/**
 * VRM のスカート（ワンピースの裾も）を布にする。SkinnedCloth へ渡すものを、VRM の決まりごとから埋める：
 *
 * - 布にするメッシュ：揺れもの（スプリングボーン）に付いた頂点を持つ部品のうち、材質名で分かればそれ
 *   （bottoms / skirt / onepiece / dress）、なければ形（下 1/3 に開いた裾があり、裾がいちばん広い）で選ぶ
 *   （材質名で分かっても下 1/3 に開いた裾がない前開きの白衣などは、布になる頂点がいちばん多いものを選ぶ）
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
  /** スカートの部品（メッシュ名か材質名）。省くと自動で選ぶ */
  skirt?: string;
};

const PIECE_BONES = ['hips', 'spine', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];
const LOWER_BODY = ['hips', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg'];

/**
 * 材質名でスカートと分かる部品に、下 1/3 の開いた裾が見つからないとき（前開きの白衣・コートなど。裾と前の縁と
 * 腰の縁が一続きの縁になり、縁の高さが部品の中ほどになる）の選び方。名前を信じて、布になる頂点がいちばん多い部品を選ぶ。
 * 細い帯（ベルト）は pickSkirt と同じく、全体の高さの 15% 未満なら外す
 */
function mostCloth<P extends { box: THREE.Box3; free: Float32Array | null }>(named: P[], parts: P[], freeFrom: number): P | null {
  const all = new THREE.Box3();
  for (const p of parts) all.union(p.box);
  const H = all.max.y - all.min.y;
  let best: P | null = null, bestCount = 0;
  for (const p of named) {
    if (p.box.max.y - p.box.min.y < 0.15 * H) continue;
    const count = p.free ? p.free.reduce((n, f) => n + (f >= freeFrom ? 1 : 0), 0) : 0;
    if (count > bestCount) { best = p; bestCount = count; }
  }
  return best;
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
  for (const joint of vrm.springBoneManager?.joints ?? []) {
    let o: THREE.Object3D | null = joint.bone;
    while (o && !humanBones.has(o)) o = o.parent;
    if (o && lowerBody.has(o)) clothBones.add(joint.bone);
  }
  if (clothBones.size === 0) return skip('腰から生えた揺れものの骨がない');
  for (const name of ['leftUpperLeg', 'rightUpperLeg']) bone(name)?.traverse((b) => clothBones.add(b));

  const freeFrom = options.freeFrom ?? SkinnedCloth.defaults.freeFrom ?? 0.05;
  const parts = describeParts(vrm.scene, clothBones);
  const withCloth = parts.filter((p) => p.free?.some((f) => f >= freeFrom));
  const named = withCloth.filter((p) => /bottoms|skirt|onepiece|dress/i.test(`${p.materialName} ${p.name}`));
  const sk = options.skirt
    ? parts.find((p) => p.name === options.skirt || p.materialName === options.skirt)
    : pickSkirt(named) ?? mostCloth(named, parts, freeFrom) ?? pickSkirt(withCloth);
  if (!sk) return skip(`スカートの部品が見つからない（揺れものに付いた部品：${withCloth.map((p) => p.materialName || p.name).join('、') || 'なし'}）`);

  const { skirt: _skirt, ...rest } = options;
  return SkinnedCloth.create({
    ...rest,
    mesh: sk.mesh,
    root: vrm.scene,
    clothBones,
    reference: hips,
    colliders: {
      meshes: pickColliders(parts, sk).map((p) => p.mesh),
      bones: PIECE_BONES.map(bone).filter((b): b is THREE.Object3D => !!b),
      stopBones: humanBones,
    },
  });
}
