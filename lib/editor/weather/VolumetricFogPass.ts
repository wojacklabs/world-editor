import * as THREE from "three";
import { Pass, FullScreenQuad } from "three/addons/postprocessing/Pass.js";

/**
 * Volumetric fog + god ray post-processing pass.
 * Uses depth buffer ray marching with height fog and sun-direction scattering.
 */
export class VolumetricFogPass extends Pass {
  private material: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;

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

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uCameraNear: { value: (camera as THREE.PerspectiveCamera).near || 0.1 },
        uCameraFar: { value: (camera as THREE.PerspectiveCamera).far || 2000 },
        uInverseProjection: { value: new THREE.Matrix4() },
        uInverseView: { value: new THREE.Matrix4() },
        uResolution: { value: resolution.clone() },
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

        uniform sampler2D tDiffuse;
        uniform sampler2D tDepth;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform mat4 uInverseProjection;
        uniform mat4 uInverseView;
        uniform vec2 uResolution;
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

        float linearizeDepth(float d) {
          return uCameraNear * uCameraFar / (uCameraFar - d * (uCameraFar - uCameraNear));
        }

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
          vec4 sceneColor = texture2D(tDiffuse, vUv);
          float rawDepth = texture2D(tDepth, vUv).r;

          // Skip sky pixels
          if (rawDepth >= 1.0) {
            gl_FragColor = sceneColor;
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
            float transmittance = exp(-fogAccum);
            scatterAccum += uSunColor * localDensity * phase * transmittance * stepSize;
          }

          // Final fog factor
          float fogFactor = 1.0 - exp(-fogAccum);
          fogFactor = clamp(fogFactor, 0.0, 1.0);

          // Combine: scene * transmittance + fog color + god ray scattering
          vec3 foggedColor = mix(sceneColor.rgb, uFogColor, fogFactor);
          foggedColor += scatterAccum * uGodRayIntensity;

          gl_FragColor = vec4(foggedColor, sceneColor.a);
        }
      `,
      depthWrite: false,
      depthTest: false,
    });

    this.fsQuad = new FullScreenQuad(this.material);
  }

  /**
   * Update camera matrices for world-space reconstruction
   */
  updateCamera(camera: THREE.Camera): void {
    const u = this.material.uniforms;
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
  syncWeather(fogColor: THREE.Color, fogDensity: number, sunDir: THREE.Vector3, sunColor: THREE.Color): void {
    this.fogColor.copy(fogColor);
    this.fogDensity = fogDensity;
    this.sunDirection.copy(sunDir);
    this.sunColor.copy(sunColor);

    const u = this.material.uniforms;
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
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;

    // Get depth texture from read buffer
    u.tDepth.value = readBuffer.depthTexture;

    u.uFogDensity.value = this.fogDensity;
    u.uFogHeightFalloff.value = this.fogHeightFalloff;
    u.uFogBaseHeight.value = this.fogBaseHeight;
    u.uGodRayIntensity.value = this.godRayIntensity;
    u.uGodRayDecay.value = this.godRayDecay;
    u.uSteps.value = this.steps;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
    }

    this.fsQuad.render(renderer);
  }

  setSize(width: number, height: number): void {
    this.material.uniforms.uResolution.value.set(width, height);
  }

  dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
