import * as THREE from "three";

/**
 * Point light data for shader uniform packing.
 */
export interface PointLightData {
  id: string;
  position: THREE.Vector3;
  color: THREE.Color;
  intensity: number;
  range: number;
}

const MAX_POINT_LIGHTS = 8;

/**
 * Manages point/spot lights for forward+ multi-light rendering.
 * Provides a uniform array that custom shaders can sample.
 */
export class LightManager {
  private lights: Map<string, PointLightData> = new Map();

  // Packed uniform arrays (updated each frame)
  private positionArray = new Float32Array(MAX_POINT_LIGHTS * 3);
  private colorArray = new Float32Array(MAX_POINT_LIGHTS * 3);
  private rangeArray = new Float32Array(MAX_POINT_LIGHTS);
  private activeLightCount = 0;

  // Camera position for distance-based culling
  private cameraPosition = new THREE.Vector3();

  /**
   * Add or update a point light
   */
  setLight(id: string, position: THREE.Vector3, color: THREE.Color, intensity: number, range: number): void {
    this.lights.set(id, { id, position: position.clone(), color: color.clone(), intensity, range });
  }

  /**
   * Remove a light by ID
   */
  removeLight(id: string): void {
    this.lights.delete(id);
  }

  /**
   * Clear all lights
   */
  clearAll(): void {
    this.lights.clear();
  }

  /**
   * Update camera position for distance-based culling.
   * Call once per frame before getUniforms().
   */
  updateCamera(cameraPos: THREE.Vector3): void {
    this.cameraPosition.copy(cameraPos);
  }

  /**
   * Sort lights by distance to camera and pack the nearest MAX_POINT_LIGHTS
   * into uniform arrays. Call once per frame.
   */
  update(): void {
    // Sort by distance to camera (nearest first)
    const sorted = Array.from(this.lights.values()).sort((a, b) => {
      const da = a.position.distanceToSquared(this.cameraPosition);
      const db = b.position.distanceToSquared(this.cameraPosition);
      return da - db;
    });

    const count = Math.min(sorted.length, MAX_POINT_LIGHTS);
    this.activeLightCount = count;

    // Pack into flat arrays
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      if (i < count) {
        const light = sorted[i];
        this.positionArray[i * 3] = light.position.x;
        this.positionArray[i * 3 + 1] = light.position.y;
        this.positionArray[i * 3 + 2] = light.position.z;
        this.colorArray[i * 3] = light.color.r * light.intensity;
        this.colorArray[i * 3 + 1] = light.color.g * light.intensity;
        this.colorArray[i * 3 + 2] = light.color.b * light.intensity;
        this.rangeArray[i] = light.range;
      } else {
        // Zero out unused slots
        this.positionArray[i * 3] = 0;
        this.positionArray[i * 3 + 1] = 0;
        this.positionArray[i * 3 + 2] = 0;
        this.colorArray[i * 3] = 0;
        this.colorArray[i * 3 + 1] = 0;
        this.colorArray[i * 3 + 2] = 0;
        this.rangeArray[i] = 0;
      }
    }
  }

  /**
   * Apply light uniforms to a ShaderMaterial.
   * The material must declare: uPointLightPositions, uPointLightColors, uPointLightRanges, uPointLightCount
   */
  applyToMaterial(material: THREE.ShaderMaterial): void {
    const u = material.uniforms;
    if (u.uPointLightPositions) u.uPointLightPositions.value = this.positionArray;
    if (u.uPointLightColors) u.uPointLightColors.value = this.colorArray;
    if (u.uPointLightRanges) u.uPointLightRanges.value = this.rangeArray;
    if (u.uPointLightCount) u.uPointLightCount.value = this.activeLightCount;
  }

  /**
   * Get uniform declarations to merge into a ShaderMaterial
   */
  static getUniforms(): Record<string, { value: unknown }> {
    return {
      uPointLightPositions: { value: new Float32Array(MAX_POINT_LIGHTS * 3) },
      uPointLightColors: { value: new Float32Array(MAX_POINT_LIGHTS * 3) },
      uPointLightRanges: { value: new Float32Array(MAX_POINT_LIGHTS) },
      uPointLightCount: { value: 0 },
    };
  }

  /**
   * Get GLSL uniform declarations to insert into shader source
   */
  static getShaderUniforms(): string {
    return `
uniform vec3 uPointLightPositions[${MAX_POINT_LIGHTS}];
uniform vec3 uPointLightColors[${MAX_POINT_LIGHTS}];
uniform float uPointLightRanges[${MAX_POINT_LIGHTS}];
uniform int uPointLightCount;
`;
  }

  /**
   * Get GLSL function for computing point light contribution
   */
  static getShaderFunction(): string {
    return `
vec3 calcPointLights(vec3 worldPos, vec3 normal) {
    vec3 totalLight = vec3(0.0);
    for (int i = 0; i < ${MAX_POINT_LIGHTS}; i++) {
        if (i >= uPointLightCount) break;
        vec3 lightDir = uPointLightPositions[i] - worldPos;
        float dist = length(lightDir);
        float range = uPointLightRanges[i];
        if (dist > range) continue;
        lightDir /= dist;
        float NdotL = max(dot(normal, lightDir), 0.0);
        float attenuation = 1.0 / (1.0 + dist * dist / (range * range));
        // Smooth windowing to avoid hard cutoff
        float window = 1.0 - pow(dist / range, 4.0);
        window = max(window, 0.0);
        totalLight += uPointLightColors[i] * NdotL * attenuation * window;
    }
    return totalLight;
}
`;
  }

  get lightCount(): number {
    return this.lights.size;
  }

  getAllLights(): PointLightData[] {
    return Array.from(this.lights.values());
  }
}
