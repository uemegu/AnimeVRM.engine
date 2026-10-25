import * as THREE from 'three';
import { VRM, VRMExpression, VRMExpressionMorphTargetBind } from '@pixiv/three-vrm';

/** シェイプキーを組み合わせて作る表情（VRM に元からない表情） */
const SHAPE_KEY_EXPRESSIONS: Record<string, { shapeKey: string; weight: number }[]> = {
  // ニマニマ：困り眉に笑った口
  nima: [
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Fun', weight: 1.0 },
  ],
  // 困り笑い：ハの字の困り眉に笑っている目（漫画の「あはは…」）
  komari: [
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Joy', weight: 1.0 },
  ],
  // えへへ：笑って閉じた目に開いた口（頬染めは blush と組み合わせる）
  ehehe: [
    { shapeKey: 'Fcl_BRW_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_A', weight: 0.4 },
  ],
  // ウィンク：片目だけ笑って閉じ、口角を上げる
  wink: [
    { shapeKey: 'Fcl_BRW_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Joy_R', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Fun', weight: 1.0 },
  ],
  // きらきら：目を見開いたわくわく顔
  kirakira: [
    { shapeKey: 'Fcl_BRW_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Spread', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Joy', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_A', weight: 0.7 },
  ],
  // 照れ：下がった眉に、口角を少し下げた小さな口（頬染めは blush、目そらしは eyeWander と組み合わせる）
  tere: [
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Small', weight: 0.5 },
    { shapeKey: 'Fcl_MTH_Sorrow', weight: 0.25 },
  ],
  // うるうる：下がった眉に、口角を少し下げた小さな口（涙目は tearyEyes と組み合わせる）
  uruuru: [
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Surprised', weight: 0.5 },
    { shapeKey: 'Fcl_MTH_Small', weight: 0.5 },
    { shapeKey: 'Fcl_MTH_Sorrow', weight: 0.25 },
  ],
  // しょんぼり：下がった眉に伏せた目、口角を下げた口
  shonbori: [
    { shapeKey: 'Fcl_BRW_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_EYE_Sorrow', weight: 1.0 },
    { shapeKey: 'Fcl_MTH_Down', weight: 0.2 },
    { shapeKey: 'Fcl_MTH_Sorrow', weight: 0.5 },
  ],
};

/** 目を閉じる表情（このあいだは自動まばたきを止め、潤んだ目の演出も閉じた目として扱う） */
export const EYES_CLOSED_EXPRESSIONS = ['happy', 'komari', 'ehehe', 'wink'] as const;

/**
 * SHAPE_KEY_EXPRESSIONS の表情を VRM に登録し、setExpression の名前で使えるようにする。
 * シェイプキーがそろっていないモデルでは、その表情は登録しない
 */
export function registerShapeKeyExpressions(vrm: VRM): void {
  const manager = vrm.expressionManager;
  if (!manager) return;

  for (const [name, keys] of Object.entries(SHAPE_KEY_EXPRESSIONS)) {
    if (manager.getExpression(name)) continue;
    const binds = keys.map(({ shapeKey, weight }) => {
      const primitives: THREE.Mesh[] = [];
      let index = -1;
      vrm.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        const found = mesh.isMesh ? mesh.morphTargetDictionary?.[shapeKey] : undefined;
        if (found === undefined) return;
        index = found;
        primitives.push(mesh);
      });
      return primitives.length > 0 ? new VRMExpressionMorphTargetBind({ primitives, index, weight }) : null;
    });
    if (binds.some((bind) => !bind)) continue;

    const expression = new VRMExpression(name);
    binds.forEach((bind) => expression.addBind(bind!));
    vrm.scene.add(expression);
    manager.registerExpression(expression);
  }
}
