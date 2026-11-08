import * as THREE from 'three';

/**
 * 指定レイヤーのオブジェクトだけを深度テクスチャ付きのレンダーターゲットに描く。
 * 前髪の影（髪の深度）やキャラのマスクに使う。
 * マテリアルはそのまま使うので、髪の毛先のアルファカットも反映される。
 */

export function createLayerDepthTarget(width: number, height: number): THREE.WebGLRenderTarget {
  const depthTexture = new THREE.DepthTexture(width, height);
  depthTexture.type = THREE.UnsignedIntType;
  return new THREE.WebGLRenderTarget(width, height, {
    depthTexture,
    depthBuffer: true,
  });
}

/**
 * 深度テクスチャ付きのターゲットの大きさを変える。
 * three は setSize でターゲットを作り直すが、深度テクスチャの image の寸法はそのままなので、次に描くとき
 * 寸法の不一致から needsUpdate が立ち、作り直した深度が材質から正しく読めなくなる（外形のリムライトが全身にかかって白っぽくなる）。
 * 先に image の寸法を合わせておく。
 */
export function resizeDepthTarget(target: THREE.WebGLRenderTarget, width: number, height: number): void {
  target.setSize(width, height);
  const depth = target.depthTexture;
  if (depth) {
    depth.image.width = width;
    depth.image.height = height;
  }
}

export function renderLayerDepth(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  layer: number,
  target: THREE.WebGLRenderTarget
): void {
  // ライトもレイヤー判定の対象なので、ライト数が変わってシェーダーが切り替わらないよう同じレイヤーに載せる
  scene.traverse((obj) => {
    if ((obj as THREE.Light).isLight) obj.layers.enable(layer);
  });

  const prevTarget = renderer.getRenderTarget();
  const prevLayers = camera.layers.mask;
  const prevBackground = scene.background;
  // シャドウマップは本描画で更新されるので、ここでは描き直さない
  const prevShadowAutoUpdate = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  scene.background = null;
  camera.layers.set(layer);

  renderer.setRenderTarget(target);
  renderer.clear(true, true, true);
  renderer.render(scene, camera);

  camera.layers.mask = prevLayers;
  scene.background = prevBackground;
  renderer.shadowMap.autoUpdate = prevShadowAutoUpdate;
  renderer.setRenderTarget(prevTarget);
}
