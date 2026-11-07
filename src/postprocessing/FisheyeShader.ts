import { Vector2 } from 'three';

/** CinematicAnimeShader と同じ対角線魚眼。人物マスクを使う仕上げの後で画面全体を歪める。 */
export const FisheyeShader = {
  name: 'FisheyeShader',
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uStrength: { value: 0 },
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
    uniform float uStrength;
    varying vec2 vUv;
    void main() {
      float aspect = uResolution.x / uResolution.y;
      vec2 p = vUv - vec2(0.5);
      p.x *= aspect;
      float rn = length(p) / length(vec2(0.5 * aspect, 0.5));
      float k1 = 0.55 * uStrength;
      float k2 = 0.25 * uStrength;
      // 四隅を元画像の内側に保ち、黒い縁が出ないようにする。
      p *= (1.0 + k1 * rn * rn + k2 * pow(rn, 4.0)) / (1.0 + k1 + k2);
      p.x /= aspect;
      gl_FragColor = texture2D(tDiffuse, p + vec2(0.5));
    }
  `,
};
