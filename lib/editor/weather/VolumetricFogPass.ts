import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * Volumetric fog + god ray post-processing pass.
 * Uses half-resolution ray marching and depth-aware upsampling.
 */
export class VolumetricFogPass extends Pass {
  private raymarchMaterial: THREE.ShaderMaterial;
  private compositeMaterial: THREE.ShaderMaterial;
  private raymarchQuad: FullScreenQuad;
  private compositeQuad: FullScreenQuad;
  private lowResTarget: THREE.WebGLRenderTarget;
  private downsampleScale = 0.5;
  private width: number;
  private height: number;
  private lowResWidth: number;
  private lowResHeight: number;

  // Configurable parameters
  fogDensity = 0.02;
  fogHeightFalloff = 0.1;
  fogBaseHeight = 0.0;
  fogColor = new THREE.Color(0.6, 0.75, 0.9);
  sunDirection = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
  sunColor = new THREE.Color(1.0, 0.9, 0.7);
  godRayIntensity = 0.3;
  godRayDecay = 0.96;
  steps = 16;

  constructor(camera: THREE.Camera, resolution: THREE.Vector2) {
    super();
    this.needsSwap = true;

    this.width = Math.max(1, Math.floor(resolution.x));
    this.height = Math.max(1, Math.floor(resolution.y));
    this.lowResWidth = Math.max(1, Math.floor(this.width * this.downsampleScale));
    this.lowResHeight = Math.max(1, Math.floor(this.height * this.downsampleScale));

    this.lowResTarget = new THREE.WebGLRenderTarget(
      this.lowResWidth,
      this.lowResHeight,
      {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: false,
      }
    );

    this.raymarchMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: null },
        uCameraNear: { value: (camera as THREE.PerspectiveCamera).near || 0.1 },
        uCameraFar: { value: (camera as THREE.PerspectiveCamera).far || 2000 },
        uInverseProjection: { value: new THREE.Matrix4() },
        uInverseView: { value: new THREE.Matrix4() },
        uLowResolution: {
          value: new THREE.Vector2(this.lowResWidth, this.lowResHeight),
        },
        uFogDensity: { value: this.fogDensity },
        uFogHeightFalloff: { value: this.fogHeightFalloff },
        uFogBaseHeight: { value: this.fogBaseHeight },
        uFogColor: { value: this.fogColor },
        uSunDirection: { value: this.sunDirection },
        uSunColor: { value: this.sunColor },
        uGodRayIntensity: { value: this.godRayIntensity },
        uGodRayDecay: { value: this.godRayDecay },
        uSteps: { value: this.steps },
        uCameraPosition: { value: new THREE.Vector3() },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;

        uniform sampler2D tDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform mat4 uInverseProjection;
        uniform mat4 uInverseView;
        uniform vec2 uLowResolution;
        uniform float uFogDensity;
        uniform float uFogHeightFalloff;
        uniform float uFogBaseHeight;
        uniform vec3 uFogColor;
        uniform vec3 uSunDirection;
        uniform vec3 uSunColor;
        uniform float uGodRayIntensity;
        uniform float uGodRayDecay;
        uniform int uSteps;
        uniform vec3 uCameraPosition;

        varying vec2 vUv;

        vec3 worldPosFromDepth(vec2 uv, float depth) {
          vec4 clipSpace = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
          vec4 viewSpace = uInverseProjection * clipSpace;
          viewSpace /= viewSpace.w;
          vec4 worldSpace = uInverseView * viewSpace;
          return worldSpace.xyz;
        }

        // Henyey-Greenstein phase function for forward scattering
        float hgPhase(float cosTheta, float g) {
          float g2 = g * g;
          return (1.0 - g2) / (4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5));
        }

        void main() {
          float rawDepth = texture2D(tDepth, vUv).r;

          // Skip sky pixels
          if (rawDepth >= 1.0) {
            gl_FragColor = vec4(0.0);
            return;
          }

          vec3 worldPos = worldPosFromDepth(vUv, rawDepth);
          vec3 rayDir = normalize(worldPos - uCameraPosition);
          float totalDist = length(worldPos - uCameraPosition);

          // Ray march through volume
          float stepSize = totalDist / float(uSteps);
          float fogAccum = 0.0;
          vec3 scatterAccum = vec3(0.0);

          // Phase function for god rays (forward scattering toward sun)
          float cosAngle = dot(rayDir, uSunDirection);
          float phase = hgPhase(cosAngle, 0.7);

          for (int i = 0; i < 32; i++) {
            if (i >= uSteps) break;

            float t = (float(i) + 0.5) * stepSize;
            vec3 samplePos = uCameraPosition + rayDir * t;

            // Height-based fog density (exponential falloff above base height)
            float heightAboveBase = max(0.0, samplePos.y - uFogBaseHeight);
            float localDensity = uFogDensity * exp(-uFogHeightFalloff * heightAboveBase);

            // Accumulate fog
            fogAccum += localDensity * stepSize;

            // God ray scattering (light contribution at this point)
            float transmittance = exp(-fogAccum * uGodRayDecay);
            scatterAccum += uSunColor * localDensity * phase * transmittance * stepSize;
          }

          // Final fog factor
          float fogFactor = clamp(1.0 - exp(-fogAccum), 0.0, 1.0);

          // Output fog contribution + alpha (fog factor), composited in full-res pass
          vec3 fogColor = uFogColor * fogFactor + scatterAccum * uGodRayIntensity;
          gl_FragColor = vec4(fogColor, fogFactor);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });

    this.compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null },
        tDepth: { value: null },
        tFogLowRes: { value: this.lowResTarget.texture },
        uFullResolution: { value: new THREE.Vector2(this.width, this.height) },
        uLowResolution: {
          value: new THREE.Vector2(this.lowResWidth, this.lowResHeight),
        },
        uDepthEdgeStrength: { value: 120.0 },
        uHasDepth: { value: 1.0 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        precision highp float;

        uniform sampler2D tScene;
        uniform sampler2D tDepth;
        uniform sampler2D tFogLowRes;
        uniform vec2 uFullResolution;
        uniform vec2 uLowResolution;
        uniform float uDepthEdgeStrength;
        uniform float uHasDepth;

        varying vec2 vUv;

        float readDepth(vec2 uv) {
          if (uHasDepth < 0.5) return 1.0;
          return texture2D(tDepth, uv).r;
        }

        vec4 upsampleFogBilateral(vec2 uv) {
          float centerDepth = readDepth(uv);
          if (centerDepth >= 1.0) return vec4(0.0);

          vec2 lowTexel = 1.0 / uLowResolution;
          vec2 fullTexel = 1.0 / uFullResolution;
          vec4 accum = vec4(0.0);
          float weightSum = 0.0;

          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 offset = vec2(float(x), float(y));
              vec2 fogUv = clamp(uv + offset * lowTexel, 0.0, 1.0);
              vec2 depthUv = clamp(uv + offset * fullTexel * 2.0, 0.0, 1.0);

              float sampleDepth = readDepth(depthUv);
              vec4 fogSample = texture2D(tFogLowRes, fogUv);

              float depthDiff = abs(centerDepth - sampleDepth);
              float depthWeight = exp(-depthDiff * uDepthEdgeStrength);
              float spatialWeight = exp(-0.5 * dot(offset, offset));
              float w = depthWeight * spatialWeight;

              accum += fogSample * w;
              weightSum += w;
            }
          }

          return accum / max(weightSum, 0.0001);
        }

        void main() {
          vec4 sceneColor = texture2D(tScene, vUv);
          if (uHasDepth < 0.5) {
            gl_FragColor = sceneColor;
            return;
          }
          float depth = readDepth(vUv);
          if (depth >= 1.0) {
            gl_FragColor = sceneColor;
            return;
          }

          vec4 fog = upsampleFogBilateral(vUv);
          float fogFactor = clamp(fog.a, 0.0, 1.0);
          vec3 color = sceneColor.rgb * (1.0 - fogFactor) + fog.rgb;

          gl_FragColor = vec4(color, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });

    this.raymarchQuad = new FullScreenQuad(this.raymarchMaterial);
    this.compositeQuad = new FullScreenQuad(this.compositeMaterial);
  }

  /**
   * Update camera matrices for world-space reconstruction
   */
  updateCamera(camera: THREE.Camera): void {
    const u = this.raymarchMaterial.uniforms;
    u.uInverseProjection.value.copy(camera.projectionMatrixInverse);
    u.uInverseView.value.copy(camera.matrixWorld);
    u.uCameraPosition.value.copy(camera.position);
    if (camera instanceof THREE.PerspectiveCamera) {
      u.uCameraNear.value = camera.near;
      u.uCameraFar.value = camera.far;
    }
  }

  /**
   * Sync with weather system values
   */
  syncWeather(
    fogColor: THREE.Color,
    fogDensity: number,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color
  ): void {
    this.fogColor.copy(fogColor);
    this.fogDensity = fogDensity;
    this.sunDirection.copy(sunDir);
    this.sunColor.copy(sunColor);

    const u = this.raymarchMaterial.uniforms;
    u.uFogColor.value.copy(fogColor);
    u.uFogDensity.value = fogDensity;
    u.uSunDirection.value.copy(sunDir);
    u.uSunColor.value.copy(sunColor);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const depthTexture = readBuffer.depthTexture;
    if (!depthTexture) {
      if (this.renderToScreen) {
        renderer.setRenderTarget(null);
      } else {
        renderer.setRenderTarget(writeBuffer);
      }
      this.compositeMaterial.uniforms.tScene.value = readBuffer.texture;
      this.compositeMaterial.uniforms.uHasDepth.value = 0.0;
      this.compositeQuad.render(renderer);
      return;
    }

    const raymarchUniforms = this.raymarchMaterial.uniforms;
    raymarchUniforms.tDepth.value = depthTexture;
    raymarchUniforms.uFogDensity.value = this.fogDensity;
    raymarchUniforms.uFogHeightFalloff.value = this.fogHeightFalloff;
    raymarchUniforms.uFogBaseHeight.value = this.fogBaseHeight;
    raymarchUniforms.uGodRayIntensity.value = this.godRayIntensity;
    raymarchUniforms.uGodRayDecay.value = this.godRayDecay;
    raymarchUniforms.uSteps.value = this.steps;

    // Pass 1: half-res ray marching.
    renderer.setRenderTarget(this.lowResTarget);
    renderer.clear();
    this.raymarchQuad.render(renderer);

    // Pass 2: full-res depth-aware compositing.
    const compositeUniforms = this.compositeMaterial.uniforms;
    compositeUniforms.tScene.value = readBuffer.texture;
    compositeUniforms.tDepth.value = depthTexture;
    compositeUniforms.tFogLowRes.value = this.lowResTarget.texture;
    compositeUniforms.uHasDepth.value = 1.0;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }
    this.compositeQuad.render(renderer);
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.lowResWidth = Math.max(
      1,
      Math.floor(this.width * this.downsampleScale)
    );
    this.lowResHeight = Math.max(
      1,
      Math.floor(this.height * this.downsampleScale)
    );

    this.lowResTarget.setSize(this.lowResWidth, this.lowResHeight);

    this.raymarchMaterial.uniforms.uLowResolution.value.set(
      this.lowResWidth,
      this.lowResHeight
    );

    this.compositeMaterial.uniforms.uFullResolution.value.set(
      this.width,
      this.height
    );
    this.compositeMaterial.uniforms.uLowResolution.value.set(
      this.lowResWidth,
      this.lowResHeight
    );
  }

  dispose(): void {
    this.raymarchMaterial.dispose();
    this.compositeMaterial.dispose();
    this.raymarchQuad.dispose();
    this.compositeQuad.dispose();
    this.lowResTarget.dispose();
  }
}
