import * as THREE from "three";
import { disposeMesh } from "../../shared/rendering/threeHelpers";

/**
 * Impostor configuration for a single object type
 */
export interface ImpostorConfig {
  name: string;
  sourceMesh: THREE.Mesh | null;        // Source 3D mesh to capture
  textureSize: number;                   // Resolution of impostor texture (e.g., 256)
  viewAngles: number;                    // Number of view angles (e.g., 8 for octagonal)
  transitionStart: number;               // Distance to start transition (e.g., 80)
  transitionEnd: number;                 // Distance to fully switch to impostor (e.g., 100)
}

/**
 * Impostor instance data
 */
interface ImpostorInstance {
  position: THREE.Vector3;
  scale: number;
  rotation: number;
}

/**
 * Cached impostor data for a type
 */
interface ImpostorCache {
  config: ImpostorConfig;
  atlasTexture: THREE.WebGLRenderTarget | null;  // Multi-angle atlas
  billboardMesh: THREE.InstancedMesh | null;      // Instanced billboard mesh
  instances: ImpostorInstance[];                   // All instances
  matrixBuffer: Float32Array | null;               // Instance matrices
}

// Impostor billboard vertex shader
const impostorVertexShader = `
precision highp float;

uniform vec3 uCameraPosition;
uniform float uAtlasColumns;
uniform float uAtlasRows;

varying vec2 vUV;
varying float vFade;

void main() {
    // Get instance world position from matrix
    vec4 worldPos = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);

    // Billboard facing - rotate quad to face camera
    vec3 toCamera = normalize(uCameraPosition - worldPos.xyz);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(up, toCamera));
    vec3 forward = cross(right, up);

    // Extract scale from instance matrix
    float scaleX = length(vec3(instanceMatrix[0][0], instanceMatrix[0][1], instanceMatrix[0][2]));
    float scaleY = length(vec3(instanceMatrix[1][0], instanceMatrix[1][1], instanceMatrix[1][2]));

    // Apply billboard rotation
    vec3 billboardPos = worldPos.xyz
        + right * position.x * scaleX
        + up * position.y * scaleY;

    gl_Position = projectionMatrix * viewMatrix * vec4(billboardPos, 1.0);

    // Calculate view angle for atlas UV selection
    float angle = atan(toCamera.z, toCamera.x);
    float normalizedAngle = (angle + 3.14159) / (2.0 * 3.14159);  // 0-1
    float atlasColumn = floor(normalizedAngle * uAtlasColumns);
    atlasColumn = mod(atlasColumn, uAtlasColumns);

    // Calculate UV within atlas
    float uvScale = 1.0 / uAtlasColumns;
    vUV = vec2(
        (atlasColumn + uv.x) * uvScale,
        uv.y / uAtlasRows
    );

    // Distance fade for transition
    float dist = length(uCameraPosition - worldPos.xyz);
    vFade = 1.0;  // Could be used for distance-based fade
}
`;

const impostorFragmentShader = `
precision highp float;

uniform sampler2D uImpostorAtlas;
uniform vec3 uSunDirection;
uniform float uAmbient;

varying vec2 vUV;
varying float vFade;

void main() {
    vec4 texColor = texture2D(uImpostorAtlas, vUV);

    // Alpha test
    if (texColor.a < 0.1) discard;

    // Simple lighting
    float light = uAmbient + 0.5;
    vec3 color = texColor.rgb * light;

    gl_FragColor = vec4(color, texColor.a * vFade);
}
`;

/**
 * ImpostorSystem - Manages billboard impostors for distant objects
 *
 * Features:
 * - Renders 3D meshes to multi-angle atlas textures
 * - Uses billboards with view-angle selection for distant objects
 * - Smooth transition between 3D and impostor
 * - InstancedMesh based for performance
 */
export class ImpostorSystem {
  private scene: THREE.Scene;
  private impostorCache: Map<string, ImpostorCache> = new Map();
  private impostorMaterial: THREE.ShaderMaterial | null = null;
  private captureCamera: THREE.PerspectiveCamera | null = null;

  // Default settings
  private defaultTextureSize = 256;
  private defaultViewAngles = 8;
  private defaultTransitionStart = 80;
  private defaultTransitionEnd = 100;

  // Shared geometry for all billboard instances
  private billboardGeometry: THREE.PlaneGeometry | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.createImpostorMaterial();
    this.setupCaptureCamera();
    this.createBillboardGeometry();
  }

  /**
   * Create shared billboard geometry (offset to bottom center)
   */
  private createBillboardGeometry(): void {
    this.billboardGeometry = new THREE.PlaneGeometry(1, 1);
    this.billboardGeometry.translate(0, 0.5, 0);
  }

  /**
   * Create shared impostor material
   */
  private createImpostorMaterial(): void {
    this.impostorMaterial = new THREE.ShaderMaterial({
      vertexShader: impostorVertexShader,
      fragmentShader: impostorFragmentShader,
      uniforms: {
        uCameraPosition: { value: new THREE.Vector3() },
        uAtlasColumns: { value: this.defaultViewAngles },
        uAtlasRows: { value: 1 },
        uSunDirection: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uAmbient: { value: 0.4 },
        uImpostorAtlas: { value: null as THREE.Texture | null },
      },
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  /**
   * Setup camera for capturing impostor textures
   */
  private setupCaptureCamera(): void {
    this.captureCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.captureCamera.position.set(0, 0, 5);
    this.captureCamera.lookAt(0, 0, 0);
  }

  /**
   * Update camera position uniform for billboard facing.
   * Call this each frame to keep billboards facing the camera.
   */
  updateCameraPosition(cameraPosition: THREE.Vector3): void {
    if (this.impostorMaterial) {
      this.impostorMaterial.uniforms.uCameraPosition.value.copy(cameraPosition);
    }
    // Also update per-type cloned materials
    for (const [, cache] of this.impostorCache) {
      if (cache.billboardMesh && cache.billboardMesh.material instanceof THREE.ShaderMaterial) {
        cache.billboardMesh.material.uniforms.uCameraPosition.value.copy(cameraPosition);
      }
    }
  }

  /**
   * Register a mesh type for impostor generation
   */
  registerImpostor(config: Partial<ImpostorConfig> & { name: string; sourceMesh: THREE.Mesh }): void {
    const fullConfig: ImpostorConfig = {
      textureSize: config.textureSize || this.defaultTextureSize,
      viewAngles: config.viewAngles || this.defaultViewAngles,
      transitionStart: config.transitionStart || this.defaultTransitionStart,
      transitionEnd: config.transitionEnd || this.defaultTransitionEnd,
      ...config,
    };

    const cache: ImpostorCache = {
      config: fullConfig,
      atlasTexture: null,
      billboardMesh: null,
      instances: [],
      matrixBuffer: null,
    };

    this.impostorCache.set(config.name, cache);

    // Generate atlas texture from source mesh
    this.generateAtlasTexture(cache);

    console.log(`[ImpostorSystem] Registered impostor: ${config.name}`);
  }

  /**
   * Generate multi-angle atlas texture from source mesh
   */
  private generateAtlasTexture(cache: ImpostorCache): void {
    const config = cache.config;
    if (!config.sourceMesh) return;

    const atlasWidth = config.textureSize * config.viewAngles;
    const atlasHeight = config.textureSize;

    // Create render target for atlas
    const renderTarget = new THREE.WebGLRenderTarget(atlasWidth, atlasHeight, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      colorSpace: THREE.SRGBColorSpace,
    });

    cache.atlasTexture = renderTarget;

    // Calculate mesh bounds for camera positioning
    const sourceMesh = config.sourceMesh;
    sourceMesh.updateMatrixWorld(true);
    sourceMesh.geometry.computeBoundingBox();
    const box = sourceMesh.geometry.boundingBox!;
    const min = box.min.clone().applyMatrix4(sourceMesh.matrixWorld);
    const max = box.max.clone().applyMatrix4(sourceMesh.matrixWorld);
    const meshSize = max.clone().sub(min);
    const maxDimension = Math.max(meshSize.x, meshSize.y, meshSize.z);
    const cameraDistance = maxDimension * 2;

    if (this.captureCamera) {
      const center = min.clone().add(max).multiplyScalar(0.5);
      this.captureCamera.position.set(center.x, center.y, center.z + cameraDistance);
      this.captureCamera.lookAt(center);
    }

    // For now, simplified single-angle capture
    // Full implementation would render multiple angles to atlas regions
    // Rendering to target requires manual renderer.setRenderTarget() calls

    console.log(`[ImpostorSystem] Generated atlas texture for ${config.name}: ${atlasWidth}x${atlasHeight}`);
  }

  /**
   * Create billboard InstancedMesh for a cache entry
   */
  private createBillboardMesh(cache: ImpostorCache, count: number): void {
    if (!this.billboardGeometry || !this.impostorMaterial) return;

    // Clone material for this type so each has its own atlas texture
    const material = this.impostorMaterial.clone();
    if (cache.atlasTexture) {
      material.uniforms.uImpostorAtlas.value = cache.atlasTexture.texture;
    }

    const instMesh = new THREE.InstancedMesh(this.billboardGeometry, material, count);
    instMesh.count = count;
    instMesh.visible = true;

    this.scene.add(instMesh);
    cache.billboardMesh = instMesh;
  }

  /**
   * Add instances for a registered impostor type
   */
  addInstances(typeName: string, instances: ImpostorInstance[]): void {
    const cache = this.impostorCache.get(typeName);
    if (!cache) {
      console.warn(`[ImpostorSystem] Type not registered: ${typeName}`);
      return;
    }

    cache.instances.push(...instances);
    this.updateInstanceMatrices(cache);
  }

  /**
   * Clear all instances for a type
   */
  clearInstances(typeName: string): void {
    const cache = this.impostorCache.get(typeName);
    if (!cache) return;

    cache.instances = [];
    if (cache.billboardMesh) {
      disposeMesh(this.scene, cache.billboardMesh);
      cache.billboardMesh = null;
    }
    cache.matrixBuffer = null;
  }

  /**
   * Update instance matrices - recreates InstancedMesh with current instances
   */
  private updateInstanceMatrices(cache: ImpostorCache): void {
    if (cache.instances.length === 0) return;

    // Dispose old InstancedMesh if it exists
    if (cache.billboardMesh) {
      disposeMesh(this.scene, cache.billboardMesh);
      cache.billboardMesh = null;
    }

    const count = cache.instances.length;
    cache.matrixBuffer = new Float32Array(count * 16);

    const matrix = new THREE.Matrix4();
    const tempPos = new THREE.Vector3();
    const tempScale = new THREE.Vector3();
    const tempQuat = new THREE.Quaternion();

    for (let i = 0; i < count; i++) {
      const inst = cache.instances[i];

      tempPos.copy(inst.position);
      tempScale.set(inst.scale, inst.scale, inst.scale);
      tempQuat.setFromEuler(new THREE.Euler(0, inst.rotation, 0));

      matrix.compose(tempPos, tempQuat, tempScale);
      matrix.toArray(cache.matrixBuffer, i * 16);
    }

    // Create new InstancedMesh with exact count
    this.createBillboardMesh(cache, count);

    // Re-read billboardMesh after createBillboardMesh sets it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instMesh = cache.billboardMesh as any as THREE.InstancedMesh | null;
    if (instMesh) {
      const mat4 = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        mat4.fromArray(cache.matrixBuffer, i * 16);
        instMesh.setMatrixAt(i, mat4);
      }
      instMesh.instanceMatrix.needsUpdate = true;
    }

    console.log(`[ImpostorSystem] Updated ${count} instances for ${cache.config.name}`);
  }

  /**
   * Update visibility based on camera distance
   * Call this each frame to manage LOD transitions
   */
  updateVisibility(cameraPosition: THREE.Vector3): void {
    for (const [, cache] of this.impostorCache) {
      if (!cache.billboardMesh || cache.instances.length === 0) continue;

      // For now, simple distance-based visibility
      // Full implementation would:
      // 1. Show/hide individual instances based on distance
      // 2. Blend with 3D mesh during transition zone
      // 3. Use frustum culling

      const config = cache.config;
      let visibleCount = 0;

      for (const inst of cache.instances) {
        const distance = cameraPosition.distanceTo(inst.position);
        if (distance > config.transitionStart) {
          visibleCount++;
        }
      }

      // Toggle billboard mesh visibility based on whether any instances are far enough
      cache.billboardMesh.visible = visibleCount > 0;
    }
  }

  /**
   * Get statistics
   */
  getStats(): { types: number; totalInstances: number } {
    let totalInstances = 0;
    for (const [, cache] of this.impostorCache) {
      totalInstances += cache.instances.length;
    }
    return {
      types: this.impostorCache.size,
      totalInstances,
    };
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    for (const [, cache] of this.impostorCache) {
      if (cache.atlasTexture) {
        cache.atlasTexture.dispose();
      }
      if (cache.billboardMesh) {
        disposeMesh(this.scene, cache.billboardMesh);
      }
    }
    this.impostorCache.clear();

    if (this.captureCamera) {
      this.captureCamera = null;
    }

    if (this.impostorMaterial) {
      this.impostorMaterial.dispose();
      this.impostorMaterial = null;
    }

    if (this.billboardGeometry) {
      this.billboardGeometry.dispose();
      this.billboardGeometry = null;
    }

    console.log("[ImpostorSystem] Disposed");
  }
}
