/**
 * 布のシミュレーション。この src/cloth だけで完結していて、three.js 以外に依存しない（engine のほかの部分も使わない）。
 *
 * - solver / sdf：点と拘束のソルバーと、体の距離の格子。three.js にも依存しない
 * - SkinnedCloth：骨で動くメッシュ（SkinnedMesh）の一部を布にする
 * - createVrmSkirt：VRM のスカートを布にする（SkinnedCloth へ渡すものを VRM の決まりごとから埋める）
 * - MeshCloth：骨のないメッシュを、上端で吊った布にする
 * - createMeshSkirt：骨のない、部品に分かれたモデルのスカートを布にする（MeshCloth へ渡すものを形から選ぶ）
 * - groundField：布が乗る床・椅子などを真上から測る（setGround に渡す）
 *
 * 使い方は README.md。
 */
export { SkinnedCloth, type SkinnedClothOptions, type SkinnedClothColliders, type ClothWind, type ClothHandCapsule } from './SkinnedCloth';
export { createVrmSkirt, createVrmGarments, type VrmLike, type VrmSkirtOptions, type GarmentSpec, type GarmentCloth } from './vrm';
export { createVrmKnit } from './knit';
export { MeshCloth, type MeshClothOptions } from './MeshCloth';
export { createMeshSkirt, skirtMetresPerUnit, WAIST_RADIUS, type MeshSkirtOptions } from './mesh';
export { describeParts, describeMeshes, describePart, pickSkirt, pickColliders, hemOf, type ModelPart, type OpenRim } from './parts';
export { createCloth, subdivide, type Cloth, type ClothInput, type ClothOptions, type ClothCollider, type GroundField } from './solver';
export { groundField, type GroundFieldOptions } from './ground';
export { buildSDF, capRims, weld, type DistanceGrid, type WeldedMesh } from './sdf';
export { FABRICS, fabricOf, bendingLength, kesBending, kesWeight, type Fabric, type FabricName, type FabricPreset, type FabricSpec } from './fabric';
