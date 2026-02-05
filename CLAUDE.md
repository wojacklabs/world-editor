# CLAUDE.md

## Tech Stack

- **Framework:** Next.js 16 (App Router) + React 19
- **Language:** TypeScript 5.9 (strict mode)
- **3D Engine:** Three.js (WebGL2, custom GLSL shaders)
- **Styling:** Tailwind CSS v4 (utility classes only, no CSS modules)
- **State:** Zustand 5 (`lib/editor/store/editorStore.ts`)
- **Package Manager:** npm
- **AI:** Anthropic SDK (procedural mesh generation), Meshy.ai (3D models)

## Build & Verification

```bash
npm run dev          # Dev server (localhost:3000)
npm run build        # Production build
npm run lint         # ESLint
```

After modifying config values, shader code, or terrain parameters, always run `npm run build` to verify compilation.

## Code Conventions

- **Imports:** Use `@/*` path alias (e.g., `import { EditorEngine } from "@/lib/editor/core/EditorEngine"`)
- **Three.js imports:** Use `import * as THREE from "three"` and `import { X } from "three/addons/..."` for addons
- **Components:** `"use client"` directive, props typed with `interface Props`, default export
- **Styling:** Tailwind utilities inline, dark theme palette (`bg-zinc-950`, `text-zinc-300`, `border-zinc-800/50`)
- **State access:** `const { activeTool, setActiveTool } = useEditorStore()`

---

## Architecture & Component Dependencies

### Core Systems Hierarchy

```
EditorEngine (orchestrator)
├── Heightmap → TerrainMesh → TerrainShader
├── SplatMap → BiomeDecorator → WaterShader
├── FoliageSystem → ImpostorSystem
├── PropManager → ProceduralAsset
├── ManualTileManager (IndexedDB)
└── GamePreview (game mode)
```

### Coupled Components - Must Update Together

| When Changing | Also Update |
|--------------|-------------|
| Heightmap data | TerrainMesh, FoliageSystem, BiomeDecorator |
| SplatMap data | FoliageSystem, BiomeDecorator, TerrainShader |
| seaLevel | EditorEngine, BiomeDecorator.waterLevel, TerrainShader uniforms |
| Terrain resolution | Heightmap, SplatMap, FoliageSystem chunks, TerrainMesh LOD |
| Terrain size | FoliageSystem LOD distances, GamePreview positioning, Camera limits |
| Biome channels (0-3) | FoliageSystem density configs, TerrainShader material mapping |
| Foliage config | FoliageSystem, ImpostorSystem, GamePreview visibility |
| Grid/Tile system | ManualTileManager, GamePreview, neighbor tile loading |

### Editor ↔ Game Mode Sync

Changes must work in **both modes**:
- Editor: Full resolution, PerspectiveCamera + OrbitControls, no LOD culling
- Game: NxN tile grid, PerspectiveCamera + PointerLockControls, visibility culling enabled

**Verify in both modes when modifying:**
- Terrain rendering
- Foliage visibility/LOD
- Water system
- Camera behavior

### Save/Load Data Layers

All must serialize together:
- `heightmapData` (base64)
- `splatmapData` (base64)
- `waterMaskData` (base64)
- `foliageData` (instance matrices)

**New feature → must add to save/load flow:**
- `EditorPage.handleSaveConfirm()` - project save
- `ManualTileManager.saveTileFromCurrent()` - tile save
- `EditorEngine.loadTileData()` - tile load

### Dirty Flag Pattern

```
User action → marks dirty → on pointer-up → rebuild
```

- `foliageDirty` → `foliageSystem.generateAll()`
- `biomeDirty` → `biomeDecorator.rebuildAll()`
- Heightmap edit → sets both dirty

### Feature Addition Checklist

- [ ] Editor mode implementation
- [ ] Game mode verification
- [ ] Save serialization added
- [ ] Load deserialization added
- [ ] Dirty flag handling (if applicable)
- [ ] Neighbor tile sync (if terrain-related)

---

## Three.js Patterns

### ShaderMaterial

```typescript
// Custom shader material with uniforms
const material = new THREE.ShaderMaterial({
  vertexShader: vertexCode,
  fragmentShader: fragmentCode,
  uniforms: {
    uTime: { value: 0 },
    uTexture: { value: texture },
  },
  side: THREE.DoubleSide,
});

// Update uniforms
material.uniforms.uTime.value = time;
```

### InstancedMesh (replaces Thin Instances)

```typescript
const instMesh = new THREE.InstancedMesh(geometry, material, count);
const mat4 = new THREE.Matrix4();
for (let i = 0; i < count; i++) {
  mat4.fromArray(matrices, i * 16);
  instMesh.setMatrixAt(i, mat4);
}
instMesh.instanceMatrix.needsUpdate = true;
```

### Disposal Rules

```typescript
import { disposeMesh } from "@/lib/shared/rendering/threeHelpers";

// Use helper for complete cleanup (removes from scene, disposes geo/mat/textures)
disposeMesh(scene, mesh);

// Or manual cleanup
scene.remove(mesh);
mesh.geometry?.dispose();
mesh.material?.dispose();
```

| Resource | Dispose? | Reason |
|----------|----------|--------|
| Cloned mesh | Yes | Independent resource |
| Shared ShaderMaterial | No | Used by multiple meshes |
| Foliage mesh material | No | Shared with base mesh |
| Water shader material | No | Shared across water meshes |

### Texture Loading

```typescript
// Use RepeatWrapping explicitly (Three.js defaults to ClampToEdge)
texture.wrapS = THREE.RepeatWrapping;
texture.wrapT = THREE.RepeatWrapping;

// Color space: sRGB for diffuse, Linear for data textures
diffuseTexture.colorSpace = THREE.SRGBColorSpace;
normalMap.colorSpace = THREE.LinearSRGBColorSpace;
```

### Raycasting

```typescript
// Terrain picking (use EditorEngine.pickTerrain for consistency)
const point = engine.pickTerrain(clientX, clientY);

// Manual raycasting
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2(ndcX, ndcY);
raycaster.setFromCamera(ndc, camera);
const intersections = raycaster.intersectObjects(meshes);
```

### Render Loop

```typescript
// requestAnimationFrame-based loop (no engine.runRenderLoop)
const animate = () => {
  requestAnimationFrame(animate);
  // Update subsystems
  foliageSystem?.updateVisibility(camera.position);
  skyWeather?.update(time);
  controls.update();
  renderer.render(scene, camera);
};
animate();
```
