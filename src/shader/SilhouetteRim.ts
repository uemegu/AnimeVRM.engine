import * as THREE from 'three';

/**
 * シルエットだけを光らせる日差しのリムライト
 *
 * 面の法線（フレネル）で縁を決めると、髪の毛束1本1本の縁・襟・袖の折り目など、
 * 内側の縁まで「かすめ角」になって光ってしまう。外形（背景との境目）かどうかは法線では分からない。
 * そこで、キャラだけを描いた深度（CharacterMaskRenderer）を MToon のシェーダーで読み、
 * 自分の位置から画面上で日差しの方向へ数 px 進んだ所が「背景（またはずっと奥）」のときだけ光らせる。
 * 髪の下の顔・毛束同士・シャツの上の襟は奥行きの差が小さいので光らない。
 * 輪郭線は光らせず元の色のまま残し、その内側に帯を置く（背景 → 暗い輪郭線 → 明るい帯 → 地の色）。
 *
 * 帯の幅は画面の px で決まる（720 行で uSilRimWidth px。輪郭線の分を含む）。面が日差しへ向くほど広く、
 * 斜めになるほど細くして消す（同じ太さの白い線ではなく、太い所と消える所のある面にする）。キャラ本体の描画（MSAA）の中で色を決めるので、
 * 帯の外側の境目はアンチエイリアスされる。
 */
export const SILHOUETTE_RIM_UNIFORMS = {
  uSilRimMask: { value: null as THREE.Texture | null },
  uSilRimProjection: { value: new THREE.Matrix4() },
  uSilRimNearFar: { value: new THREE.Vector2(0.1, 100) },
  // 外形から内側へ測る幅（1080 行あたりの px）。理想のアニメ作画に合わせた細くシャープなハイライト帯（720 行で約 4.8px）
  uSilRimWidth: { value: 7.2 },
  // カメラの投影サイズに応じた幅の倍率（1.0 = バストアップ基準）
  uSilRimScale: { value: 1.0 },
  // これより奥（m）にある物との境目だけを外形とみなす（髪と顔、襟の折り目は光らせず、首筋・腕・外形は光らせる）
  uSilRimDepthGap: { value: 0.08 },
  // 全体の濃さ（0 = 切る）。毎フレーム updateSilhouetteRimLight が主光の強さから決める
  uSilRimStrength: { value: 1.0 },
  // 主光の色（最大の成分を 1 にしたもの）。帯の色に掛ける
  uSilRimLightColor: { value: new THREE.Color(1, 1, 1) },
};

/**
 * キャラのマスク深度を描く。描いている最中にマテリアルがそのテクスチャを読むと
 * フィードバックループになるので、その間だけ外す。
 */
export function renderCharacterMaskForRim(
  render: () => void,
  mask: THREE.Texture,
  camera: THREE.PerspectiveCamera
): void {
  const u = SILHOUETTE_RIM_UNIFORMS;
  u.uSilRimMask.value = null;
  render();
  u.uSilRimMask.value = mask;
  u.uSilRimProjection.value.copy(camera.projectionMatrix);
  u.uSilRimNearFar.value.set(camera.near, camera.far);
}

/** この強さ以上の主光（夕方の 1.8）で帯を最大の濃さにする。夜や暗い室内ではそのぶん弱まる */
const FULL_RIM_LIGHT_INTENSITY = 1.8;

/**
 * 主光から帯の濃さと色を決める。光がカメラの真後ろ・真正面にあると画面上の向きが定まらないので、そのときは消す。
 * 戻り値は濃さ（RimBloomPass の強さにも使う）。
 */
export function updateSilhouetteRimLight(light: THREE.DirectionalLight, viewDirLength: number): number {
  const u = SILHOUETTE_RIM_UNIFORMS;
  const strength = THREE.MathUtils.clamp(light.intensity / FULL_RIM_LIGHT_INTENSITY, 0, 1)
    * THREE.MathUtils.smoothstep(viewDirLength, 0.05, 0.25);
  u.uSilRimStrength.value = strength;
  const { r, g, b } = light.color;
  u.uSilRimLightColor.value.setRGB(r, g, b).multiplyScalar(1 / Math.max(r, g, b, 1e-3));
  return strength;
}

/** このステージのマスクを読まないようにする（ステージを捨てるとき） */
export function releaseSilhouetteRimMask(mask: THREE.Texture): void {
  if (SILHOUETTE_RIM_UNIFORMS.uSilRimMask.value === mask) SILHOUETTE_RIM_UNIFORMS.uSilRimMask.value = null;
}

/** MToon のフラグメントシェーダーの main の手前に入れる関数 */
export const SILHOUETTE_RIM_GLSL = /* glsl */ `
  uniform sampler2D uSilRimMask;
  uniform mat4 uSilRimProjection;
  uniform vec2 uSilRimNearFar;
  uniform float uSilRimWidth;
  uniform float uSilRimScale;
  uniform float uSilRimDepthGap;
  uniform float uSilRimStrength;
  uniform vec3 uSilRimLightColor;

  float silRimViewDepth(float d) {
    float n = uSilRimNearFar.x;
    float f = uSilRimNearFar.y;
    return -(n * f) / ((f - n) * d - f);
  }

  // 0..1。外形の上（日差し側）で 1、内側へ uSilRimWidth * widthScale px で 0 へ落ちる。内側の縁では 0
  float silhouetteRimFactor(vec3 viewPos, vec2 sunDir, float widthScale) {
    if (uSilRimStrength <= 0.0) return 0.0;
    vec4 clip = uSilRimProjection * vec4(viewPos, 1.0);
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    vec2 res = vec2(textureSize(uSilRimMask, 0));
    if (res.x < 2.0) return 0.0;
    float selfZ = -viewPos.z;
    float widthPx = uSilRimWidth * uSilRimScale * widthScale * res.y / 1080.0;
    // 日差しの方向と、その左右 35° の3方向へ進む（外形が日差しに斜めでも途切れないように）
    vec2 dirs[3];
    dirs[0] = sunDir;
    dirs[1] = vec2(sunDir.x * 0.819 - sunDir.y * 0.574, sunDir.x * 0.574 + sunDir.y * 0.819);
    dirs[2] = vec2(sunDir.x * 0.819 + sunDir.y * 0.574, -sunDir.x * 0.574 + sunDir.y * 0.819);
    float best = 0.0;
    for (int k = 0; k < 3; k++) {
      for (int i = 1; i <= 8; i++) {
        float t = float(i) / 8.0;
        vec2 suv = uv + dirs[k] * (t * widthPx) / res;
        float d = texture2D(uSilRimMask, suv).r;
        bool outside = d >= 1.0 || any(lessThan(suv, vec2(0.0))) || any(greaterThan(suv, vec2(1.0)))
          || silRimViewDepth(d) > selfZ + uSilRimDepthGap;
        if (outside) {
          // セル調: 帯の中はほぼ同じ明るさで、内側の端でくっきり落とす。斜めの方向は少し弱める
          best = max(best, (1.0 - smoothstep(0.7, 1.0, t)) * (k == 0 ? 1.0 : 0.85));
          break;
        }
      }
    }
    return clamp(best, 0.0, 1.0) * uSilRimStrength;
  }
`;
