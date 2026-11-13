import * as THREE from 'three';

/**
 * 3D背景のセル調の明暗。日の当たる面と影の面を、境目のぼけない2段階に塗り分ける。
 * 光の向き・影の色・時間帯のティントは場所ごとに StageManager が setCelLight で全材質まとめて切り替える。
 */
const uniforms = {
  uCelSun: { value: new THREE.Vector3(0, 1, 0) },
  uCelShade: { value: new THREE.Color(1, 1, 1) },
  uCelTint: { value: new THREE.Color(1, 1, 1) },
};

/**
 * 光の向き（太陽のある方）、影の面の乗算色、植栽・切り抜き立面向けの時間帯ティント色を設定する。
 * 場所に光の指定がなければ white で明暗・ティントを付けない。
 */
export function setCelLight(toSun: THREE.Vector3, shade: THREE.Color, tint?: THREE.Color): void {
  uniforms.uCelSun.value.copy(toSun).normalize();
  uniforms.uCelShade.value.copy(shade);
  if (tint) {
    uniforms.uCelTint.value.copy(tint);
  } else {
    uniforms.uCelTint.value.setRGB(1, 1, 1);
  }
}

/**
 * 不透明な MeshBasicMaterial に明暗を足す。
 * 植栽の交差板・切り抜きの立面（alphaTest > 0 かつ非透過）には法線ベースの2値明暗を付けず、
 * 時間帯の色味（uCelTint）だけを乗せてシーン全体の光に馴染ませる。
 * 半透明（transparent）はガラスや発光物を含むため自動適用しない（userData.celTint === true で明示有効化）。
 */
function patch(material: THREE.Material): void {
  if (!(material instanceof THREE.MeshBasicMaterial) || material.userData.celPatched) return;
  if (material.userData.cel === false) return;

  const isCutout = material.alphaTest > 0 && !material.transparent;
  const wantTintOnly = material.userData.celTint === true || (isCutout && material.userData.celTint !== false);

  if (wantTintOnly) {
    material.userData.celPatched = true;
    const prevCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      prevCompile?.(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uCelTint;')
        .replace('#include <opaque_fragment>', 'outgoingLight *= uCelTint;\n#include <opaque_fragment>');
    };
    const prevKey = material.customProgramCacheKey?.bind(material);
    material.customProgramCacheKey = () => `${prevKey ? prevKey() + '|' : ''}cel-cutout-tint`;
    material.needsUpdate = true;
    return;
  }

  if (material.alphaTest > 0 || material.transparent) return;
  material.userData.celPatched = true;
  const prevCompile = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prevCompile?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCelNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
  mat3 celModel = mat3(modelMatrix);
  #ifdef USE_INSTANCING
    celModel = celModel * mat3(instanceMatrix);
  #endif
  vCelNormal = celModel * normal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCelNormal;\nuniform vec3 uCelSun;\nuniform vec3 uCelShade;')
      .replace('#include <opaque_fragment>', `vec3 celNormal = normalize(vCelNormal) * (gl_FrontFacing ? 1.0 : -1.0);
  float celDot = dot(celNormal, uCelSun);
  // 境目はぼかさず、画面上で1画素ほどだけなめらかにする
  float celLit = smoothstep(-0.5, 0.5, celDot / max(fwidth(celDot), 1e-4));
  outgoingLight *= mix(uCelShade, vec3(1.0), celLit);
  #include <opaque_fragment>`);
  };
  const prevKey = material.customProgramCacheKey?.bind(material);
  material.customProgramCacheKey = () => `${prevKey ? prevKey() + '|' : ''}cel-shading`;
  material.needsUpdate = true;
}

/** 3D背景の中の材質すべてに明暗を足す（読み込んだときに一度だけ呼ぶ） */
export function applyCelShading(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) patch(material);
  });
}
