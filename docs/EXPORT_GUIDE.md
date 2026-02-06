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
function createInfiniteTerrain(originalMesh: THREE.Mesh, tileSize: number): THREE.Mesh[] {
  const clones: THREE.Mesh[] = [];

  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) {
      if (x === 0 && z === 0) continue;  // Skip center (original)

      const clone = originalMesh.clone();
      clone.position.x = x * tileSize;
      clone.position.z = z * tileSize;
      clones.push(clone);
    }
  }

  return clones;
}

// Wrap player position for infinite world
function wrapPosition(position: THREE.Vector3, tileSize: number): void {
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
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Props array contains paths like:
// - "/assets/tree.glb" (local)
// - "https://example.com/models/rock.glb" (remote)

const loader = new GLTFLoader();
for (const prop of project.props) {
  if (!prop.glbPath) continue;
  const gltf = await loader.loadAsync(prop.glbPath);
  const root = gltf.scene;
  root.position.set(prop.position.x, prop.position.y, prop.position.z);
  root.rotation.set(
    prop.rotation.x * Math.PI / 180,
    prop.rotation.y * Math.PI / 180,
    prop.rotation.z * Math.PI / 180
  );
  root.scale.set(prop.scale.x, prop.scale.y, prop.scale.z);
  scene.add(root);
}
```

---

## Best Practices

1. **Use JSON over GLB** - JSON provides heightmap data for runtime collision/physics
2. **Host prop assets** - Ensure GLB paths in props array are accessible URLs
3. **Match coordinate systems** - Terrain is at origin (0,0), not centered
4. **Disable backface culling** - Set `material.side = THREE.DoubleSide` for terrain
5. **Set camera clipping planes** - Use `camera.near = 0.1` and `camera.far = 2000`

---

## Troubleshooting

### Terrain disappears at certain angles
- Set `material.side = THREE.DoubleSide`
- Call `geometry.computeBoundingSphere()` after modifying vertices

### Character appears underground
- Place character at terrain center: `(size/2, heightAtCenter, size/2)`
- Use `heightmap.getInterpolatedHeight(x, z)` for ground-following

### Dark areas on terrain
- Don't add terrain to shadow casters (causes self-shadowing)
- Increase ambient light intensity

---

## Using the Loader Package (Recommended)

The `lib/loader` package provides ready-to-use renderers for Three.js:

```typescript
import {
  WorldLoader,
  TerrainRenderer,
  FoliageRenderer,
  SkyWeatherRenderer,
  WaterRenderer,
} from "@world-editor/loader";

async function loadWorld(jsonUrl: string, scene: Scene) {
  // Load world data
  const response = await fetch(jsonUrl);
  const json = await response.text();
  const result = WorldLoader.loadWorld(json);

  if (!result.success) {
    console.error("Failed to load world:", result.errors);
    return;
  }

  const world = result.data!;
  const tile = world.mainTile!;

  // Create terrain
  const terrain = new TerrainRenderer(scene);
  terrain.create({
    heightmap: tile.heightmap,
    resolution: tile.resolution,
    splatmap: tile.splatmap,
    waterMask: tile.waterMask,
    size: tile.size,
    seaLevel: tile.seaLevel,
  });

  // Create foliage (grass, trees, etc.)
  const foliage = new FoliageRenderer(scene);
  foliage.create(tile.foliage, {
    heightmap: tile.heightmap,
    resolution: tile.resolution,
    size: tile.size,
  });

  // Create sky and weather
  const sky = new SkyWeatherRenderer(scene);
  if (world.weather) {
    sky.setWeather(world.weather);
  }
  sky.startAnimation();

  // Create water
  const water = new WaterRenderer(scene);
  water.create({
    size: tile.size,
    seaLevel: tile.seaLevel,
  });
  water.setSunDirection(sky.getSunDirection());
  water.startAnimation();

  return { terrain, foliage, sky, water };
}
```

### Available Renderers

| Renderer | Features |
|----------|----------|
| `TerrainRenderer` | LOD terrain, shader materials, splatmap |
| `FoliageRenderer` | Grass, trees, rocks with instancing |
| `SkyWeatherRenderer` | Procedural sky, clouds, rain/snow |
| `WaterRenderer` | Animated water plane with waves |

### Weather Presets

```typescript
// Available presets
sky.setWeatherPreset("clear");   // Sunny day
sky.setWeatherPreset("cloudy");  // Overcast
sky.setWeatherPreset("rainy");   // Rain
sky.setWeatherPreset("stormy");  // Heavy rain
sky.setWeatherPreset("snowy");   // Snow

// Or set time of day (0-24)
sky.setTimeOfDay(18); // Sunset
```
