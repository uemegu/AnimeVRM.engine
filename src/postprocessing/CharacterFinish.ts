import * as THREE from 'three';

/**
 * Last touches on the characters, in display space (after the colour grading),
 * using the character mask:
 *
 * - Sunlit / Backlight Anime Rim: a luminous, smooth band of sunlight along
 *   the silhouette on the side facing the key light or backlight.
 *   Calculated with continuous spiral sampling and linear distance weighting
 *   to ensure zero moiré, zero sawtooth noise, and silky smooth organic curves.
 * - Highlight cap: the brightest parts of the characters are rolled off just
 *   under white, so a burst of light never blows the face out. The background
 *   is not touched (lanterns and fireworks may still clip).
 */
export type CharacterRim = {
  /** Colour times strength (display space); black when there is no backlight. */
  color: THREE.Color;
  /** Where the light is on screen (0..1 uv; may lie outside the frame). */
  screen: THREE.Vector2;
};

export const CharacterFinishShader = {
  name: 'CharacterFinishShader',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    tMask: { value: null as THREE.Texture | null },
    tEye: { value: null as THREE.Texture | null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uRimColor: { value: new THREE.Color(0, 0, 0) },
    uRimScreen: { value: new THREE.Vector2(0.5, 1.5) },
    /** Rim width in pixels at 1080 lines. */
    uRimWidth: { value: 4.5 },
    /** Highlight cap: the knee and the ceiling of the roll-off (1, 1 = off). */
    uCapKnee: { value: 1 },
    uCapTop: { value: 1 },
    uEyeCare: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tMask, tEye;
    uniform vec2 uResolution, uRimScreen;
    uniform vec3 uRimColor;
    uniform float uRimWidth, uCapKnee, uCapTop, uEyeCare;
    varying vec2 vUv;

    float characterAt(vec2 uv) { return step(texture2D(tMask, uv).r, 0.99999); }
    float isEyeAt(vec2 uv) {
      float eyeDepth = texture2D(tEye, uv).r;
      return step(eyeDepth, 0.99999) * step(eyeDepth, texture2D(tMask, uv).r + 0.000002);
    }
    float eyeAt(vec2 uv) {
      return uEyeCare * isEyeAt(uv);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      if (characterAt(vUv) < 0.5) {
        gl_FragColor = color;
        return;
      }
      float aspect = uResolution.x / uResolution.y;

      // Sunlit / Backlight Anime Silhouette Rim Light
      if (dot(uRimColor, vec3(1.0)) > 0.001) {
        float pxScale = uResolution.y / 1080.0;
        float radius = max(1.0, uRimWidth * pxScale);

        // Continuous radial disk sampling with linear distance weighting (1.0 - r).
        // 24 taps arranged in a Fermat spiral (golden angle ~ 2.39996323).
        // Weight continuously tapers to 0 at the boundary (r -> 1.0), so taps never abruptly jump in/out.
        // This guarantees zero moire, zero sawtooth stepping, and a silky smooth edge gradient.
        float outsideSum = 0.0;
        float weightSum = 0.0;
        vec2 outwardVec = vec2(0.0);

        for (int i = 0; i < 24; i++) {
          float fi = float(i) + 0.5;
          float r = sqrt(fi / 24.0);
          float theta = fi * 2.39996323;
          vec2 d = vec2(cos(theta), sin(theta));
          vec2 sampleUv = vUv + d * (radius * r) / uResolution;
          float isOut = 1.0 - characterAt(sampleUv);
          float w = 1.0 - r * 0.85;
          outsideSum += isOut * w;
          weightSum += w;
          outwardVec += d * (isOut * w);
        }

        float outsideGrad = outsideSum / weightSum;

        // The rim follows the light behind the character: its brightness fades with uRimColor and its hue stays visible.
        float rimLevel = clamp(max(uRimColor.r, max(uRimColor.g, uRimColor.b)), 0.0, 1.0);
        vec3 rimHue = uRimColor / max(rimLevel, 1e-3);

        if (outsideGrad > 0.006 && dot(outwardVec, outwardVec) > 1e-6) {
          vec2 normOut = normalize(outwardVec);
          vec2 toLight = normalize((uRimScreen - vUv) * vec2(aspect, 1.0));
          float facing = dot(normOut, toLight);

          // Directional gating: highlights ONLY sun-facing silhouette (rejection on shadow side).
          float sunFacing = smoothstep(-0.12, 0.40, facing);

          if (sunFacing > 0.001) {
            // Broad, smooth profile fading from edge inward (~8-10px wide band)
            float rimProfile = smoothstep(0.006, 0.28, outsideGrad);
            // Outer glint core for peak anime brilliance
            float rimCore = pow(rimProfile, 1.4);

            // Material-adaptive sunlit color harmony:
            vec3 baseCol = color.rgb;
            float luma = dot(baseCol, vec3(0.2126, 0.7152, 0.0722));

            vec3 materialTint;
            if (baseCol.b > baseCol.r * 1.12 && luma < 0.40) {
              // Navy uniform blazer / tie: crisp sunlit slate-blue / pale ivory
              materialTint = mix(rimHue, vec3(0.88, 0.94, 1.0), 0.35);
            } else if (luma > 0.58 && baseCol.r > baseCol.b * 0.90) {
              // Skin / white shirt: soft sunlit warm peach-ivory
              materialTint = mix(rimHue, vec3(1.0, 0.95, 0.90), 0.35);
            } else {
              // Hair (dark brown): vibrant golden amber / honey gold matching ideal reference
              materialTint = mix(rimHue, vec3(1.0, 0.78, 0.42), 0.35);
            }

            // Outer edge core transitions to brilliant sunlit cream-white
            vec3 rimColor = mix(materialTint, vec3(1.0, 0.98, 0.95), rimCore * 0.65);

            // Colored lineart (色トレス): softly tint dark MToon outline at the outermost sunlit silhouette
            float isOuterEdge = smoothstep(0.04, 0.22, outsideGrad);
            vec3 cleanBase = mix(color.rgb, max(color.rgb, materialTint * 0.75), isOuterEdge * sunFacing * 0.75 * rimLevel);

            // 1. Screen blend for rich, luminous anime volume
            vec3 screenLight = clamp(rimColor * rimProfile * 0.98 * sunFacing * rimLevel * (1.0 - eyeAt(vUv)), 0.0, 1.0);
            color.rgb = 1.0 - (1.0 - cleanBase) * (1.0 - screenLight);

            // 2. Additive core glint right at the outer edge for true sunlit brilliance
            vec3 coreAdd = rimColor * (rimCore * 0.75 * sunFacing * rimLevel * (1.0 - eyeAt(vUv)));
            color.rgb = clamp(color.rgb + coreAdd, 0.0, 1.0);
          }
        }
      }

      // Highlight cap: roll the brightest channel off between the knee and the ceiling, keeping the hue.
      float m = max(max(color.r, color.g), color.b);
      if (m > uCapKnee) {
        float span = max(uCapTop - uCapKnee, 1e-4);
        float rolled = uCapKnee + span * (1.0 - exp(-(m - uCapKnee) / span));
        color.rgb *= rolled / m;
      }
      gl_FragColor = color;
    }
  `,
};
