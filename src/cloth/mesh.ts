import * as THREE from 'three';
import { describeMeshes, pickSkirt, pickColliders, type ModelPart } from './parts';
import { MeshCloth, type MeshClothOptions } from './MeshCloth';

/**
 * 骨のない、部品に分かれたモデル（3D 生成のモデルなど）のスカートを布にする。MeshCloth へ渡すものを、形から選ぶ：
 *
 * - 布にするメッシュ：下 1/3 に開いた裾があり、裾がいちばん広い部品
 * - 当たる体：スカートの裾より下まで伸び、スカートの高さと重なる部品（脚と腰。靴は下すぎ、ベルトは上すぎで外れる）
 * - 大きさ：スカートの上端の輪の半径が人の腰（8.8cm）になる倍率
 * - 留める点が乗る物体：root（モデル全体を動かす・回すと、布が遅れて付いてくる）
 *
 * どれも options で指定できる。
 */

/** スカートの上端の輪の半径（m）。大きさの単位が分からないモデルの倍率を、ここから決める */
export const WAIST_RADIUS = 0.088;

export type MeshSkirtOptions = Partial<Omit<MeshClothOptions, 'mesh' | 'colliders' | 'metresPerUnit'>> & {
  /** スカートのメッシュ（Mesh か、メッシュ名・材質名）。省くと形で選ぶ */
  skirt?: THREE.Mesh | string;
  /** 当たる体のメッシュ（Mesh か名前の配列）。省くと形で選ぶ。空の配列で当たり判定なし */
  colliders?: (THREE.Mesh | string)[];
  /** 1 ユニットが何メートルか。'auto'（既定）はスカートの上端の輪の半径から決める */
  metresPerUnit?: number | 'auto';
};

/** スカートの上端の輪の半径から、1 ユニットが何メートルかを見積もる */
export function skirtMetresPerUnit(part: ModelPart, waistRadius = WAIST_RADIUS): number {
  const P = part.geometry.attributes.position.array, top = part.box.max.y, len = top - part.box.min.y;
  let cx = 0, cz = 0, n = 0;
  for (let i = 0; i < P.length; i += 3) if (P[i + 1] > top - 0.066 * len) { cx += P[i]; cz += P[i + 2]; n++; }
  if (!n) return 1;
  cx /= n; cz /= n;
  let r = 0;
  for (let i = 0; i < P.length; i += 3) if (P[i + 1] > top - 0.066 * len) r += Math.hypot(P[i] - cx, P[i + 2] - cz);
  return r > 0 ? waistRadius / (r / n) : 1;
}

/** モデルが基準の姿勢のときに呼ぶ。布にできるスカートがなければ null（理由は MeshCloth.skipped） */
export function createMeshSkirt(root: THREE.Object3D, options: MeshSkirtOptions = {}): MeshCloth | null {
  const skip = (reason: string): null => { MeshCloth.skipped = reason; return null; };
  const parts = describeMeshes(root);
  const find = (which: THREE.Mesh | string) => parts.find((p) => (typeof which === 'string' ? p.name === which || p.materialName === which : p.mesh === which));
  const sk = options.skirt ? find(options.skirt) : pickSkirt(parts);
  if (!sk) return skip(options.skirt ? '指定したスカートのメッシュが見つからない' : `スカートらしい部品が見つからない（下 1/3 に開いた裾のある部品がない。部品：${parts.map((p) => p.name).join('、')}）`);
  const bodies = options.colliders
    ? options.colliders.map(find).filter((p): p is ModelPart => !!p)
    : pickColliders(parts, sk);
  const { skirt: _skirt, colliders: _colliders, metresPerUnit = 'auto', ...rest } = options;
  return MeshCloth.create({
    follow: root,
    ...rest,
    mesh: sk.mesh,
    colliders: bodies.map((p) => p.mesh),
    metresPerUnit: metresPerUnit === 'auto' ? skirtMetresPerUnit(sk) : metresPerUnit,
  });
}
