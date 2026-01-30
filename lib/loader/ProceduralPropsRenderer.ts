/**
 * ProceduralPropsRenderer - Renders procedural props (tree, rock, bush, grass_clump)
 *
 * Uses ProceduralAssetGenerator to create identical meshes as the editor.
 * Supports both individual meshes and thin instancing for performance.
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

import {
  Scene,
  Mesh,
  Vector3,
  Matrix,
  Vector2,
} from "@babylonjs/core";
import type { ProceduralPropInstance } from "./types";
import { ProceduralAssetGenerator, GeneratorParams } from "./ProceduralAssetGenerator";

export interface ProceduralPropsRendererOptions {
  /** Use instancing for better performance (default: false - uses individual meshes to preserve unique params) */
  useInstancing?: boolean;
  /** LOD distance thresholds */
  lodDistances?: { near: number; mid: number; far: number };
  /** Wind direction in radians (default: PI/4 = 45 degrees) */
  windAngle?: number;
  /** Wind strength 0-1 (default: 0.5) */
  windStrength?: number;
}

export class ProceduralPropsRenderer {
  private scene: Scene;
  private options: Required<ProceduralPropsRendererOptions>;
  private generator: ProceduralAssetGenerator;

  // Individual meshes (preserves unique params)
  private propMeshes: Mesh[] = [];

  // Instancing (for performance when params similarity is acceptable)
  private baseMeshes: Map<string, Mesh> = new Map();
  private instanceMeshes: Map<string, Mesh> = new Map();

  private lastTime: number = 0;

  constructor(scene: Scene, options: ProceduralPropsRendererOptions = {}) {
    this.scene = scene;
    this.options = {
      useInstancing: options.useInstancing ?? false, // Default to individual for quality
      lodDistances: options.lodDistances ?? { near: 30, mid: 60, far: 120 },
      windAngle: options.windAngle ?? Math.PI / 4,
      windStrength: options.windStrength ?? 0.5,
    };

    this.generator = new ProceduralAssetGenerator(scene);
    this.generator.setWind(
      new Vector2(Math.cos(this.options.windAngle), Math.sin(this.options.windAngle)),
      this.options.windStrength
    );

    // Register time update for wind animation
    this.lastTime = performance.now();
    this.scene.registerBeforeRender(() => {
      const now = performance.now();
      const deltaTime = (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.generator.updateTime(deltaTime);
    });
  }

  /**
   * Load procedural props from decoded world data
   */
  loadProps(props: ProceduralPropInstance[]): void {
    if (props.length === 0) return;

    if (this.options.useInstancing) {
      this.loadPropsInstanced(props);
    } else {
      this.loadPropsIndividual(props);
    }

    console.log(`[ProceduralPropsRenderer] Loaded ${props.length} procedural props (instancing: ${this.options.useInstancing})`);
  }

  /**
   * Load props using thin instancing for better performance
   * Note: This mode uses shared base meshes, so individual params are not fully preserved
   */
  private loadPropsInstanced(props: ProceduralPropInstance[]): void {
    // Group by asset type
    const byType = new Map<string, ProceduralPropInstance[]>();

    for (const prop of props) {
      const type = prop.assetType;
      if (!byType.has(type)) {
        byType.set(type, []);
      }
      byType.get(type)!.push(prop);
    }

    // Create instance buffers for each type
    for (const [type, typeProps] of byType) {
      if (typeProps.length === 0) continue;

      // Create base mesh from first prop's params
      const firstProp = typeProps[0];
      const params: GeneratorParams = {
        type: firstProp.assetType,
        seed: firstProp.params.seed,
        size: 1.0, // Base size, scale applied via matrix
        sizeVariation: firstProp.params.sizeVariation,
        noiseScale: firstProp.params.noiseScale,
        noiseAmplitude: firstProp.params.noiseAmplitude,
        colorBase: firstProp.params.colorBase,
        colorDetail: firstProp.params.colorDetail,
      };

      const baseMesh = this.generator.generate(params);
      if (!baseMesh) continue;

      baseMesh.isVisible = false;
      this.baseMeshes.set(type, baseMesh);

      // Create instance mesh
      const instanceMesh = baseMesh.clone(`${type}_instances`);
      instanceMesh.isVisible = true;

      // Create material
      const material = this.generator.createMaterial(params);
      instanceMesh.material = material;

      // Build matrix buffer
      // Note: instance.scale already contains the final intended size
      // (params.size and scale are kept in sync in the editor)
      const matrices = new Float32Array(typeProps.length * 16);

      for (let i = 0; i < typeProps.length; i++) {
        const prop = typeProps[i];
        const matrix = Matrix.Compose(
          new Vector3(prop.scale.x, prop.scale.y, prop.scale.z),
          Vector3.Zero().toQuaternion(),
          new Vector3(prop.position.x, prop.position.y, prop.position.z)
        );
        matrix.copyToArray(matrices, i * 16);
      }

      instanceMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
      instanceMesh.thinInstanceCount = typeProps.length;
      instanceMesh.thinInstanceRefreshBoundingInfo();

      this.instanceMeshes.set(type, instanceMesh);
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
  private createPropMesh(prop: ProceduralPropInstance): Mesh | null {
    // Generate mesh at unit size (1.0) - actual scaling comes from instance.scale
    // In the editor, params.size and instance.scale are kept in sync,
    // so we ignore params.size and apply only instance.scale
    const params: GeneratorParams = {
      type: prop.assetType,
      seed: prop.params.seed,
      size: 1.0,  // Unit size - scaling handled by instance.scale below
      sizeVariation: prop.params.sizeVariation,
      noiseScale: prop.params.noiseScale,
      noiseAmplitude: prop.params.noiseAmplitude,
      colorBase: prop.params.colorBase,
      colorDetail: prop.params.colorDetail,
    };

    const mesh = this.generator.generate(params);
    if (!mesh) return null;

    // Apply material
    const material = this.generator.createMaterial(params);
    mesh.material = material;

    // Apply transform - instance.scale contains the final intended size
    mesh.position = new Vector3(prop.position.x, prop.position.y, prop.position.z);
    mesh.rotation = new Vector3(prop.rotation.x, prop.rotation.y, prop.rotation.z);
    mesh.scaling = new Vector3(prop.scale.x, prop.scale.y, prop.scale.z);

    mesh.name = `prop_${prop.id}`;

    return mesh;
  }

  /**
   * Set wind parameters
   */
  setWind(angleDegrees: number, strength: number): void {
    const angleRad = angleDegrees * Math.PI / 180;
    this.generator.setWind(
      new Vector2(Math.cos(angleRad), Math.sin(angleRad)),
      strength
    );
  }

  /**
   * Set visibility
   */
  setVisible(visible: boolean): void {
    for (const mesh of this.instanceMeshes.values()) {
      mesh.isVisible = visible;
    }
    for (const mesh of this.propMeshes) {
      mesh.isVisible = visible;
    }
  }

  /**
   * Get total prop count
   */
  getPropCount(): number {
    let count = this.propMeshes.length;
    for (const mesh of this.instanceMeshes.values()) {
      count += mesh.thinInstanceCount;
    }
    return count;
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (const mesh of this.baseMeshes.values()) {
      mesh.dispose();
    }
    this.baseMeshes.clear();

    for (const mesh of this.instanceMeshes.values()) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.instanceMeshes.clear();

    for (const mesh of this.propMeshes) {
      mesh.material?.dispose();
      mesh.dispose();
    }
    this.propMeshes = [];
  }
}
