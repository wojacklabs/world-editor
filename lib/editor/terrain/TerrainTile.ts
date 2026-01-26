import {
  Scene,
  Mesh,
  MeshBuilder,
  VertexData,
  Vector3,
  ShaderMaterial,
  Effect,
  Color3,
} from "@babylonjs/core";

// ============================================
// Tile Type Definitions
// ============================================
export type TileType = "grass" | "dirt" | "rock" | "sand";

export interface TileConfig {
  type: TileType;
  row: number;
  col: number;
  width: number;  // World units
  height: number; // World units
}

export interface TileDecorationConfig {
  enabled: boolean;
  density: number;  // 0-1, decorations per unit area
  seed: number;
}

// ============================================
// Tile Shader - Handles ground + decoration blending
// ============================================
Effect.ShadersStore["tileGroundVertexShader"] = `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 worldViewProjection;
uniform mat4 world;
uniform vec3 cameraPosition;

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

void main() {
    vec4 worldPos = world * vec4(position, 1.0);
    gl_Position = worldViewProjection * vec4(position, 1.0);

    vNormal = normalize(mat3(world) * normal);
    vPosition = worldPos.xyz;
    vUV = uv;
    vCameraDistance = length(cameraPosition - worldPos.xyz);
    vViewDirection = normalize(cameraPosition - worldPos.xyz);
}
`;

Effect.ShadersStore["tileGroundFragmentShader"] = `
precision highp float;

uniform vec3 uBaseColor;
uniform vec3 uDetailColor;
uniform vec3 uSunDirection;
uniform float uAmbientIntensity;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uBlendFactor;  // For edge blending (0-1)
uniform vec3 uBlendColor;    // Adjacent tile color for blending

varying vec3 vNormal;
varying vec3 vPosition;
varying vec2 vUV;
varying float vCameraDistance;
varying vec3 vViewDirection;

// Noise functions
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

float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 4; i++) {
        value += amplitude * noise2D(p);
        p *= 2.0;
        amplitude *= 0.5;
    }
    return value;
}

void main() {
    vec3 normal = normalize(vNormal);

    // Noise-based color variation
    float noiseVal = fbm(vPosition.xz * 0.5);
    float detailNoise = fbm(vPosition.xz * 2.0) * 0.3;

    // Base color with variation
    vec3 color = mix(uBaseColor, uDetailColor, noiseVal * 0.4 + detailNoise);

    // Apply edge blending
    if (uBlendFactor > 0.0) {
        float blendNoise = fbm(vPosition.xz * 3.0) * 0.2;
        float blend = uBlendFactor + blendNoise;
        blend = smoothstep(0.0, 1.0, blend);
        color = mix(color, uBlendColor, blend);
    }

    // Half-Lambert lighting
    float NdotL = dot(normal, uSunDirection);
    float halfLambert = NdotL * 0.5 + 0.5;
    halfLambert = halfLambert * halfLambert;

    // Rim lighting
    float rimFactor = 1.0 - max(dot(normal, vViewDirection), 0.0);
    rimFactor = pow(rimFactor, 3.0) * 0.15;

    // Final color
    float diffuse = halfLambert * 0.6 + 0.4;
    vec3 ambient = vec3(uAmbientIntensity);
    color = color * (ambient + diffuse) + vec3(rimFactor);

    // Fog
    float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vCameraDistance * vCameraDistance);
    color = mix(color, uFogColor, clamp(fogFactor, 0.0, 1.0));

    gl_FragColor = vec4(color, 1.0);
}
`;

// ============================================
// Tile Colors
// ============================================
export const TILE_COLORS: Record<TileType, { base: Color3; detail: Color3 }> = {
  grass: {
    base: new Color3(0.28, 0.45, 0.15),
    detail: new Color3(0.35, 0.55, 0.2),
  },
  dirt: {
    base: new Color3(0.4, 0.3, 0.18),
    detail: new Color3(0.5, 0.38, 0.22),
  },
  rock: {
    base: new Color3(0.35, 0.35, 0.38),
    detail: new Color3(0.45, 0.45, 0.48),
  },
  sand: {
    base: new Color3(0.7, 0.6, 0.4),
    detail: new Color3(0.8, 0.7, 0.5),
  },
};

// ============================================
// TerrainTile Class
// ============================================
export class TerrainTile {
  private scene: Scene;
  private config: TileConfig;
  private groundMesh: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private decorationMeshes: Mesh[] = [];
  private decorationConfig: TileDecorationConfig;

  constructor(scene: Scene, config: TileConfig) {
    this.scene = scene;
    this.config = config;
    this.decorationConfig = {
      enabled: true,
      density: 0.5,
      seed: config.row * 1000 + config.col,
    };
  }

  /**
   * Generate the tile ground mesh and decorations
   */
  generate(): void {
    this.dispose();
    this.createGroundMesh();
    this.createMaterial();

    if (this.decorationConfig.enabled) {
      this.generateDecorations();
    }
  }

  /**
   * Create the ground plane mesh with some height variation
   */
  private createGroundMesh(): void {
    const { width, height, row, col, type } = this.config;
    const subdivisions = 16;  // Grid density

    // Create ground mesh
    this.groundMesh = MeshBuilder.CreateGround(
      `tile_${row}_${col}`,
      {
        width,
        height,
        subdivisions,
        updatable: true,
      },
      this.scene
    );

    // Position tile in world
    this.groundMesh.position.x = col * width + width / 2;
    this.groundMesh.position.z = row * height + height / 2;

    // Add slight height variation based on tile type
    const positions = this.groundMesh.getVerticesData("position");
    if (positions) {
      const newPositions = new Float32Array(positions.length);
      const seed = this.decorationConfig.seed;

      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const z = positions[i + 2];

        // Add noise-based height
        let heightVal = 0;
        if (type === "rock") {
          // Rocky terrain has more height variation
          heightVal = this.noise2D(x * 0.3 + seed, z * 0.3) * 0.8 +
                      this.noise2D(x * 0.8 + seed, z * 0.8) * 0.3;
        } else if (type === "dirt") {
          // Dirt has moderate variation
          heightVal = this.noise2D(x * 0.2 + seed, z * 0.2) * 0.2;
        } else if (type === "grass") {
          // Grass is relatively flat
          heightVal = this.noise2D(x * 0.15 + seed, z * 0.15) * 0.1;
        } else {
          // Sand is very flat
          heightVal = this.noise2D(x * 0.1 + seed, z * 0.1) * 0.05;
        }

        newPositions[i] = x;
        newPositions[i + 1] = positions[i + 1] + heightVal;
        newPositions[i + 2] = z;
      }

      this.groundMesh.updateVerticesData("position", newPositions);

      // Recompute normals
      const indices = this.groundMesh.getIndices();
      const normals = this.groundMesh.getVerticesData("normal");
      if (indices && normals) {
        VertexData.ComputeNormals(newPositions, indices, normals);
        this.groundMesh.updateVerticesData("normal", normals);
      }
    }
  }

  /**
   * Create shader material for ground
   */
  private createMaterial(): void {
    if (!this.groundMesh) return;

    const colors = TILE_COLORS[this.config.type];

    this.material = new ShaderMaterial(
      `tileMat_${this.config.row}_${this.config.col}`,
      this.scene,
      {
        vertex: "tileGround",
        fragment: "tileGround",
      },
      {
        attributes: ["position", "normal", "uv"],
        uniforms: [
          "worldViewProjection",
          "world",
          "cameraPosition",
          "uBaseColor",
          "uDetailColor",
          "uSunDirection",
          "uAmbientIntensity",
          "uFogColor",
          "uFogDensity",
          "uBlendFactor",
          "uBlendColor",
        ],
      }
    );

    this.material.setColor3("uBaseColor", colors.base);
    this.material.setColor3("uDetailColor", colors.detail);
    this.material.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
    this.material.setFloat("uAmbientIntensity", 0.4);
    this.material.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
    this.material.setFloat("uFogDensity", 0.008);
    this.material.setFloat("uBlendFactor", 0);
    this.material.setColor3("uBlendColor", colors.base);

    this.material.backFaceCulling = false;

    // Update camera position on bind
    this.material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera;
      if (camera && this.material) {
        this.material.setVector3("cameraPosition", camera.position);
      }
    });

    this.groundMesh.material = this.material;
  }

  /**
   * Generate decorations based on tile type
   */
  private generateDecorations(): void {
    const { type, width, height, row, col } = this.config;
    const density = this.decorationConfig.density;
    const seed = this.decorationConfig.seed;

    // Calculate number of decorations
    const area = width * height;
    let baseCount = Math.floor(area * density);

    // World position offset
    const offsetX = col * width;
    const offsetZ = row * height;

    switch (type) {
      case "grass":
        this.generateGrassDecorations(baseCount * 2, offsetX, offsetZ, width, height, seed);
        break;
      case "dirt":
        this.generatePebbleDecorations(Math.floor(baseCount * 0.5), offsetX, offsetZ, width, height, seed);
        break;
      case "rock":
        this.generateRockDecorations(Math.floor(baseCount * 0.2), offsetX, offsetZ, width, height, seed);
        break;
      case "sand":
        // Sand has minimal decorations - just occasional rocks
        this.generateRockDecorations(Math.floor(baseCount * 0.05), offsetX, offsetZ, width, height, seed);
        break;
    }
  }

  /**
   * Generate grass blade decorations
   */
  private generateGrassDecorations(
    count: number,
    offsetX: number,
    offsetZ: number,
    width: number,
    height: number,
    seed: number
  ): void {
    // Import dynamically to avoid circular dependency
    // For now, create simple grass blade meshes inline

    for (let i = 0; i < count; i++) {
      const iSeed = seed + i * 31.7;
      const x = offsetX + this.hash(iSeed) * width;
      const z = offsetZ + this.hash(iSeed + 100) * height;
      const bladeHeight = 0.1 + this.hash(iSeed + 200) * 0.15;
      const bladeWidth = 0.01 + this.hash(iSeed + 300) * 0.01;

      const blade = this.createGrassBlade(bladeHeight, bladeWidth, iSeed);
      blade.position.x = x;
      blade.position.z = z;
      blade.position.y = this.getGroundHeight(x - offsetX, z - offsetZ);
      blade.rotation.y = this.hash(iSeed + 400) * Math.PI * 2;

      this.decorationMeshes.push(blade);
    }
  }

  /**
   * Create a single grass blade mesh
   */
  private createGrassBlade(h: number, w: number, seed: number): Mesh {
    const curve = 0.02 + this.hash(seed + 500) * 0.04;

    const positions = [
      -w, 0, 0,
      w, 0, 0,
      -w * 0.8, h * 0.35, curve * 0.25,
      w * 0.8, h * 0.35, curve * 0.25,
      -w * 0.5, h * 0.7, curve * 0.6,
      w * 0.5, h * 0.7, curve * 0.6,
      0, h, curve,
    ];

    const indices = [
      0, 1, 2, 1, 3, 2,
      2, 3, 4, 3, 5, 4,
      4, 5, 6,
    ];

    const normals: number[] = [];
    for (let j = 0; j < positions.length; j += 3) {
      normals.push(0, 0.3, 0.95);
    }

    const blade = new Mesh(`grassBlade_${seed}`, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.applyToMesh(blade);

    // Simple green material
    blade.material = this.getGrassBladesMaterial();

    return blade;
  }

  /**
   * Generate pebble decorations for dirt terrain
   */
  private generatePebbleDecorations(
    count: number,
    offsetX: number,
    offsetZ: number,
    width: number,
    height: number,
    seed: number
  ): void {
    for (let i = 0; i < count; i++) {
      const iSeed = seed + i * 47.3;
      const x = offsetX + this.hash(iSeed) * width;
      const z = offsetZ + this.hash(iSeed + 100) * height;
      const size = 0.03 + this.hash(iSeed + 200) * 0.07;

      const pebble = MeshBuilder.CreateIcoSphere(
        `pebble_${seed}_${i}`,
        { radius: size, subdivisions: 2 },
        this.scene
      );

      // Flatten slightly
      pebble.scaling.y = 0.4 + this.hash(iSeed + 300) * 0.3;

      pebble.position.x = x;
      pebble.position.z = z;
      pebble.position.y = this.getGroundHeight(x - offsetX, z - offsetZ) + size * 0.3;
      pebble.rotation.y = this.hash(iSeed + 400) * Math.PI * 2;

      // Gray/brown material
      pebble.material = this.getPebbleMaterial();

      this.decorationMeshes.push(pebble);
    }
  }

  /**
   * Generate rock formations for rock terrain
   */
  private generateRockDecorations(
    count: number,
    offsetX: number,
    offsetZ: number,
    width: number,
    height: number,
    seed: number
  ): void {
    for (let i = 0; i < count; i++) {
      const iSeed = seed + i * 67.9;
      const x = offsetX + this.hash(iSeed) * width;
      const z = offsetZ + this.hash(iSeed + 100) * height;
      const size = 0.1 + this.hash(iSeed + 200) * 0.4;

      const rock = MeshBuilder.CreateIcoSphere(
        `rock_${seed}_${i}`,
        { radius: size, subdivisions: 3, updatable: true },
        this.scene
      );

      // Deform the rock
      const positions = rock.getVerticesData("position");
      if (positions) {
        const newPos = new Float32Array(positions.length);
        for (let j = 0; j < positions.length; j += 3) {
          let px = positions[j];
          let py = positions[j + 1];
          let pz = positions[j + 2];

          // Scale irregularly
          const scaleX = 0.6 + this.hash(iSeed + j) * 0.8;
          const scaleY = 0.4 + this.hash(iSeed + j + 10) * 0.6;
          const scaleZ = 0.6 + this.hash(iSeed + j + 20) * 0.8;

          px *= scaleX;
          py *= scaleY;
          pz *= scaleZ;

          // Add noise displacement
          const noiseAmt = this.noise2D(px * 3 + iSeed, pz * 3) * 0.1;
          const len = Math.sqrt(px * px + py * py + pz * pz);
          if (len > 0.001) {
            px += (px / len) * noiseAmt;
            py += (py / len) * noiseAmt;
            pz += (pz / len) * noiseAmt;
          }

          newPos[j] = px;
          newPos[j + 1] = py;
          newPos[j + 2] = pz;
        }
        rock.updateVerticesData("position", newPos);
      }

      rock.position.x = x;
      rock.position.z = z;
      rock.position.y = this.getGroundHeight(x - offsetX, z - offsetZ) + size * 0.3;
      rock.rotation.y = this.hash(iSeed + 400) * Math.PI * 2;
      rock.rotation.x = this.hash(iSeed + 500) * 0.3;

      rock.material = this.getRockMaterial();

      this.decorationMeshes.push(rock);
    }
  }

  /**
   * Get height at local position on tile
   */
  private getGroundHeight(localX: number, localZ: number): number {
    if (!this.groundMesh) return 0;

    // Sample from mesh (simplified - assumes flat with slight variation)
    const seed = this.decorationConfig.seed;
    const type = this.config.type;

    if (type === "rock") {
      return this.noise2D(localX * 0.3 + seed, localZ * 0.3) * 0.8 +
             this.noise2D(localX * 0.8 + seed, localZ * 0.8) * 0.3;
    } else if (type === "dirt") {
      return this.noise2D(localX * 0.2 + seed, localZ * 0.2) * 0.2;
    } else if (type === "grass") {
      return this.noise2D(localX * 0.15 + seed, localZ * 0.15) * 0.1;
    }
    return 0;
  }

  // Cached materials
  private grassMaterial: ShaderMaterial | null = null;
  private pebbleMat: ShaderMaterial | null = null;
  private rockMat: ShaderMaterial | null = null;

  private getGrassBladesMaterial(): ShaderMaterial {
    if (!this.grassMaterial) {
      this.grassMaterial = new ShaderMaterial(
        "grassBladeMat",
        this.scene,
        {
          vertex: "tileGround",
          fragment: "tileGround",
        },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "uBaseColor", "uDetailColor", "uSunDirection",
            "uAmbientIntensity", "uFogColor", "uFogDensity",
            "uBlendFactor", "uBlendColor",
          ],
        }
      );

      this.grassMaterial.setColor3("uBaseColor", new Color3(0.2, 0.5, 0.1));
      this.grassMaterial.setColor3("uDetailColor", new Color3(0.3, 0.6, 0.15));
      this.grassMaterial.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      this.grassMaterial.setFloat("uAmbientIntensity", 0.4);
      this.grassMaterial.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
      this.grassMaterial.setFloat("uFogDensity", 0.008);
      this.grassMaterial.setFloat("uBlendFactor", 0);
      this.grassMaterial.setColor3("uBlendColor", new Color3(0.2, 0.5, 0.1));
      this.grassMaterial.backFaceCulling = false;

      this.grassMaterial.onBindObservable.add(() => {
        const camera = this.scene.activeCamera;
        if (camera && this.grassMaterial) {
          this.grassMaterial.setVector3("cameraPosition", camera.position);
        }
      });
    }
    return this.grassMaterial;
  }

  private getPebbleMaterial(): ShaderMaterial {
    if (!this.pebbleMat) {
      this.pebbleMat = new ShaderMaterial(
        "pebbleMat",
        this.scene,
        { vertex: "tileGround", fragment: "tileGround" },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "uBaseColor", "uDetailColor", "uSunDirection",
            "uAmbientIntensity", "uFogColor", "uFogDensity",
            "uBlendFactor", "uBlendColor",
          ],
        }
      );

      this.pebbleMat.setColor3("uBaseColor", new Color3(0.5, 0.45, 0.35));
      this.pebbleMat.setColor3("uDetailColor", new Color3(0.6, 0.55, 0.45));
      this.pebbleMat.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      this.pebbleMat.setFloat("uAmbientIntensity", 0.4);
      this.pebbleMat.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
      this.pebbleMat.setFloat("uFogDensity", 0.008);
      this.pebbleMat.setFloat("uBlendFactor", 0);
      this.pebbleMat.setColor3("uBlendColor", new Color3(0.5, 0.45, 0.35));

      this.pebbleMat.onBindObservable.add(() => {
        const camera = this.scene.activeCamera;
        if (camera && this.pebbleMat) {
          this.pebbleMat.setVector3("cameraPosition", camera.position);
        }
      });
    }
    return this.pebbleMat;
  }

  private getRockMaterial(): ShaderMaterial {
    if (!this.rockMat) {
      this.rockMat = new ShaderMaterial(
        "rockMat",
        this.scene,
        { vertex: "tileGround", fragment: "tileGround" },
        {
          attributes: ["position", "normal", "uv"],
          uniforms: [
            "worldViewProjection", "world", "cameraPosition",
            "uBaseColor", "uDetailColor", "uSunDirection",
            "uAmbientIntensity", "uFogColor", "uFogDensity",
            "uBlendFactor", "uBlendColor",
          ],
        }
      );

      this.rockMat.setColor3("uBaseColor", new Color3(0.4, 0.4, 0.42));
      this.rockMat.setColor3("uDetailColor", new Color3(0.5, 0.5, 0.52));
      this.rockMat.setVector3("uSunDirection", new Vector3(0.5, 0.8, 0.3).normalize());
      this.rockMat.setFloat("uAmbientIntensity", 0.4);
      this.rockMat.setColor3("uFogColor", new Color3(0.6, 0.75, 0.9));
      this.rockMat.setFloat("uFogDensity", 0.008);
      this.rockMat.setFloat("uBlendFactor", 0);
      this.rockMat.setColor3("uBlendColor", new Color3(0.4, 0.4, 0.42));

      this.rockMat.onBindObservable.add(() => {
        const camera = this.scene.activeCamera;
        if (camera && this.rockMat) {
          this.rockMat.setVector3("cameraPosition", camera.position);
        }
      });
    }
    return this.rockMat;
  }

  // Noise utilities
  private hash(n: number): number {
    return ((Math.sin(n) * 43758.5453) % 1 + 1) % 1;
  }

  private noise2D(x: number, y: number): number {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;

    const a = this.hash(ix + iy * 57);
    const b = this.hash(ix + 1 + iy * 57);
    const c = this.hash(ix + (iy + 1) * 57);
    const d = this.hash(ix + 1 + (iy + 1) * 57);

    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);

    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
  }

  /**
   * Set edge blending for smooth transitions
   */
  setEdgeBlend(factor: number, neighborType: TileType): void {
    if (this.material) {
      const neighborColors = TILE_COLORS[neighborType];
      this.material.setFloat("uBlendFactor", factor);
      this.material.setColor3("uBlendColor", neighborColors.base);
    }
  }

  /**
   * Get tile configuration
   */
  getConfig(): TileConfig {
    return { ...this.config };
  }

  /**
   * Update tile type (regenerates)
   */
  setType(type: TileType): void {
    this.config.type = type;
    this.generate();
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    if (this.groundMesh) {
      this.groundMesh.dispose();
      this.groundMesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    // Dispose decoration materials
    if (this.grassMaterial) {
      this.grassMaterial.dispose();
      this.grassMaterial = null;
    }
    if (this.pebbleMat) {
      this.pebbleMat.dispose();
      this.pebbleMat = null;
    }
    if (this.rockMat) {
      this.rockMat.dispose();
      this.rockMat = null;
    }
    for (const mesh of this.decorationMeshes) {
      mesh.dispose();
    }
    this.decorationMeshes = [];
  }
}
