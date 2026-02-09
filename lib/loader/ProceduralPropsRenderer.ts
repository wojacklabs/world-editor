/**
 * ProceduralPropsRenderer - Renders procedural props (tree, rock, bush, grass_clump)
 *
 * Uses ProceduralAssetGenerator to create identical meshes as the editor.
 * Supports both individual meshes and InstancedMesh for performance.
 *
 * Usage:
 * ```typescript
 * import { WorldLoader, ProceduralPropsRenderer } from "@world-editor/loader";
 *
 * const result = WorldLoader.loadWorld(json);
 * const renderer = new ProceduralPropsRenderer(scene);
 * renderer.loadProps(result.data!.proceduralProps);
 * ```
 */

import * as THREE from "three";
import type { ProceduralPropInstance } from "./types";
import { ProceduralAssetGenerator, GeneratorParams } from "./ProceduralAssetGenerator";
import { DEFAULT_FOLIAGE_QUALITY_PROFILE } from "../shared/foliage/FoliageQualityProfile";
import { disposeMesh } from "../shared/rendering/threeHelpers";

export interface ProceduralPropsRendererOptions {
  /** Use instancing for better performance (default: false - uses individual meshes to preserve unique params) */
  useInstancing?: boolean;
  /** LOD distance thresholds */
  lodDistances?: { near: number; mid: number; far: number };
  /** Wind direction in radians (default: PI/4 = 45 degrees) */
  windAngle?: number;
  /** Wind strength 0-1 (default: 0.5) */
  windStrength?: number;
  /** Rendering profile version tag from exported world data */
  renderingProfile?: string;
  /** Override texture paths from exported world data */
  textureUrls?: {
    rock?: string;
    dirt?: string;
    leafAtlas?: string;
  };
}

type NormalizedProceduralPropsRendererOptions = {
  useInstancing: boolean;
  lodDistances: { near: number; mid: number; far: number };
  windAngle: number;
  windStrength: number;
};

export class ProceduralPropsRenderer {
  private scene: THREE.Scene;
  private options: NormalizedProceduralPropsRendererOptions;
  private generator: ProceduralAssetGenerator;

  // Individual meshes (preserves unique params)
  private propMeshes: THREE.Mesh[] = [];

  // Instancing (for performance when params similarity is acceptable)
  private instanceMeshes: THREE.InstancedMesh[] = [];

  private lastTime: number = 0;
  private referenceReadyPromise: Promise<void>;

  constructor(scene: THREE.Scene, options: ProceduralPropsRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      useInstancing: options.useInstancing ?? false, // Default to individual for quality
      lodDistances: options.lodDistances ?? { near: 30, mid: 60, far: 120 },
      windAngle:
        options.windAngle ??
        DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.directionRadians,
      windStrength:
        options.windStrength ??
        DEFAULT_FOLIAGE_QUALITY_PROFILE.wind.baseStrength,
    };

    this.generator = new ProceduralAssetGenerator(scene);
    if (options.renderingProfile) {
      this.generator.setRenderingProfileVersion(options.renderingProfile);
    }
    if (options.textureUrls) {
      this.generator.setTextureUrls(options.textureUrls);
    }
    this.generator.setWind(
      new THREE.Vector2(Math.cos(this.options.windAngle), Math.sin(this.options.windAngle)),
      this.options.windStrength
    );
    this.referenceReadyPromise = this.generator.ensureReferenceTemplatesLoaded();

    this.lastTime = performance.now();
  }

  /**
   * Call from your animation loop to advance wind animation.
   */
  update(): void {
    const now = performance.now();
    const deltaTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    this.generator.updateTime(deltaTime);
  }

  /**
   * Load procedural props from decoded world data
   */
  loadProps(props: ProceduralPropInstance[]): void {
    void this.loadPropsAsync(props);
  }

  /**
   * Async load variant that waits for reference tree/bush templates.
   */
  async loadPropsAsync(props: ProceduralPropInstance[]): Promise<void> {
    if (props.length === 0) return;

    await this.referenceReadyPromise;

    if (this.options.useInstancing) {
      this.loadPropsInstanced(props);
    } else {
      this.loadPropsIndividual(props);
    }

    console.log(`[ProceduralPropsRenderer] Loaded ${props.length} procedural props (instancing: ${this.options.useInstancing})`);
  }

  /**
   * Load props using InstancedMesh for better performance.
   * Note: This mode uses shared base meshes, so individual params are not fully preserved.
   */
  private loadPropsInstanced(props: ProceduralPropInstance[]): void {
    // Group by geometry signature so length/width/height-driven structures remain correct.
    const byType = new Map<string, ProceduralPropInstance[]>();

    for (const prop of props) {
      const isStructureType =
        prop.assetType === "hanok_giwa" ||
        prop.assetType === "hanok_choga" ||
        prop.assetType === "wall_fence_segment" ||
        prop.assetType === "jangdokdae_set" ||
        prop.assetType === "doghouse";

      const key = isStructureType
        ? [
            prop.assetType,
            prop.params.seed,
            prop.params.length ?? 0,
            prop.params.width ?? 0,
            prop.params.height ?? 0,
            prop.params.baySize ?? 0,
            prop.params.planPreset ?? "auto",
          ].join("|")
        : prop.assetType;

      if (!byType.has(key)) {
        byType.set(key, []);
      }
      byType.get(key)!.push(prop);
    }

    // Create InstancedMesh for each type
    for (const [groupKey, typeProps] of byType) {
      if (typeProps.length === 0) continue;

      // Create base mesh from first prop's params
      const firstProp = typeProps[0];
      const type = firstProp.assetType;
      const isStructureType =
        type === "hanok_giwa" ||
        type === "hanok_choga" ||
        type === "wall_fence_segment" ||
        type === "jangdokdae_set" ||
        type === "doghouse";
      const params: GeneratorParams = {
        type,
        seed: firstProp.params.seed,
        size: 1.0, // Base size, scale applied via matrix
        sizeVariation: firstProp.params.sizeVariation,
        noiseScale: firstProp.params.noiseScale,
        noiseAmplitude: firstProp.params.noiseAmplitude,
        length: firstProp.params.length,
        width: firstProp.params.width,
        height: firstProp.params.height,
        baySize: firstProp.params.baySize,
        planPreset: firstProp.params.planPreset,
        colorBase: firstProp.params.colorBase,
        colorDetail: firstProp.params.colorDetail,
      };

      const baseMesh = this.generator.generate(params);
      if (!baseMesh) continue;

      // Create InstancedMesh from base geometry and material
      const material = this.generator.createMaterial(params);
      const instancedMesh = new THREE.InstancedMesh(
        baseMesh.geometry,
        material,
        typeProps.length
      );
      instancedMesh.name = `${groupKey}_instances`;

      // Build instance matrices
      // Note: instance.scale already contains the final intended size
      // (params.size and scale are kept in sync in the editor)
      const mat4 = new THREE.Matrix4();
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      const scale = new THREE.Vector3();

      for (let i = 0; i < typeProps.length; i++) {
        const prop = typeProps[i];
        position.set(prop.position.x, prop.position.y, prop.position.z);
        quaternion.identity();
        if (isStructureType) {
          scale.set(1, 1, 1);
        } else {
          scale.set(prop.scale.x, prop.scale.y, prop.scale.z);
        }
        mat4.compose(position, quaternion, scale);
        instancedMesh.setMatrixAt(i, mat4);
      }

      instancedMesh.instanceMatrix.needsUpdate = true;
      instancedMesh.computeBoundingSphere();

      this.scene.add(instancedMesh);
      this.instanceMeshes.push(instancedMesh);

      // Dispose the temporary base mesh (geometry is shared, don't dispose it)
      this.scene.remove(baseMesh);
    }
  }

  /**
   * Load props as individual meshes (slower but preserves unique params/colors)
   */
  private loadPropsIndividual(props: ProceduralPropInstance[]): void {
    for (const prop of props) {
      const mesh = this.createPropMesh(prop);
      if (mesh) {
        this.propMeshes.push(mesh);
      }
    }
  }

  /**
   * Create a single prop mesh with full params
   */
  private createPropMesh(prop: ProceduralPropInstance): THREE.Mesh | null {
    const isStructureType =
      prop.assetType === "hanok_giwa" ||
      prop.assetType === "hanok_choga" ||
      prop.assetType === "wall_fence_segment" ||
      prop.assetType === "jangdokdae_set" ||
      prop.assetType === "doghouse";

    // Generate mesh at unit size (1.0) - actual scaling comes from instance.scale
    // In the editor, params.size and instance.scale are kept in sync,
    // so we ignore params.size and apply only instance.scale
    const params: GeneratorParams = {
      type: prop.assetType,
      seed: prop.params.seed,
      size: 1.0, // Unit size - scaling handled by instance.scale below
      sizeVariation: prop.params.sizeVariation,
      noiseScale: prop.params.noiseScale,
      noiseAmplitude: prop.params.noiseAmplitude,
      length: prop.params.length,
      width: prop.params.width,
      height: prop.params.height,
      baySize: prop.params.baySize,
      planPreset: prop.params.planPreset,
      colorBase: prop.params.colorBase,
      colorDetail: prop.params.colorDetail,
    };

    const mesh = this.generator.generate(params);
    if (!mesh) return null;

    // Apply transform - instance.scale contains the final intended size
    mesh.position.set(prop.position.x, prop.position.y, prop.position.z);
    mesh.rotation.set(prop.rotation.x, prop.rotation.y, prop.rotation.z);
    if (isStructureType) {
      mesh.scale.set(1, 1, 1);
    } else {
      mesh.scale.set(prop.scale.x, prop.scale.y, prop.scale.z);
    }

    mesh.name = `prop_${prop.id}`;

    return mesh;
  }

  /**
   * Set wind parameters
   */
  setWind(angleDegrees: number, strength: number): void {
    const angleRad = angleDegrees * Math.PI / 180;
    this.generator.setWind(
      new THREE.Vector2(Math.cos(angleRad), Math.sin(angleRad)),
      strength
    );
  }

  /**
   * Set visibility
   */
  setVisible(visible: boolean): void {
    for (const mesh of this.instanceMeshes) {
      mesh.visible = visible;
    }
    for (const mesh of this.propMeshes) {
      mesh.visible = visible;
    }
  }

  /**
   * Get total prop count
   */
  getPropCount(): number {
    let count = this.propMeshes.length;
    for (const mesh of this.instanceMeshes) {
      count += mesh.count;
    }
    return count;
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (const mesh of this.instanceMeshes) {
      disposeMesh(this.scene, mesh);
    }
    this.instanceMeshes = [];

    for (const mesh of this.propMeshes) {
      disposeMesh(this.scene, mesh);
    }
    this.propMeshes = [];

    this.generator.dispose();
  }
}
