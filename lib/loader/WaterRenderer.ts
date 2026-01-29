/**
 * WaterRenderer - Simple water plane rendering for game use
 *
 * Features:
 * - Water plane at sea level
 * - Basic reflective/refractive appearance
 * - Wave animation
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, WaterRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const tile = result.data!.mainTile!;
 *
 * const water = new WaterRenderer(scene);
 * water.create({
 *   size: tile.size,
 *   seaLevel: tile.seaLevel,
 * });
 * water.startAnimation();
 * ```
 */

import {
  Scene,
  Mesh,
  MeshBuilder,
  ShaderMaterial,
  Vector3,
  Color3,
  Effect,
  Observer,
} from "@babylonjs/core";

// ============================================
// Water Shader
// ============================================

const waterVertexShader = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float uTime;
uniform float uWaveHeight;

varying vec3 vPositionW;
varying vec2 vUV;
varying float vWaveHeight;

// Simple wave function
float wave(vec2 pos, float time) {
    float w1 = sin(pos.x * 0.5 + time * 1.5) * 0.3;
    float w2 = sin(pos.y * 0.7 + time * 1.2) * 0.2;
    float w3 = sin((pos.x + pos.y) * 0.3 + time * 0.8) * 0.15;
    return (w1 + w2 + w3) * uWaveHeight;
}

void main() {
    vec3 pos = position;

    // Apply waves
    float waveOffset = wave(position.xz, uTime);
    pos.y += waveOffset;
    vWaveHeight = waveOffset;

    vec4 worldPos = world * vec4(pos, 1.0);
    vPositionW = worldPos.xyz;
    vUV = uv;

    gl_Position = worldViewProjection * vec4(pos, 1.0);
}
`;

const waterFragmentShader = `
precision highp float;

varying vec3 vPositionW;
varying vec2 vUV;
varying float vWaveHeight;

uniform vec3 uCameraPosition;
uniform vec3 uSunDirection;
uniform vec3 uWaterColor;
uniform vec3 uDeepColor;
uniform float uTime;

void main() {
    // View direction
    vec3 viewDir = normalize(uCameraPosition - vPositionW);

    // Approximate normal from wave height
    vec3 normal = normalize(vec3(-vWaveHeight * 2.0, 1.0, -vWaveHeight * 2.0));

    // Fresnel effect
    float fresnel = pow(1.0 - max(dot(viewDir, normal), 0.0), 3.0);
    fresnel = mix(0.2, 1.0, fresnel);

    // Sun reflection
    vec3 halfVec = normalize(viewDir + uSunDirection);
    float specular = pow(max(dot(normal, halfVec), 0.0), 64.0);

    // Water color with depth simulation
    vec3 waterCol = mix(uDeepColor, uWaterColor, 0.5 + vWaveHeight * 2.0);

    // Sky reflection (simplified)
    vec3 skyColor = vec3(0.5, 0.7, 1.0);
    vec3 reflectedColor = mix(waterCol, skyColor, fresnel * 0.5);

    // Add specular highlight
    vec3 finalColor = reflectedColor + vec3(1.0) * specular * 0.8;

    gl_FragColor = vec4(finalColor, 0.85);
}
`;

// ============================================
// WaterRenderer Class
// ============================================

let waterShaderCounter = 0;

export interface WaterConfig {
  size: number;
  seaLevel: number;
  waveHeight?: number;
  waterColor?: Color3;
  deepColor?: Color3;
}

export class WaterRenderer {
  private scene: Scene;
  private mesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private renderObserver: Observer<Scene> | null = null;
  private startTime: number = 0;
  private animating: boolean = false;

  private sunDirection: Vector3 = new Vector3(0.5, 0.8, 0.3).normalize();

  constructor(scene: Scene) {
    this.scene = scene;
    this.registerShaders();
  }

  private registerShaders(): void {
    const id = ++waterShaderCounter;
    Effect.ShadersStore[`gameWater${id}VertexShader`] = waterVertexShader;
    Effect.ShadersStore[`gameWater${id}FragmentShader`] = waterFragmentShader;
  }

  create(config: WaterConfig): void {
    this.dispose();

    const id = waterShaderCounter;
    const {
      size,
      seaLevel,
      waveHeight = 0.15,
      waterColor = new Color3(0.1, 0.4, 0.5),
      deepColor = new Color3(0.0, 0.15, 0.3),
    } = config;

    // Create water plane
    this.mesh = MeshBuilder.CreateGround(
      "gameWater",
      { width: size, height: size, subdivisions: 64 },
      this.scene
    );
    this.mesh.position.y = seaLevel;
    this.mesh.isPickable = false;

    // Create material
    this.material = new ShaderMaterial(
      `gameWaterMat_${id}`,
      this.scene,
      { vertex: `gameWater${id}`, fragment: `gameWater${id}` },
      {
        attributes: ["position", "uv"],
        uniforms: [
          "world",
          "worldViewProjection",
          "uTime",
          "uWaveHeight",
          "uCameraPosition",
          "uSunDirection",
          "uWaterColor",
          "uDeepColor",
        ],
        needAlphaBlending: true,
      }
    );

    this.material.backFaceCulling = false;
    this.material.setFloat("uTime", 0);
    this.material.setFloat("uWaveHeight", waveHeight);
    this.material.setColor3("uWaterColor", waterColor);
    this.material.setColor3("uDeepColor", deepColor);
    this.material.setVector3("uSunDirection", this.sunDirection);

    this.mesh.material = this.material;
  }

  setSunDirection(direction: Vector3): void {
    this.sunDirection = direction.normalize();
    if (this.material) {
      this.material.setVector3("uSunDirection", this.sunDirection);
    }
  }

  startAnimation(): void {
    if (this.animating) return;

    this.animating = true;
    this.startTime = performance.now() / 1000;

    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      if (!this.material) return;

      const time = performance.now() / 1000 - this.startTime;
      this.material.setFloat("uTime", time);

      const camera = this.scene.activeCamera;
      if (camera) {
        this.material.setVector3("uCameraPosition", camera.position);
      }
    });
  }

  stopAnimation(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }
    this.animating = false;
  }

  setEnabled(enabled: boolean): void {
    if (this.mesh) {
      this.mesh.setEnabled(enabled);
    }
  }

  dispose(): void {
    this.stopAnimation();

    if (this.mesh) {
      this.mesh.dispose();
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
  }
}
