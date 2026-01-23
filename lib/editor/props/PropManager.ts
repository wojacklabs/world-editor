import {
  Scene,
  Mesh,
  Vector3,
  Matrix,
  Color3,
  ShaderMaterial,
  Effect,
  VertexBuffer,
} from "@babylonjs/core";
import * as BABYLON from "@babylonjs/core";
import { Heightmap } from "../terrain/Heightmap";
import { ProceduralAsset, AssetParams, AssetType, DEFAULT_ASSET_PARAMS } from "./ProceduralAsset";

// ============================================
// Thin instance shaders for props (supports world0-world3 attributes)
// ============================================
Effect.ShadersStore["propThinVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

// Thin instance world matrix (4 columns as vec4 attributes)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    // Reconstruct world matrix from thin instance attributes
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);

    gl_Position = viewProjection * worldPos;

    vNormal = normalize(mat3(worldMatrix) * normal);
    vPosition = worldPos.xyz;
    vLocalPosition = position;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

Effect.ShadersStore["propThinFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

// 3D noise functions for per-pixel detail
float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));

    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec3 normal = normalize(vNormal);

    // Color variation (per-pixel)
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(baseColor, detailColor, colorNoise * 0.5);

    // Half-Lambert diffuse
    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.25;

    // Ambient occlusion approximation
    float ao = 0.5 + 0.5 * normal.y;

    // Final lighting
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity) * ao;
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.85, 1.0);

    color = color * (ambient + diffuse) + rim;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

// Wind-enabled thin instance shader for foliage props
Effect.ShadersStore["propThinWindVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
attribute vec4 color;

// Thin instance world matrix (4 columns as vec4 attributes)
attribute vec4 world0;
attribute vec4 world1;
attribute vec4 world2;
attribute vec4 world3;

uniform mat4 viewProjection;
uniform vec3 cameraPosition;
uniform float uTime;
uniform vec2 uWindDirection;
uniform float uWindStrength;
uniform float uMinWindHeight;
uniform float uMaxWindHeight;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void main() {
    // Reconstruct world matrix from thin instance attributes
    mat4 worldMatrix = mat4(world0, world1, world2, world3);
    vec4 worldPos = worldMatrix * vec4(position, 1.0);
    vec3 localPos = position;

    // Height factor for wind
    float heightAboveMin = max(0.0, localPos.y - uMinWindHeight);
    float heightRange = max(0.01, uMaxWindHeight - uMinWindHeight);
    float heightFactor = clamp(heightAboveMin / heightRange, 0.0, 1.0);
    heightFactor = heightFactor * heightFactor;

    // Wind wave
    vec2 worldPosXZ = worldPos.xz;
    float windPhase = dot(worldPosXZ, uWindDirection) * 0.5 + uTime * 2.0;
    float primaryWave = sin(windPhase) * 0.5 + 0.5;
    float secondaryPhase = dot(worldPosXZ, uWindDirection) * 2.0 + uTime * 5.0;
    float secondaryWave = sin(secondaryPhase) * 0.3 + 0.5;
    float noiseVal = noise2D(worldPosXZ * 0.3 + uTime * 0.2);
    float windAmount = (primaryWave * 0.7 + secondaryWave * 0.3 + noiseVal * 0.2) * heightFactor * uWindStrength;

    // Apply wind displacement
    localPos.x += uWindDirection.x * windAmount * 0.15;
    localPos.z += uWindDirection.y * windAmount * 0.15;
    localPos.y -= windAmount * 0.03;

    vec4 finalWorldPos = worldMatrix * vec4(localPos, 1.0);
    gl_Position = viewProjection * finalWorldPos;

    vNormal = normalize(mat3(worldMatrix) * normal);
    vPosition = finalWorldPos.xyz;
    vLocalPosition = localPos;
    vUV = uv;
    vCameraDistance = length(cameraPosition - finalWorldPos.xyz);
    vViewDirection = normalize(cameraPosition - finalWorldPos.xyz);
    vColor = color;
}
`;

Effect.ShadersStore["propThinWindFragmentShader"] = `
precision highp float;

uniform vec3 baseColor;
uniform vec3 detailColor;
uniform vec3 sunDirection;
uniform float ambientIntensity;
uniform vec3 fogColor;
uniform float fogDensity;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec3 vLocalPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;
varying vec4 vColor;

float hash3D(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

float noise3D(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);

    float n000 = hash3D(i);
    float n100 = hash3D(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash3D(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash3D(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash3D(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash3D(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash3D(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash3D(i + vec3(1.0, 1.0, 1.0));

    vec4 n_z0 = vec4(n000, n100, n010, n110);
    vec4 n_z1 = vec4(n001, n101, n011, n111);
    vec4 n_zz = mix(n_z0, n_z1, f.z);
    vec2 n_y = mix(n_zz.xy, n_zz.zw, f.y);
    return mix(n_y.x, n_y.y, f.x);
}

float fbm(vec3 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 3; i++) {
        value += amplitude * noise3D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec3 normal = normalize(vNormal);

    // Use vertex color if available, otherwise use baseColor
    vec3 meshColor = vColor.a > 0.5 ? vColor.rgb : baseColor;

    // Color variation
    float colorNoise = fbm(vPosition * 2.0);
    vec3 color = mix(meshColor, meshColor * 0.8, colorNoise * 0.3);

    // Height-based color (tips lighter)
    float tipFactor = smoothstep(0.0, 0.6, vLocalPosition.y);
    float isLeaf = vColor.g > vColor.r ? 1.0 : 0.3;
    color = mix(color * 0.85, color * 1.1, tipFactor * isLeaf);

    // Half-Lambert diffuse
    float NdotL = dot(normal, sunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.2;

    // Subsurface scattering approximation
    float sss = max(0.0, dot(-vViewDirection, sunDirection)) * tipFactor * 0.15;

    // Final lighting
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(ambientIntensity);
    vec3 rim = vec3(rimFactor) * vec3(0.8, 0.9, 1.0);

    color = color * (ambient + diffuse) + rim + vec3(0.1, 0.15, 0.05) * sss;

    // Fog
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, fogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

// LOD level for props visibility
export enum PropLOD {
  Near = 0,   // All props visible
  Mid = 1,    // Medium/large props only
  Far = 2,    // Large props only (landmarks)
}

// Number of variations per asset type for thin instancing
const VARIATIONS_PER_TYPE = 8;

// Thin instancing group key: "assetType_variationIndex"
type InstanceGroupKey = string;

export interface PropInstance {
  id: string;
  assetType: AssetType;
  variationIndex: number;  // Which variation mesh to use
  params: AssetParams;
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
  visible: boolean;  // For LOD-based visibility
}

export class PropManager {
  private scene: Scene;
  private heightmap: Heightmap;
  private instances: Map<string, PropInstance> = new Map();

  // Thin instancing: base variation meshes per type
  private variationMeshes: Map<AssetType, Mesh[]> = new Map();
  // Thin instancing: shared materials per type
  private sharedMaterials: Map<AssetType, ShaderMaterial> = new Map();
  // Thin instancing: group meshes for thin instances
  private instanceGroups: Map<InstanceGroupKey, Mesh> = new Map();
  // Track which props belong to which group
  private propsByGroup: Map<InstanceGroupKey, Set<string>> = new Map();
  // Dirty flag to rebuild instance buffers
  private dirtyGroups: Set<InstanceGroupKey> = new Set();

  // Tile-based grouping for streaming
  private propsByTile: Map<string, Set<string>> = new Map();  // tileKey -> Set<propId>
  private tileSize: number = 64;  // Default tile size

  // Preview system
  private previewAsset: ProceduralAsset | null = null;
  private previewMesh: Mesh | null = null;
  private previewParams: AssetParams | null = null;
  private previewVisible = false;

  constructor(scene: Scene, heightmap: Heightmap) {
    this.scene = scene;
    this.heightmap = heightmap;
    this.initializeVariations();
  }

  /**
   * Initialize base variation meshes for each asset type
   * These are template meshes used for thin instancing
   */
  private initializeVariations(): void {
    const assetTypes: AssetType[] = ["rock", "tree", "bush", "grass_clump"];

    for (const assetType of assetTypes) {
      const variations: Mesh[] = [];

      // Create N variation meshes with fixed seeds
      for (let i = 0; i < VARIATIONS_PER_TYPE; i++) {
        const seed = i * 1000 + 42;  // Fixed seeds for consistent variations
        const params: AssetParams = {
          ...DEFAULT_ASSET_PARAMS[assetType],
          seed,
          size: 1.0,  // Base size 1.0, scaling applied via instance matrix
        };

        const asset = new ProceduralAsset(this.scene, params);
        const mesh = asset.generate();

        if (mesh) {
          mesh.name = `${assetType}_variation_${i}`;
          mesh.isVisible = false;  // Template mesh is invisible
          mesh.isPickable = false;

          // Detach material from this template (we'll use shared material)
          mesh.material = null;

          variations.push(mesh);
        }
      }

      this.variationMeshes.set(assetType, variations);

      // Create shared material for this type
      const material = this.createSharedMaterial(assetType);
      this.sharedMaterials.set(assetType, material);
    }

    console.log(`[PropManager] Initialized ${assetTypes.length} asset types with ${VARIATIONS_PER_TYPE} variations each`);
  }

  /**
   * Create shared material for thin instanced props
   */
  private createSharedMaterial(assetType: AssetType): ShaderMaterial {
    const needsWind = assetType !== "rock";
    const defaultParams = DEFAULT_ASSET_PARAMS[assetType];

    let material: ShaderMaterial;

    if (needsWind) {
      // Use thin instance wind shader for foliage
      material = new ShaderMaterial(
        `prop_thin_wind_${assetType}`,
        this.scene,
        {
          vertex: "propThinWind",
          fragment: "propThinWind",
        },
        {
          attributes: ["position", "normal", "uv", "color", "world0", "world1", "world2", "world3"],
          uniforms: [
            "viewProjection",
            "cameraPosition",
            "uTime",
            "uWindDirection",
            "uWindStrength",
            "uMinWindHeight",
            "uMaxWindHeight",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
          ],
        }
      );

      // Wind settings
      const windAngle = Math.PI * 0.25;
      material.setVector2("uWindDirection", new BABYLON.Vector2(
        Math.cos(windAngle),
        Math.sin(windAngle)
      ));

      // Wind settings by type
      let windStrength = 0.5;
      let minWindHeight = 0.0;
      let maxWindHeight = 0.8;

      if (assetType === "grass_clump") {
        windStrength = 0.8;
        minWindHeight = 0.0;
        maxWindHeight = 0.7;
      } else if (assetType === "bush") {
        windStrength = 0.4;
        minWindHeight = 0.0;
        maxWindHeight = 0.3;
      } else if (assetType === "tree") {
        windStrength = 0.35;
        minWindHeight = 0.5;
        maxWindHeight = 2.0;
      }

      material.setFloat("uWindStrength", windStrength);
      material.setFloat("uMinWindHeight", minWindHeight);
      material.setFloat("uMaxWindHeight", maxWindHeight);
      material.setFloat("uTime", 0);
    } else {
      // Rock uses thin instance static shader
      material = new ShaderMaterial(
        `prop_thin_${assetType}`,
        this.scene,
        {
          vertex: "propThin",
          fragment: "propThin",
        },
        {
          attributes: ["position", "normal", "uv", "world0", "world1", "world2", "world3"],
          uniforms: [
            "viewProjection",
            "cameraPosition",
            "baseColor",
            "detailColor",
            "sunDirection",
            "ambientIntensity",
            "fogColor",
            "fogDensity",
          ],
        }
      );
    }

    // Common uniforms
    material.setColor3("baseColor", defaultParams.colorBase);
    material.setColor3("detailColor", defaultParams.colorDetail);
    material.setVector3("sunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    material.setFloat("ambientIntensity", 0.4);
    material.setColor3("fogColor", new Color3(0.6, 0.75, 0.9));
    material.setFloat("fogDensity", 0.008);
    material.backFaceCulling = false;

    // Update camera position and time on each render
    const startTime = performance.now();
    material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera) {
        material.setVector3("cameraPosition", camera.position);
        if (needsWind) {
          const elapsed = (performance.now() - startTime) / 1000;
          material.setFloat("uTime", elapsed);
        }
      }
    });

    return material;
  }

  /**
   * Get variation index from seed
   */
  private getVariationIndex(seed: number): number {
    return Math.floor(Math.abs(seed)) % VARIATIONS_PER_TYPE;
  }

  /**
   * Get instance group key
   */
  private getGroupKey(assetType: AssetType, variationIndex: number): InstanceGroupKey {
    return `${assetType}_${variationIndex}`;
  }

  /**
   * Set tile size for streaming grouping
   */
  setTileSize(tileSize: number): void {
    this.tileSize = tileSize;
  }

  /**
   * Get tile key for a world position
   */
  private getTileKey(x: number, z: number): string {
    const gridX = Math.floor(x / this.tileSize);
    const gridZ = Math.floor(z / this.tileSize);
    return `${gridX}_${gridZ}`;
  }

  /**
   * Register prop to tile group
   */
  private registerPropToTile(propId: string, x: number, z: number): void {
    const tileKey = this.getTileKey(x, z);
    let tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) {
      tileProps = new Set();
      this.propsByTile.set(tileKey, tileProps);
    }
    tileProps.add(propId);
  }

  /**
   * Unregister prop from tile group
   */
  private unregisterPropFromTile(propId: string): void {
    const instance = this.instances.get(propId);
    if (!instance) return;
    const tileKey = this.getTileKey(instance.position.x, instance.position.z);
    const tileProps = this.propsByTile.get(tileKey);
    if (tileProps) {
      tileProps.delete(propId);
      if (tileProps.size === 0) {
        this.propsByTile.delete(tileKey);
      }
    }
  }

  /**
   * Unload all props for a specific tile (for streaming)
   */
  unloadPropsForTile(gridX: number, gridY: number): void {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return;

    const dirtyGroupsSet = new Set<InstanceGroupKey>();

    // Remove all props in this tile
    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (instance) {
        // Unregister from instance group
        const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
        const groupProps = this.propsByGroup.get(groupKey);
        if (groupProps) {
          groupProps.delete(propId);
          dirtyGroupsSet.add(groupKey);
        }
        this.instances.delete(propId);
      }
    }
    this.propsByTile.delete(tileKey);

    // Mark affected groups dirty and rebuild
    for (const groupKey of dirtyGroupsSet) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    console.log(`[PropManager] Unloaded ${tileProps.size} props for tile (${gridX},${gridY})`);
  }

  /**
   * Get props for a specific tile
   */
  getPropsForTile(gridX: number, gridY: number): PropInstance[] {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return [];

    const result: PropInstance[] = [];
    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (instance) {
        result.push(instance);
      }
    }
    return result;
  }

  /**
   * Update LOD for props in a specific tile
   * Near: all props visible, Mid: medium/large only, Far: large only
   */
  updateTileLOD(gridX: number, gridY: number, lod: PropLOD): void {
    const tileKey = `${gridX}_${gridY}`;
    const tileProps = this.propsByTile.get(tileKey);
    if (!tileProps) return;

    let visibleCount = 0;
    let hiddenCount = 0;
    const affectedGroups = new Set<InstanceGroupKey>();

    for (const propId of tileProps) {
      const instance = this.instances.get(propId);
      if (!instance) continue;

      const size = instance.params.size;
      const shouldBeVisible = this.shouldPropBeVisible(size, lod);

      if (instance.visible !== shouldBeVisible) {
        instance.visible = shouldBeVisible;
        const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
        affectedGroups.add(groupKey);

        if (shouldBeVisible) {
          visibleCount++;
        } else {
          hiddenCount++;
        }
      }
    }

    // Mark affected groups dirty and rebuild
    for (const groupKey of affectedGroups) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    if (visibleCount > 0 || hiddenCount > 0) {
      console.log(`[PropManager] Tile (${gridX},${gridY}) LOD=${PropLOD[lod]}: ${visibleCount} visible, ${hiddenCount} hidden`);
    }
  }

  /**
   * Determine if a prop should be visible based on size and LOD
   */
  private shouldPropBeVisible(size: number, lod: PropLOD): boolean {
    switch (lod) {
      case PropLOD.Near:
        return true;  // All props visible
      case PropLOD.Mid:
        return size >= 0.5;  // Medium/large props only (size >= 0.5)
      case PropLOD.Far:
        return size >= 1.0;  // Large props only (landmarks, size >= 1.0)
      default:
        return true;
    }
  }

  /**
   * Get loaded tile keys
   */
  getLoadedTileKeys(): string[] {
    return Array.from(this.propsByTile.keys());
  }

  /**
   * Mark a group as dirty (needs rebuild)
   */
  private markGroupDirty(groupKey: InstanceGroupKey): void {
    this.dirtyGroups.add(groupKey);
  }

  /**
   * Rebuild all dirty instance groups
   */
  rebuildDirtyGroups(): void {
    for (const groupKey of this.dirtyGroups) {
      this.rebuildInstanceGroup(groupKey);
    }
    this.dirtyGroups.clear();
  }

  /**
   * Rebuild a single instance group's thin instance buffer
   */
  private rebuildInstanceGroup(groupKey: InstanceGroupKey): void {
    const propIds = this.propsByGroup.get(groupKey);
    const [assetType, variationIndexStr] = groupKey.split("_") as [AssetType, string];
    const variationIndex = parseInt(variationIndexStr, 10);

    // Get variation mesh
    const variations = this.variationMeshes.get(assetType);
    if (!variations || !variations[variationIndex]) return;

    const baseMesh = variations[variationIndex];

    // Get or create instance group mesh
    let groupMesh = this.instanceGroups.get(groupKey);

    if (!propIds || propIds.size === 0) {
      // No props in group - hide or dispose group mesh
      if (groupMesh) {
        groupMesh.isVisible = false;
        groupMesh.thinInstanceCount = 0;
      }
      return;
    }

    // Create group mesh if needed
    if (!groupMesh) {
      groupMesh = baseMesh.clone(`inst_${groupKey}`, null);
      if (!groupMesh) return;

      groupMesh.makeGeometryUnique();
      groupMesh.isPickable = true;

      // Apply shared material
      const material = this.sharedMaterials.get(assetType);
      if (material) {
        groupMesh.material = material;
      }

      this.instanceGroups.set(groupKey, groupMesh);
    }

    // Count visible instances first
    let visibleCount = 0;
    for (const propId of propIds) {
      const instance = this.instances.get(propId);
      if (instance && instance.visible) {
        visibleCount++;
      }
    }

    if (visibleCount === 0) {
      // No visible props in group
      groupMesh.isVisible = false;
      groupMesh.thinInstanceCount = 0;
      return;
    }

    // Build instance matrices for visible instances only
    const matrices = new Float32Array(visibleCount * 16);
    let index = 0;

    for (const propId of propIds) {
      const instance = this.instances.get(propId);
      if (!instance || !instance.visible) continue;

      // Build transform matrix
      const matrix = Matrix.Compose(
        instance.scale,
        BABYLON.Quaternion.FromEulerAngles(
          instance.rotation.x,
          instance.rotation.y,
          instance.rotation.z
        ),
        instance.position
      );

      matrix.copyToArray(matrices, index * 16);
      index++;
    }

    // Apply thin instances
    groupMesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
    groupMesh.thinInstanceCount = index;
    groupMesh.thinInstanceRefreshBoundingInfo();
    groupMesh.isVisible = true;
  }

  /**
   * Get mesh at a world position (for picking)
   */
  getInstanceAtPosition(worldX: number, worldZ: number, tolerance: number = 0.5): PropInstance | null {
    let closest: PropInstance | null = null;
    let closestDist = tolerance;

    for (const instance of this.instances.values()) {
      const dx = instance.position.x - worldX;
      const dz = instance.position.z - worldZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < closestDist) {
        closestDist = dist;
        closest = instance;
      }
    }

    return closest;
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
    const variationIndex = this.getVariationIndex(params.seed);
    const groupKey = this.getGroupKey(params.type, variationIndex);

    // Store instance (no mesh - managed by thin instancing)
    const instance: PropInstance = {
      id,
      assetType: params.type,
      variationIndex,
      params,
      position: new Vector3(x, y, z),
      rotation: this.previewMesh.rotation.clone(),
      scale: this.previewMesh.scaling.clone(),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for thin instancing
    let groupProps = this.propsByGroup.get(groupKey);
    if (!groupProps) {
      groupProps = new Set();
      this.propsByGroup.set(groupKey, groupProps);
    }
    groupProps.add(id);

    // Register to tile group for streaming
    this.registerPropToTile(id, x, z);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

    // Create new preview with different seed for next placement
    const newSeed = this.randomizePreview();

    return { id, newSeed };
  }

  // Place a prop at the specified position
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

    const seed = customSettings?.seed ?? Math.random() * 10000;
    const size = customSettings?.size ?? DEFAULT_ASSET_PARAMS[type].size;
    const variationIndex = this.getVariationIndex(seed);
    const groupKey = this.getGroupKey(type, variationIndex);

    const params: AssetParams = {
      ...DEFAULT_ASSET_PARAMS[type],
      type,
      seed,
      size,
    };

    const rotationY = Math.random() * Math.PI * 2;

    const instance: PropInstance = {
      id,
      assetType: type,
      variationIndex,
      params,
      position: new Vector3(x, y, z),
      rotation: new Vector3(0, rotationY, 0),
      scale: new Vector3(size, size, size),
      visible: true,
    };

    this.instances.set(id, instance);

    // Register to group for thin instancing
    let groupProps = this.propsByGroup.get(groupKey);
    if (!groupProps) {
      groupProps = new Set();
      this.propsByGroup.set(groupKey, groupProps);
    }
    groupProps.add(id);

    // Register to tile group for streaming
    this.registerPropToTile(id, x, z);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

    return id;
  }

  // Remove a prop by ID
  removeProp(id: string): boolean {
    const instance = this.instances.get(id);
    if (!instance) return false;

    // Unregister from tile group
    this.unregisterPropFromTile(id);

    // Unregister from instance group
    const groupKey = this.getGroupKey(instance.assetType, instance.variationIndex);
    const groupProps = this.propsByGroup.get(groupKey);
    if (groupProps) {
      groupProps.delete(id);
    }

    this.instances.delete(id);

    // Mark group dirty and rebuild
    this.markGroupDirty(groupKey);
    this.rebuildDirtyGroups();

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
    this.instances.clear();
    this.propsByTile.clear();
    this.propsByGroup.clear();
    this.dirtyGroups.clear();

    // Hide all instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.isVisible = false;
      groupMesh.thinInstanceCount = 0;
    }
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

  // Import instances from saved data
  importInstances(data: any[]): void {
    // Clear existing
    this.clearAll();

    const affectedGroups = new Set<InstanceGroupKey>();

    for (const item of data) {
      const params: AssetParams = {
        type: item.params.type,
        seed: item.params.seed,
        size: item.params.size,
        sizeVariation: item.params.sizeVariation,
        noiseScale: item.params.noiseScale,
        noiseAmplitude: item.params.noiseAmplitude,
        colorBase: new Color3(
          item.params.colorBase.r,
          item.params.colorBase.g,
          item.params.colorBase.b
        ),
        colorDetail: new Color3(
          item.params.colorDetail.r,
          item.params.colorDetail.g,
          item.params.colorDetail.b
        ),
      };

      const variationIndex = this.getVariationIndex(params.seed);
      const groupKey = this.getGroupKey(params.type, variationIndex);

      const instance: PropInstance = {
        id: item.id,
        assetType: item.assetType,
        variationIndex,
        params,
        position: new Vector3(item.position.x, item.position.y, item.position.z),
        rotation: new Vector3(item.rotation.x, item.rotation.y, item.rotation.z),
        scale: new Vector3(item.scale.x, item.scale.y, item.scale.z),
        visible: true,
      };

      this.instances.set(item.id, instance);

      // Register to group
      let groupProps = this.propsByGroup.get(groupKey);
      if (!groupProps) {
        groupProps = new Set();
        this.propsByGroup.set(groupKey, groupProps);
      }
      groupProps.add(item.id);
      affectedGroups.add(groupKey);

      // Register to tile
      this.registerPropToTile(item.id, item.position.x, item.position.z);
    }

    // Rebuild all affected groups at once
    for (const groupKey of affectedGroups) {
      this.markGroupDirty(groupKey);
    }
    this.rebuildDirtyGroups();

    console.log(`[PropManager] Imported ${data.length} props using thin instancing`);
  }

  dispose(): void {
    this.clearAll();

    // Dispose preview
    if (this.previewAsset) {
      this.previewAsset.dispose();
      this.previewAsset = null;
      this.previewMesh = null;
    }

    // Dispose instance group meshes
    for (const groupMesh of this.instanceGroups.values()) {
      groupMesh.dispose();
    }
    this.instanceGroups.clear();

    // Dispose variation meshes
    for (const variations of this.variationMeshes.values()) {
      for (const mesh of variations) {
        mesh.dispose();
      }
    }
    this.variationMeshes.clear();

    // Dispose shared materials
    for (const material of this.sharedMaterials.values()) {
      material.dispose();
    }
    this.sharedMaterials.clear();
  }
}
