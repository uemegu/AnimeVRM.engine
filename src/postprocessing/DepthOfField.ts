import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * 背景ぼかし（被写界深度）。ピントの距離から離れた所を、薄いレンズのぼけの大きさでぼかす。
 *
 * 本描画の深度を使うので、RenderPass の直後に置くこと（後ろのパスの出力先には今のフレームの深度がない）。
 * 1. 深度を考慮して 1/2 解像度へ縮小（ピント内のキャラ色が背景へ溶け出すのを防ぐ）
 * 2. 1/2 解像度で 24 タップの円形ボケを計算（フル解像度 40 タップの約 1/6 の負荷）
 * 3. フル解像度の元画像と深度を参照して合成し、ピント面の鮮明さを保つ
 */
const SUBJECT_DEPTH = 0.35;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const COC_GLSL = /* glsl */ `
  #include <packing>
  uniform sampler2D tDepth;
  uniform vec2 uNearFar;
  uniform float uFocus;
  uniform float uSharpRange;
  uniform float uSubjectDepth;
  uniform float uCocScale;
  uniform float uMaxRadius;

  // フル解像度基準のぼけ半径（px）
  float cocAt(vec2 uv) {
    float depth = texture2D(tDepth, uv).x;
    float z = -perspectiveDepthToViewZ(depth, uNearFar.x, uNearFar.y);
    float offset = z > uFocus
      ? max(z - uFocus - max(uSharpRange, uSubjectDepth), 0.0)
      : max(uFocus - z - uSubjectDepth, 0.0);
    return min(0.5 * uCocScale * offset / max(z, 1e-3), uMaxRadius);
  }
`;

const DownsampleShader = {
  vertexShader: VERTEX_SHADER,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    ${COC_GLSL}
    varying vec2 vUv;

    void main() {
      vec2 texel = 1.0 / uResolution;
      vec2 offs[4];
      offs[0] = vec2(-0.5, -0.5) * texel;
      offs[1] = vec2( 0.5, -0.5) * texel;
      offs[2] = vec2(-0.5,  0.5) * texel;
      offs[3] = vec2( 0.5,  0.5) * texel;

      vec3 colSum = vec3(0.0);
      float wSum = 0.0;
      float cocMax = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 suv = clamp(vUv + offs[i], vec2(0.0), vec2(1.0));
        float c = cocAt(suv);
        // ぼける背景画素を優先して拾い、ピントの合った前景色が背景へ滲むのを抑える
        float w = smoothstep(0.0, 0.75, c) + 0.01;
        colSum += texture2D(tDiffuse, suv).rgb * w;
        wSum += w;
        cocMax = max(cocMax, c);
      }
      // 1/2 解像度の px 単位の半径を alpha に格納
      gl_FragColor = vec4(colSum / wSum, cocMax * 0.5);
    }
  `,
};

const BokehShader = {
  vertexShader: VERTEX_SHADER,
  fragmentShader: /* glsl */ `
    uniform sampler2D tHalf;
    uniform vec2 uHalfResolution;
    varying vec2 vUv;

    const int SAMPLES = 24;
    const float GOLDEN_ANGLE = 2.39996323;

    void main() {
      vec4 center = texture2D(tHalf, vUv);
      float radius = center.a;
      if (radius < 0.25) {
        gl_FragColor = center;
        return;
      }
      vec3 sum = center.rgb;
      float weight = 1.0;
      for (int i = 0; i < SAMPLES; i++) {
        float t = (float(i) + 0.5) / float(SAMPLES);
        float r = sqrt(t) * radius;
        float a = float(i) * GOLDEN_ANGLE;
        vec2 uv = vUv + vec2(cos(a), sin(a)) * r / uHalfResolution;
        vec4 s = texture2D(tHalf, uv);
        float w = smoothstep(r - 0.5, r + 0.5, s.a);
        sum += s.rgb * w;
        weight += w;
      }
      gl_FragColor = vec4(sum / weight, center.a);
    }
  `,
};

const CompositeShader = {
  vertexShader: VERTEX_SHADER,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tBlur;
    uniform vec2 uHalfResolution;
    ${COC_GLSL}
    varying vec2 vUv;

    void main() {
      vec4 sharp = texture2D(tDiffuse, vUv);
      float radius = cocAt(vUv);
      if (radius < 0.5) {
        gl_FragColor = sharp;
        return;
      }

      // 深度差で境界滲みを防ぎつつ 1/2 解像度のボケをアップサンプル
      vec2 halfTexel = 0.5 / uHalfResolution;
      float halfRadius = radius * 0.5;
      vec3 blurSum = vec3(0.0);
      float wSum = 0.0;
      vec2 offsets[4];
      offsets[0] = vec2(-halfTexel.x, -halfTexel.y);
      offsets[1] = vec2( halfTexel.x, -halfTexel.y);
      offsets[2] = vec2(-halfTexel.x,  halfTexel.y);
      offsets[3] = vec2( halfTexel.x,  halfTexel.y);
      for (int i = 0; i < 4; i++) {
        vec4 b = texture2D(tBlur, vUv + offsets[i]);
        float w = smoothstep(0.0, 0.5, b.a) * (1.0 - smoothstep(0.5, 2.5, abs(b.a - halfRadius))) + 0.01;
        blurSum += b.rgb * w;
        wSum += w;
      }
      vec3 blur = blurSum / wSum;
      float mixFactor = smoothstep(0.5, 2.0, radius);
      gl_FragColor = vec4(mix(sharp.rgb, blur, mixFactor), sharp.a);
    }
  `,
};

export interface DepthOfFieldParams {
  /** レンズの口径（m）。大きいほどぼける */
  aperture: number;
  /** ぼけの直径の上限（画面の高さに対する割合） */
  maxBlur: number;
  /** ピントより奥でもぼかさない幅（m） */
  sharpRange: number;
}

export class DepthOfFieldPass extends Pass {
  private readonly downsampleMaterial: THREE.ShaderMaterial;
  private readonly bokehMaterial: THREE.ShaderMaterial;
  private readonly compositeMaterial: THREE.ShaderMaterial;
  private readonly downsampleQuad: FullScreenQuad;
  private readonly bokehQuad: FullScreenQuad;
  private readonly compositeQuad: FullScreenQuad;
  private readonly halfInputTarget: THREE.WebGLRenderTarget;
  private readonly halfBlurTarget: THREE.WebGLRenderTarget;

  private readonly sharedUniforms = {
    tDepth: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uHalfResolution: { value: new THREE.Vector2(1, 1) },
    uNearFar: { value: new THREE.Vector2(0.1, 100) },
    uFocus: { value: 2 },
    uSharpRange: { value: 0 },
    uSubjectDepth: { value: SUBJECT_DEPTH },
    uCocScale: { value: 0 },
    uMaxRadius: { value: 0 },
  };

  private params: DepthOfFieldParams = { aperture: 0, maxBlur: 0, sharpRange: 0 };

  constructor() {
    super();
    this.halfInputTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.halfBlurTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
    });

    this.downsampleMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        ...this.sharedUniforms,
      },
      vertexShader: DownsampleShader.vertexShader,
      fragmentShader: DownsampleShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.bokehMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tHalf: { value: null },
        uHalfResolution: this.sharedUniforms.uHalfResolution,
      },
      vertexShader: BokehShader.vertexShader,
      fragmentShader: BokehShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBlur: { value: null },
        ...this.sharedUniforms,
      },
      vertexShader: CompositeShader.vertexShader,
      fragmentShader: CompositeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.downsampleQuad = new FullScreenQuad(this.downsampleMaterial);
    this.bokehQuad = new FullScreenQuad(this.bokehMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  public setParams(params: DepthOfFieldParams | null): void {
    this.enabled = !!params && params.aperture > 0 && params.maxBlur > 0;
    if (params) this.params = params;
  }

  /**
   * ピントを合わせる距離（カメラの向きに沿った奥行き m）とカメラ。
   * lens は焦点距離の倍率（絞りの値をそろえたまま望遠にすると、口径が広がってぼけが強くなる）
   */
  public setFocus(camera: THREE.PerspectiveCamera, focusDistance: number, lens = 1): void {
    const u = this.sharedUniforms;
    const height = u.uResolution.value.y;
    const focus = Math.max(focusDistance, camera.near * 2);
    // ピントの面での画面の高さ（m）に対する口径の割合を、画面の高さ（px）に直す
    const frameHeight = 2 * focus * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    u.uNearFar.value.set(camera.near, camera.far);
    u.uFocus.value = focus;
    u.uSharpRange.value = this.params.sharpRange;
    u.uCocScale.value = ((this.params.aperture * lens) / frameHeight) * height;
    u.uMaxRadius.value = 0.5 * this.params.maxBlur * lens * height;
  }

  public setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    this.sharedUniforms.uResolution.value.set(w, h);
    this.sharedUniforms.uHalfResolution.value.set(hw, hh);
    this.halfInputTarget.setSize(hw, hh);
    this.halfBlurTarget.setSize(hw, hh);
  }

  /** 本描画の深度（SceneRenderPass.depthTexture）。なければ readBuffer の深度を読む */
  public sceneDepth: THREE.Texture | null = null;

  public render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const prevTarget = renderer.getRenderTarget();
    const depth = this.sceneDepth ?? readBuffer.depthTexture;
    this.sharedUniforms.tDepth.value = depth;

    // 1. 深度を考慮して 1/2 解像度へ縮小
    this.downsampleMaterial.uniforms['tDiffuse'].value = readBuffer.texture;
    renderer.setRenderTarget(this.halfInputTarget);
    this.downsampleQuad.render(renderer);

    // 2. 1/2 解像度でボケを計算
    this.bokehMaterial.uniforms['tHalf'].value = this.halfInputTarget.texture;
    renderer.setRenderTarget(this.halfBlurTarget);
    this.bokehQuad.render(renderer);

    // 3. フル解像度のピント面と合成
    this.compositeMaterial.uniforms['tDiffuse'].value = readBuffer.texture;
    this.compositeMaterial.uniforms['tBlur'].value = this.halfBlurTarget.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.compositeQuad.render(renderer);

    renderer.setRenderTarget(prevTarget);
  }

  public dispose(): void {
    this.halfInputTarget.dispose();
    this.halfBlurTarget.dispose();
    this.downsampleMaterial.dispose();
    this.bokehMaterial.dispose();
    this.compositeMaterial.dispose();
    this.downsampleQuad.dispose();
    this.bokehQuad.dispose();
    this.compositeQuad.dispose();
  }
}
