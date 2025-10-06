import {
  Scene,
  Mesh,
  MeshBuilder,
  Vector3,
  Matrix,
  Quaternion,
  Texture,
  StandardMaterial,
  ShaderMaterial,
  Effect,
  RenderTargetTexture,
  Camera,
  ArcRotateCamera,
  Color3,
  Color4,
  VertexBuffer,
  TransformNode,
  AbstractMesh,
} from "@babylonjs/core";

/**
 * Impostor configuration for a single object type
 */
export interface ImpostorConfig {
  name: string;
  sourceMesh: Mesh | null;           // Source 3D mesh to capture
  textureSize: number;               // Resolution of impostor texture (e.g., 256)
  viewAngles: number;                // Number of view angles (e.g., 8 for octagonal)
  transitionStart: number;           // Distance to start transition (e.g., 80)
  transitionEnd: number;             // Distance to fully switch to impostor (e.g., 100)
}

/**
 * Impostor instance data
 */
interface ImpostorInstance {
  position: Vector3;
  scale: number;
  rotation: number;
}

/**
 * Cached impostor data for a type
 */
interface ImpostorCache {
  config: ImpostorConfig;
  atlasTexture: RenderTargetTexture | null;  // Multi-angle atlas
  billboardMesh: Mesh | null;                 // Base billboard mesh
  instances: ImpostorInstance[];              // All instances
  matrixBuffer: Float32Array | null;          // Instance matrices
}

// Register impostor billboard shader
Effect.ShadersStore["impostorVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 viewProjection;
uniform mat4 world;
uniform vec3 uCameraPosition;
uniform float uAtlasColumns;
uniform float uAtlasRows;

varying vec2 vUV;
varying float vFade;

void main() {
    // Get instance world position from matrix
    vec4 worldPos = world * vec4(0.0, 0.0, 0.0, 1.0);
    
    // Billboard facing - rotate quad to face camera
    vec3 toCamera = normalize(uCameraPosition - worldPos.xyz);
    vec3 up = vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(up, toCamera));
    vec3 forward = cross(right, up);
    
    // Extract scale from world matrix
    float scaleX = length(vec3(world[0][0], world[0][1], world[0][2]));
    float scaleY = length(vec3(world[1][0], world[1][1], world[1][2]));
    
    // Apply billboard rotation
    vec3 billboardPos = worldPos.xyz 
        + right * position.x * scaleX 
        + up * position.y * scaleY;
    
    gl_Position = viewProjection * vec4(billboardPos, 1.0);
    
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

Effect.ShadersStore["impostorFragmentShader"] = `
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
 * - Thin instance based for performance
 */
export class ImpostorSystem {
  private scene: Scene;
  private impostorCache: Map<string, ImpostorCache> = new Map();
  private impostorMaterial: ShaderMaterial | null = null;
  private captureCamera: ArcRotateCamera | null = null;
  private captureLight: TransformNode | null = null;
  
  // Default settings
  private defaultTextureSize = 256;
  private defaultViewAngles = 8;
  private defaultTransitionStart = 80;
  private defaultTransitionEnd = 100;

  constructor(scene: Scene) {
    this.scene = scene;
    this.createImpostorMaterial();
    this.setupCaptureCamera();
  }

  /**
   * Create shared impostor material
   */
  private createImpostorMaterial(): void {
    this.impostorMaterial = new ShaderMaterial(
      "impostorMaterial",
      this.scene,
      {
        vertex: "impostor",
        fragment: "impostor",
      },
      {
        attributes: ["position", "uv"],
        uniforms: [
          "viewProjection",
          "world",
          "uCameraPosition",
          "uAtlasColumns",
          "uAtlasRows",
          "uSunDirection",
          "uAmbient",
        ],
        samplers: ["uImpostorAtlas"],
        needAlphaBlending: true,
      }
    );

    this.impostorMaterial.setFloat("uAtlasColumns", this.defaultViewAngles);
    this.impostorMaterial.setFloat("uAtlasRows", 1);
    this.impostorMaterial.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.impostorMaterial.setFloat("uAmbient", 0.4);
    this.impostorMaterial.backFaceCulling = false;
    this.impostorMaterial.alphaMode = 1;  // ALPHA_ADD not needed, just alpha test

    // Bind camera position each frame
    this.impostorMaterial.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera) {
        this.impostorMaterial!.setVector3("uCameraPosition", camera.position);
      }
    });
  }

  /**
   * Setup camera for capturing impostor textures
   */
  private setupCaptureCamera(): void {
    this.captureCamera = new ArcRotateCamera(
      "impostorCaptureCamera",
      0,
      Math.PI / 2,
      5,
      Vector3.Zero(),
      this.scene
    );
    this.captureCamera.minZ = 0.1;
    this.captureCamera.maxZ = 100;
    
    // Don't add to active cameras list
    const cameraIndex = this.scene.cameras.indexOf(this.captureCamera);
    if (cameraIndex > -1) {
      this.scene.cameras.splice(cameraIndex, 1);
    }
  }

  /**
   * Register a mesh type for impostor generation
   */
  registerImpostor(config: Partial<ImpostorConfig> & { name: string; sourceMesh: Mesh }): void {
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
    
    // Create billboard base mesh
    this.createBillboardMesh(cache);

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
    const renderTarget = new RenderTargetTexture(
      `${config.name}_atlas`,
      { width: atlasWidth, height: atlasHeight },
      this.scene,
      false,
      true
    );
    renderTarget.clearColor = new Color4(0, 0, 0, 0);
    
    cache.atlasTexture = renderTarget;

    // Capture each view angle
    const sourceMesh = config.sourceMesh;
    const originalVisibility = sourceMesh.isVisible;
    sourceMesh.isVisible = true;

    // Calculate mesh bounds for camera positioning
    sourceMesh.computeWorldMatrix(true);
    const bounds = sourceMesh.getBoundingInfo();
    const meshSize = bounds.boundingBox.maximumWorld.subtract(bounds.boundingBox.minimumWorld);
    const maxDimension = Math.max(meshSize.x, meshSize.y, meshSize.z);
    const cameraDistance = maxDimension * 2;

    if (this.captureCamera) {
      this.captureCamera.radius = cameraDistance;
      this.captureCamera.target = bounds.boundingBox.centerWorld.clone();
    }

    // For now, use a single angle capture (simplified)
    // Full implementation would render multiple angles to atlas regions
    renderTarget.renderList = [sourceMesh];
    
    // Restore visibility
    sourceMesh.isVisible = originalVisibility;

    console.log(`[ImpostorSystem] Generated atlas texture for ${config.name}: ${atlasWidth}x${atlasHeight}`);
  }

  /**
   * Create billboard base mesh for thin instancing
   */
  private createBillboardMesh(cache: ImpostorCache): void {
    // Create simple quad
    const billboard = MeshBuilder.CreatePlane(
      `${cache.config.name}_billboard`,
      { size: 1, sideOrientation: Mesh.DOUBLESIDE },
      this.scene
    );

    // Offset pivot to bottom center (trees grow from ground)
    billboard.bakeTransformIntoVertices(Matrix.Translation(0, 0.5, 0));

    // Apply material with atlas texture
    if (this.impostorMaterial && cache.atlasTexture) {
      const material = this.impostorMaterial.clone(`${cache.config.name}_mat`);
      material.setTexture("uImpostorAtlas", cache.atlasTexture);
      billboard.material = material;
    }

    billboard.isVisible = false;
    cache.billboardMesh = billboard;
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
      cache.billboardMesh.thinInstanceCount = 0;
    }
    cache.matrixBuffer = null;
  }

  /**
   * Update thin instance matrices
   */
  private updateInstanceMatrices(cache: ImpostorCache): void {
    if (!cache.billboardMesh || cache.instances.length === 0) return;

    const count = cache.instances.length;
    cache.matrixBuffer = new Float32Array(count * 16);

    const matrix = Matrix.Identity();
    const tempPos = Vector3.Zero();
    const tempScale = Vector3.One();
    const tempQuat = Quaternion.Identity();

    for (let i = 0; i < count; i++) {
      const inst = cache.instances[i];
      
      tempPos.copyFrom(inst.position);
      tempScale.setAll(inst.scale);
      Quaternion.FromEulerAnglesToRef(0, inst.rotation, 0, tempQuat);

      Matrix.ComposeToRef(tempScale, tempQuat, tempPos, matrix);
      matrix.copyToArray(cache.matrixBuffer, i * 16);
    }

    cache.billboardMesh.thinInstanceSetBuffer("matrix", cache.matrixBuffer, 16);
    cache.billboardMesh.isVisible = true;

    console.log(`[ImpostorSystem] Updated ${count} instances for ${cache.config.name}`);
  }

  /**
   * Update visibility based on camera distance
   * Call this each frame to manage LOD transitions
   */
  updateVisibility(cameraPosition: Vector3): void {
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
        const distance = Vector3.Distance(cameraPosition, inst.position);
        if (distance > config.transitionStart) {
          visibleCount++;
        }
      }

      // Toggle billboard mesh visibility based on whether any instances are far enough
      cache.billboardMesh.isVisible = visibleCount > 0;
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
        cache.billboardMesh.dispose();
      }
    }
    this.impostorCache.clear();

    if (this.captureCamera) {
      this.captureCamera.dispose();
      this.captureCamera = null;
    }

    if (this.impostorMaterial) {
      this.impostorMaterial.dispose();
      this.impostorMaterial = null;
    }

    console.log("[ImpostorSystem] Disposed");
  }
}
