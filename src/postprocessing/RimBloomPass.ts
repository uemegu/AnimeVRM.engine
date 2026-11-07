import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

const fullscreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** にじみの強さの最大（主光が十分強いとき） */
export const RIM_BLOOM_STRENGTH = 0.85;

/**
 * リムライト限定 Bloom パス（Rim Bloom / ハレーション）
 *
 * 全体のトーンや背景、キャラクターの内側には一切影響を与えず、
 * 日差し側（uSunLightViewDir）の外形シルエット・リムライトの光っている帯だけを抽出し、
 * その周囲（主線の内外、および背景側へ 2〜5px 程度）に限定して
 * セルアニメ映画調の柔らかい光の滲み（ハレーション / Bloom）を付与する。
 */
export class RimBloomPass extends Pass {
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    tMask: { value: null as THREE.Texture | null },
    tEye: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uSunLightViewDir: { value: new THREE.Vector2(1, 0) },
    uStrength: { value: RIM_BLOOM_STRENGTH },
    uRadiusPx: { value: 1.4 },
    uThreshold: { value: 0.72 },
  };

  private readonly halfTarget: THREE.WebGLRenderTarget;
  private readonly blurTargetA: THREE.WebGLRenderTarget;
  private readonly blurTargetB: THREE.WebGLRenderTarget;
  private readonly extractMaterial: THREE.ShaderMaterial;
  private readonly blurMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly quad = new FullScreenQuad();

  constructor(mask: THREE.Texture, eyeMask: THREE.Texture) {
    super();
    this.uniforms.tMask.value = mask;
    this.uniforms.tEye.value = eyeMask;

    this.halfTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    this.blurTargetA = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });
    this.blurTargetB = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    });

    // 1. リムライト（日差し側の外形高輝度帯）の抽出
    this.extractMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tMask: { value: mask },
        tEye: { value: eyeMask },
        uResolution: this.uniforms.uResolution,
        uSunLightViewDir: this.uniforms.uSunLightViewDir,
        uThreshold: this.uniforms.uThreshold,
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tMask;
        uniform sampler2D tEye;
        uniform vec2 uResolution;
        uniform vec2 uSunLightViewDir;
        uniform float uThreshold;
        varying vec2 vUv;

        float isCharacter(vec2 uv) {
          return step(texture2D(tMask, uv).r, 0.99999);
        }

        float isEye(vec2 uv) {
          return step(texture2D(tEye, uv).r, 0.99999);
        }

        void main() {
          // キャラクター上でなければ抽出しない（背景・机・黒板・窓などは完全除外）
          float charOn = isCharacter(vUv);
          if (charOn < 0.5 || isEye(vUv) > 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // 日差し方向（uSunLightViewDir）の外形シルエット直近（2〜4px）かを検出
          float hitBg = 0.0;
          for (int i = 1; i <= 3; i++) {
            vec2 probeUv = vUv + uSunLightViewDir * (float(i) * 1.5) / uResolution;
            hitBg = max(hitBg, 1.0 - isCharacter(probeUv));
          }

          // 日差し側の背景に面していない内側のメッシュは除外
          if (hitBg < 0.5) {
            gl_FragColor = vec4(0.0);
            return;
          }

          // リムライトの明るさを取得
          vec3 col = max(texture2D(tDiffuse, vUv).rgb, vec3(0.0));
          float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));

          float bright = smoothstep(uThreshold, uThreshold + 0.25, luma);
          if (bright <= 0.001) {
            gl_FragColor = vec4(0.0);
            return;
          }

          gl_FragColor = vec4(col * bright, 1.0);
        }
      `,
    });

    // 2. 9-tap ガウシアンブラー
    this.blurMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uStep: { value: new THREE.Vector2() },
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform vec2 uStep;
        varying vec2 vUv;
        void main() {
          vec3 c = texture2D(tDiffuse, vUv).rgb * 0.2270;
          c += (texture2D(tDiffuse, vUv + uStep * 1.3846).rgb + texture2D(tDiffuse, vUv - uStep * 1.3846).rgb) * 0.3162;
          c += (texture2D(tDiffuse, vUv + uStep * 3.2308).rgb + texture2D(tDiffuse, vUv - uStep * 3.2308).rgb) * 0.0703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });

    // 3. コンポジット合成
    this.compositeMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tGlow: { value: this.blurTargetB.texture },
        tMask: { value: mask },
        uStrength: this.uniforms.uStrength,
      },
      vertexShader: fullscreenVertex,
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse;
        uniform sampler2D tGlow;
        uniform sampler2D tMask;
        uniform float uStrength;
        varying vec2 vUv;

        float isCharacter(vec2 uv) {
          return step(texture2D(tMask, uv).r, 0.99999);
        }

        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          vec3 glow = texture2D(tGlow, vUv).rgb;

          if (dot(glow, vec3(1.0)) < 0.0005) {
            gl_FragColor = base;
            return;
          }

          float charOn = isCharacter(vUv);
          // 背景側（charOn == 0）にのみ柔らかく光を溢れ出させる（理想画像のハレーション）。
          // キャラの内側（charOn == 1）へは加算しない（0.0）ことで、帯が内側に太くなるのを完全に防ぐ！
          float weight = (1.0 - charOn) * uStrength;

          vec3 lit = clamp(base.rgb, 0.0, 1.0);
          vec3 result = base.rgb + glow * weight * (1.0 - lit * 0.5);

          gl_FragColor = vec4(result, base.a);
        }
      `,
    });

    this.enabled = true;
  }

  setSize(width: number, height: number): void {
    this.uniforms.uResolution.value.set(width, height);
    this.halfTarget.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    this.blurTargetA.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
    this.blurTargetB.setSize(Math.max(1, Math.round(width / 2)), Math.max(1, Math.round(height / 2)));
  }

  render(renderer: THREE.WebGLRenderer, write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const draw = (material: THREE.Material, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = material;
      renderer.setRenderTarget(target);
      this.quad.render(renderer);
    };

    // 1. リムライト抽出
    this.extractMaterial.uniforms.tDiffuse.value = read.texture;
    draw(this.extractMaterial, this.halfTarget);

    // 2. ブラー（2パス）
    const stepPx = Math.max(0.5, this.uniforms.uRadiusPx.value);
    let source: THREE.Texture = this.halfTarget.texture;

    for (let i = 0; i < 2; i++) {
      this.blurMaterial.uniforms.tDiffuse.value = source;
      this.blurMaterial.uniforms.uStep.value.set(stepPx / this.blurTargetA.width, 0);
      draw(this.blurMaterial, this.blurTargetA);

      this.blurMaterial.uniforms.tDiffuse.value = this.blurTargetA.texture;
      this.blurMaterial.uniforms.uStep.value.set(0, stepPx / this.blurTargetB.height);
      draw(this.blurMaterial, this.blurTargetB);

      source = this.blurTargetB.texture;
    }

    // 3. コンポジット
    this.compositeMaterial.uniforms.tDiffuse.value = read.texture;
    draw(this.compositeMaterial, this.renderToScreen ? null : write);
  }

  dispose(): void {
    this.halfTarget.dispose();
    this.blurTargetA.dispose();
    this.blurTargetB.dispose();
    this.extractMaterial.dispose();
    this.blurMaterial.dispose();
    this.compositeMaterial.dispose();
    this.quad.dispose();
  }
}
