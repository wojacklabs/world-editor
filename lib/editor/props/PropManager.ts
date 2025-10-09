import {
  Scene,
  Mesh,
  Vector3,
  Color3,
} from "@babylonjs/core";
import * as BABYLON from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";

export interface PropInstance {
  id: string;
  assetType: AssetType;
  params: AssetParams;
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
  mesh: Mesh | null;
}

export class PropManager {
  private scene: Scene;
  private heightmap: Heightmap;
  private instances: Map<string, PropInstance> = new Map();

  // Preview system
  private previewAsset: ProceduralAsset | null = null;
  private previewMesh: Mesh | null = null;
  private previewParams: AssetParams | null = null;
  private previewVisible = false;

  constructor(scene: Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
  }

  // Create or update the preview with given params
  createPreview(type: AssetType, size: number, seed?: number): void {
    // Dispose existing preview
    if (this.previewAsset) {
      this.previewAsset.dispose();
      this.previewAsset = null;
      this.previewMesh = null;
    }

    // Create new preview params
    this.previewParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      size,
      seed: seed ?? Math.random() * 10000,
    };

    // Generate preview asset
    this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
    this.previewMesh = this.previewAsset.generate();

    if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";
      this.previewMesh.isPickable = false;

      // Make semi-transparent
      if (this.previewMesh.material) {
        const mat = this.previewMesh.material as BABYLON.ShaderMaterial;
        mat.alpha = 0.8;
      }

      this.previewMesh.isVisible = this.previewVisible;
    }
  }

  // Randomize the preview (new seed)
  randomizePreview(): number {
    if (!this.previewParams) return 0;

    const newSeed = Math.random() * 10000;
    this.createPreview(this.previewParams.type, this.previewParams.size, newSeed);
    return newSeed;
  }

  // Update preview size (preserves position)
  updatePreviewSize(size: number): void {
    if (!this.previewParams || !this.previewMesh) return;

    // Just update the scale, don't recreate the mesh
    const scaleFactor = size / this.previewParams.size;
    this.previewMesh.scaling.scaleInPlace(scaleFactor);
    this.previewParams.size = size;
  }

  // Update preview with full asset params (from AI chat panel)
  updatePreviewAsset(params: {
    type: AssetType;
    seed: number;
    size: number;
    sizeVariation: number;
    noiseScale: number;
    noiseAmplitude: number;
    colorBase: Color3;
    colorDetail: Color3;
  }): void {
    // Dispose existing preview
    if (this.previewAsset) {
      this.previewAsset.dispose();
      this.previewAsset = null;
      this.previewMesh = null;
    }

    // Create new preview params with full customization
    this.previewParams = {
      type: params.type,
      seed: params.seed,
      size: params.size,
      sizeVariation: params.sizeVariation,
      noiseScale: params.noiseScale,
      noiseAmplitude: params.noiseAmplitude,
      colorBase: params.colorBase,
      colorDetail: params.colorDetail,
    };

    // Generate preview asset
    this.previewAsset = new ProceduralAsset(this.scene, this.previewParams);
    this.previewMesh = this.previewAsset.generate();

    if (this.previewMesh) {
      this.previewMesh.name = "preview_asset";
      this.previewMesh.isPickable = false;

      // Make semi-transparent
      if (this.previewMesh.material) {
        const mat = this.previewMesh.material as BABYLON.ShaderMaterial;
        mat.alpha = 0.8;
      }

      // Position at center of terrain initially
      const scale = this.heightmap.getScale();
      const centerX = scale / 2;
      const centerZ = scale / 2;
      const centerY = this.heightmap.getInterpolatedHeight(centerX, centerZ);
      this.previewMesh.position.set(centerX, centerY, centerZ);

      this.previewMesh.isVisible = true;
      this.previewVisible = true;
    }
  }

  // Update preview position (called on mouse move)
  updatePreviewPosition(x: number, z: number): void {
    if (!this.previewMesh) return;

    const y = this.heightmap.getInterpolatedHeight(x, z);
    this.previewMesh.position.set(x, y, z);
  }

  // Show/hide preview
  setPreviewVisible(visible: boolean): void {
    this.previewVisible = visible;
    if (this.previewMesh) {
      this.previewMesh.isVisible = visible;
    }
  }

  // Get current preview params
  getPreviewParams(): AssetParams | null {
    return this.previewParams ? { ...this.previewParams } : null;
  }

  // Place the current preview as a permanent prop
  // Returns { id, newSeed } so caller can update store
  placeCurrentPreview(): { id: string; newSeed: number } | null {
    if (!this.previewMesh || !this.previewParams || !this.previewAsset) return null;

    const x = this.previewMesh.position.x;
    const z = this.previewMesh.position.z;
    const y = this.heightmap.getInterpolatedHeight(x, z);

    const id = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Store params BEFORE randomizing
    const params = { ...this.previewParams };

    // Create a NEW asset with the SAME params (not clone, to get proper material)
    const placedAsset = new ProceduralAsset(this.scene, params);
    const placedMesh = placedAsset.generate();

    if (!placedMesh) return null;

    placedMesh.name = id;
    placedMesh.isPickable = true;

    // Copy position and rotation from preview (keep same orientation)
    placedMesh.position.set(x, y, z);
    placedMesh.rotation.copyFrom(this.previewMesh.rotation);
    placedMesh.scaling.copyFrom(this.previewMesh.scaling);

    // Store instance
    const instance: PropInstance = {
      id,
      assetType: params.type,
      params,
      position: new Vector3(x, y, z),
      rotation: placedMesh.rotation.clone(),
      scale: placedMesh.scaling.clone(),
      mesh: placedMesh,
    };

    this.instances.set(id, instance);

    // Create new preview with different seed for next placement
    const newSeed = this.randomizePreview();

    return { id, newSeed };
  }

  // Place a prop at the specified position (legacy method for compatibility)
  placeProp(
    assetType: string,
    x: number,
    z: number,
    customSettings?: { size?: number; seed?: number }
  ): string | null {
    const type = assetType as AssetType;
    if (!DEFAULT_ASSET_PARAMS[type]) return null;

    // If we have a preview, use its params
    if (this.previewParams && this.previewParams.type === type) {
      this.updatePreviewPosition(x, z);
      const result = this.placeCurrentPreview();
      return result ? result.id : null;
    }

    // Otherwise create new
    const y = this.heightmap.getInterpolatedHeight(x, z);
    const id = `prop_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const params: AssetParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      seed: customSettings?.seed ?? Math.random() * 10000,
      size: customSettings?.size ?? DEFAULT_ASSET_PARAMS[type].size,
    };

    const asset = new ProceduralAsset(this.scene, params);
    const mesh = asset.generate();

    if (!mesh) {
      asset.dispose();
      return null;
    }

    mesh.position.set(x, y, z);
    const rotationY = Math.random() * Math.PI * 2;
    mesh.rotation.y = rotationY;

    const instance: PropInstance = {
      id,
      assetType: type,
      params,
      position: new Vector3(x, y, z),
      rotation: new Vector3(0, rotationY, 0),
      scale: mesh.scaling.clone(),
      mesh,
    };

    this.instances.set(id, instance);
    return id;
  }

  // Remove a prop by ID
  removeProp(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;

    if (instance.mesh) {
      instance.mesh.dispose();
    }
    this.instances.delete(id);
    return true;
  }

  // Get all instances
  getAllInstances(): PropInstance[] {
    return Array.from(this.instances.values());
  }

  // Get instance by ID
  getInstance(id: string): PropInstance | undefined {
    return this.instances.get(id);
  }

  // Clear all props
  clearAll(): void {
    for (const instance of this.instances.values()) {
      if (instance.mesh) {
        instance.mesh.dispose();
      }
    }
    this.instances.clear();
  }

  // Export instances for saving
  exportInstances(): any[] {
    return Array.from(this.instances.values()).map((inst) => ({
      id: inst.id,
      assetType: inst.assetType,
      params: {
        type: inst.params.type,
        seed: inst.params.seed,
        size: inst.params.size,
        sizeVariation: inst.params.sizeVariation,
        noiseScale: inst.params.noiseScale,
        noiseAmplitude: inst.params.noiseAmplitude,
        colorBase: {
          r: inst.params.colorBase.r,
          g: inst.params.colorBase.g,
          b: inst.params.colorBase.b,
        },
        colorDetail: {
          r: inst.params.colorDetail.r,
          g: inst.params.colorDetail.g,
          b: inst.params.colorDetail.b,
        },
      },
      position: { x: inst.position.x, y: inst.position.y, z: inst.position.z },
      rotation: { x: inst.rotation.x, y: inst.rotation.y, z: inst.rotation.z },
      scale: { x: inst.scale.x, y: inst.scale.y, z: inst.scale.z },
    }));
  }

  dispose(): void {
    this.clearAll();

    if (this.previewAsset) {
      this.previewAsset.dispose();
      this.previewAsset = null;
      this.previewMesh = null;
    }
  }
}
