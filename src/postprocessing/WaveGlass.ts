import { Vector2, Vector4 } from 'three';
import type { WaveGlassKind } from '../schema/stage';

/** シェーダーへ渡す種類の番号（2 は回想の場面転換で使う） */
export const WAVE_GLASS_KIND_INDEX: Record<WaveGlassKind, number> = { underwater: 1 };

/** 回想の場面転換のときにシェーダーへ渡す種類の番号 */
export const WAVE_GLASS_MEMORY = 2;

/**
 * 波ガラス（アニメの撮影処理で、絵の上に波打ったガラスを置いて揺らす処理）。
 * 撮影では白黒の波ガラス素材（またはノイズ）を一方向へ流し、その濃淡で絵をずらす。光が曲がるので、
 * ずれに合わせて明るさも変わり、少しぼける。
 *
 * - 水中（underwater）: 水の中から見た絵。全体が大きくゆっくりうねる。対象（人物以外など）と範囲（水槽の窓など）を限れる
 * - 回想（場面転換 memory）: 回想へ入る・戻る一瞬だけ、画面全体が波打つ。カットの間ずっとは掛けない
 *
 * 人物の仕上げが終わった表示用の絵を歪める（魚眼と同じ位置に置く）。
 */
export const WaveGlassShader = {
  name: 'WaveGlassShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uStrength: { value: 0 },
    uKind: { value: 1 },
    /** 人物のマスク（深度。人物の所は 1 未満） */
    tMask: { value: null },
    /** 掛ける対象（0 = 画面全体、1 = 人物以外、2 = 人物だけ） */
    uTarget: { value: 0 },
    /** 掛ける範囲（左, 下, 右, 上。画面比） */
    uArea: { value: new Vector4(0, 0, 1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uStrength;
    uniform float uKind;
    uniform sampler2D tMask;
    uniform float uTarget;
    uniform vec4 uArea;
    varying vec2 vUv;

    float isCharacter(vec2 uv) { return step(texture2D(tMask, uv).r, 0.99999); }

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    // -1〜1 の滑らかなゆらぎ（2方向）
    vec2 flow(vec2 p) {
      return vec2(noise(p) + 0.5 * noise(p * 2.03 + 17.0), noise(p + 43.0) + 0.5 * noise(p * 2.03 + 71.0)) / 0.75 - 1.0;
    }

    void main() {
      float aspect = uResolution.x / uResolution.y;
      // 縦横で同じ大きさの波になるよう、横を画面比で伸ばした座標で波を作る
      vec2 p = vec2(vUv.x * aspect, vUv.y);
      vec2 offset = vec2(0.0);
      float blur = 0.0;
      // 明度の変化の元（-1〜1）と、その強さ
      float lens = 0.0;
      float lensAmount = 0.0;

      if (uKind < 1.5) {
        // 水中
        vec2 n = flow(p * 1.6 + vec2(uTime * 0.11, -uTime * 0.08));
        offset = n * 0.03;
        offset.x += sin(vUv.y * 9.0 + uTime * 0.9) * 0.012;
        offset.y += sin(vUv.x * 7.0 * aspect + uTime * 0.7) * 0.008;
        blur = 0.5;
        lens = n.x * 0.6 + n.y * 0.4;
        lensAmount = 0.12;
      } else {
        // 回想への出入り: 画面全体が大きく波打つ
        vec2 n = flow(p * 1.3 + vec2(uTime * 0.25, uTime * 0.2));
        offset = n * 0.03;
        offset.x += sin(vUv.y * 7.0 + uTime * 2.2) * 0.02;
        blur = 0.4;
      }

      // 掛ける範囲と対象
      vec2 areaFade = smoothstep(uArea.xy - 0.0001, uArea.xy + 0.06, vUv) * (1.0 - smoothstep(uArea.zw - 0.06, uArea.zw + 0.0001, vUv));
      float here = isCharacter(vUv);
      float amount = areaFade.x * areaFade.y * (uTarget < 0.5 ? 1.0 : (uTarget < 1.5 ? 1.0 - here : here));
      offset *= uStrength * amount;
      blur *= amount;
      offset.x /= aspect;
      // 画面の外を読まないよう、縁では歪みを消す
      vec2 border = smoothstep(vec2(0.0), vec2(0.03), vUv) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - vUv);
      vec2 uv = clamp(vUv + offset * border.x * border.y, 0.0, 1.0);
      // 対象を限っているときは、対象の外の絵を引き込まない（人物が背景へにじむ・背景が人物へ入るのを防ぐ）
      if (uTarget > 0.5 && abs(isCharacter(uv) - here) > 0.5) uv = vUv;

      vec4 color = texture2D(tDiffuse, uv);
      if (blur > 0.001) {
        // にじみ。内と外の2つの輪（8点ずつ、互い違い）で混ぜる。1つの輪だけだと、絵がずれて重なった二重写しに見える
        vec2 r = blur * uStrength * 0.006 * vec2(1.0 / aspect, 1.0);
        vec4 sum = color * 2.0;
        float total = 2.0;
        for (int i = 0; i < 16; i++) {
          float ring = i < 8 ? 1.0 : 0.5;
          float a = float(i) * 0.7853982 + (i < 8 ? 0.0 : 0.3926991);
          float w = i < 8 ? 1.0 : 1.5;
          sum += texture2D(tDiffuse, clamp(uv + vec2(cos(a), sin(a)) * r * ring, 0.0, 1.0)) * w;
          total += w;
        }
        color = sum / total;
      }
      color.rgb *= 1.0 + lens * lensAmount * uStrength * amount;
      gl_FragColor = color;
    }
  `,
};
