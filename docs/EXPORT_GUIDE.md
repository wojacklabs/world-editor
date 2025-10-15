# World Editor Export Guide

This guide explains how to use exported world data from World Editor in your game projects.

## Export Formats

World Editor supports two export formats:

### 1. JSON Project File (Recommended)

The primary export format containing all world data in a single JSON file.

**File:** `{project-name}.json`

### 2. GLB Export (Optional)

Exports only the terrain mesh as a GLB file. Use this for static terrain without runtime heightmap access.

**File:** `terrain.glb`

---

## JSON Project Schema

```typescript
interface WorldProject {
  version: string;           // Schema version (e.g., "1.0.0")
  name: string;              // Project name
  createdAt: string;         // ISO timestamp
  modifiedAt: string;        // ISO timestamp
  
  terrain: {
    size: number;            // World size in units (e.g., 64, 128)
    resolution: number;      // Heightmap resolution (e.g., 128 = 129x129 vertices)
    heightmap: string;       // Base64-encoded Float32Array of height values
    splatmap: string;        // Base64-encoded material splatmap (optional)
  };
  
  props: PropData[];         // Placed assets/props
  
  materials: {
    slots: MaterialSlot[];   // Terrain material definitions
  };
  
  settings: {
    seamlessTiling: boolean; // Whether terrain edges are seamless
    waterLevel: number;      // Water plane height
  };
}

interface PropData {
  id: string;                // Unique identifier
  name: string;              // Display name
  glbPath?: string;          // URL or path to GLB model
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };  // Degrees
  scale: { x: number; y: number; z: number };
}
```

---

## Loading World Data

### Babylon.js Example

```typescript
import { Scene, Mesh, VertexData, Vector3, StandardMaterial } from '@babylonjs/core';

// 1. Heightmap class for terrain height queries
class Heightmap {
  private resolution: number;
  private scale: number;
  private data: Float32Array;

  constructor(resolution: number, scale: number) {
    this.resolution = resolution + 1;  // +1 for vertex count
    this.scale = scale;
    this.data = new Float32Array(this.resolution * this.resolution);
  }

  fromBase64(base64: string): void {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    this.data = new Float32Array(bytes.buffer);
  }

  getHeight(x: number, z: number): number {
    if (x < 0 || x >= this.resolution || z < 0 || z >= this.resolution) return 0;
    return this.data[z * this.resolution + x];
  }

  getInterpolatedHeight(worldX: number, worldZ: number): number {
    const cellSize = this.scale / (this.resolution - 1);
    const x = worldX / cellSize;
    const z = worldZ / cellSize;

    const x0 = Math.floor(x);
    const z0 = Math.floor(z);
    const xFrac = x - x0;
    const zFrac = z - z0;

    const h00 = this.getHeight(x0, z0);
    const h10 = this.getHeight(x0 + 1, z0);
    const h01 = this.getHeight(x0, z0 + 1);
    const h11 = this.getHeight(x0 + 1, z0 + 1);

    const h0 = h00 * (1 - xFrac) + h10 * xFrac;
    const h1 = h01 * (1 - xFrac) + h11 * xFrac;
    return h0 * (1 - zFrac) + h1 * zFrac;
  }
}

// 2. Create terrain mesh from heightmap
function createTerrainMesh(scene: Scene, heightmap: Heightmap, size: number): Mesh {
  const resolution = heightmap.resolution;
  const cellSize = size / (resolution - 1);

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  // Create vertices
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const height = heightmap.getHeight(x, z);
      positions.push(x * cellSize, height, z * cellSize);
      uvs.push(x / (resolution - 1), z / (resolution - 1));
      normals.push(0, 1, 0);  // Calculate proper normals later
    }
  }

  // Create indices (two triangles per cell)
  for (let z = 0; z < resolution - 1; z++) {
    for (let x = 0; x < resolution - 1; x++) {
      const topLeft = z * resolution + x;
      const topRight = topLeft + 1;
      const bottomLeft = (z + 1) * resolution + x;
      const bottomRight = bottomLeft + 1;

      indices.push(topLeft, bottomLeft, topRight);
      indices.push(topRight, bottomLeft, bottomRight);
    }
  }

  const mesh = new Mesh('terrain', scene);
  const vertexData = new VertexData();
  vertexData.positions = positions;
  vertexData.indices = indices;
  vertexData.uvs = uvs;
  vertexData.applyToMesh(mesh, true);

  // Material
  const material = new StandardMaterial('terrainMat', scene);
  material.backFaceCulling = false;  // Render both sides
  mesh.material = material;

  return mesh;
}

// 3. Load world from JSON
async function loadWorld(jsonUrl: string, scene: Scene) {
  const response = await fetch(jsonUrl);
  const project = await response.json();

  // Create heightmap
  const heightmap = new Heightmap(project.terrain.resolution, project.terrain.size);
  if (project.terrain.heightmap) {
    heightmap.fromBase64(project.terrain.heightmap);
  }

  // Create terrain mesh
  const terrain = createTerrainMesh(scene, heightmap, project.terrain.size);

  // Load props
  for (const prop of project.props) {
    if (prop.glbPath) {
      // Load GLB and position it
      // SceneLoader.ImportMeshAsync('', '', prop.glbPath, scene)...
    }
  }

  return { heightmap, terrain };
}
```

### Three.js Example

```javascript
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';

async function loadWorld(jsonUrl) {
  const response = await fetch(jsonUrl);
  const project = await response.json();

  // Decode heightmap
  const binary = atob(project.terrain.heightmap);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const heightData = new Float32Array(bytes.buffer);

  // Create terrain geometry
  const resolution = project.terrain.resolution + 1;
  const size = project.terrain.size;
  const geometry = new THREE.PlaneGeometry(size, size, resolution - 1, resolution - 1);
  geometry.rotateX(-Math.PI / 2);

  // Apply heights
  const positions = geometry.attributes.position.array;
  for (let i = 0; i < heightData.length; i++) {
    positions[i * 3 + 1] = heightData[i];  // Y is up
  }
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({ color: 0x5a8a3a });
  const terrain = new THREE.Mesh(geometry, material);

  return terrain;
}
```

---

## Infinite Terrain (Tile Cloning)

For seamless infinite terrain, create a 3x3 grid of terrain clones:

```typescript
function createInfiniteTerrain(originalMesh: Mesh, tileSize: number): Mesh[] {
  const clones: Mesh[] = [];

  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      if (x === 0 && z === 0) continue;  // Skip center (original)

      const clone = originalMesh.clone(`terrain_${x}_${z}`);
      clone.position.x = x * tileSize;
      clone.position.z = z * tileSize;
      clones.push(clone);
    }
  }

  return clones;
}

// Wrap player position for infinite world
function wrapPosition(position: Vector3, tileSize: number): void {
  if (position.x > tileSize) position.x -= tileSize;
  if (position.x < 0) position.x += tileSize;
  if (position.z > tileSize) position.z -= tileSize;
  if (position.z < 0) position.z += tileSize;
}
```

---

## Coordinate System

- **Terrain mesh range:** `(0, 0)` to `(size, size)`
- **Center of terrain:** `(size/2, size/2)`
- **Y axis:** Height (up)
- **Heightmap indices:** `data[z * resolution + x]`

---

## Props / Assets

Props are stored as references to external GLB files. Ensure these files are accessible from your game:

```typescript
// Props array contains paths like:
// - "/assets/tree.glb" (local)
// - "https://example.com/models/rock.glb" (remote)

for (const prop of project.props) {
  const result = await SceneLoader.ImportMeshAsync('', '', prop.glbPath, scene);
  
  const root = result.meshes[0];
  root.position = new Vector3(prop.position.x, prop.position.y, prop.position.z);
  root.rotation = new Vector3(
    prop.rotation.x * Math.PI / 180,
    prop.rotation.y * Math.PI / 180,
    prop.rotation.z * Math.PI / 180
  );
  root.scaling = new Vector3(prop.scale.x, prop.scale.y, prop.scale.z);
}
```

---

## Best Practices

1. **Use JSON over GLB** - JSON provides heightmap data for runtime collision/physics
2. **Host prop assets** - Ensure GLB paths in props array are accessible URLs
3. **Match coordinate systems** - Terrain is at origin (0,0), not centered
4. **Disable backface culling** - Set `material.backFaceCulling = false` for terrain
5. **Set camera clipping planes** - Use `camera.minZ = 0.1` and `camera.maxZ = 2000`

---

## Troubleshooting

### Terrain disappears at certain angles
- Set `mesh.alwaysSelectAsActiveMesh = true`
- Set `material.backFaceCulling = false`
- Call `mesh.refreshBoundingInfo()` after creating geometry

### Character appears underground
- Place character at terrain center: `(size/2, heightAtCenter, size/2)`
- Use `heightmap.getInterpolatedHeight(x, z)` for ground-following

### Dark areas on terrain
- Don't add terrain to shadow casters (causes self-shadowing)
- Increase ambient light intensity
