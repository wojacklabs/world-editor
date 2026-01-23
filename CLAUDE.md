# CLAUDE.md

## Communication

- Code: English
- Chat: Korean

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
- Editor: Full resolution, ArcRotateCamera, no LOD culling
- Game: NxN tile grid, FreeCamera, visibility culling enabled

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

## Babylon.js Gotchas

### WebGPU Compatibility

```typescript
// ❌ DON'T - GL extensions are built into WebGL2/WebGPU
#extension GL_OES_standard_derivatives : enable

// ❌ DON'T - WGSL doesn't support sampler function parameters
vec4 triplanarSample(sampler2D tex, ...) { ... }

// ✅ DO - Inline triplanar sampling directly in main()
vec4 sampleX = texture2D(rockTexture, coords.zy);
```

### Buffer Sharing (Critical)

```typescript
// ❌ DON'T - Reuses buffer, causes WebGPU issues
const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
newMesh.setVerticesData(VertexBuffer.PositionKind, positions);

// ✅ DO - Copy to independent array
const positions = baseMesh.getVerticesData(VertexBuffer.PositionKind);
if (positions) {
  newMesh.setVerticesData(VertexBuffer.PositionKind, new Float32Array(positions));
}
```

### Disposal Rules

| Resource | Dispose? | Reason |
|----------|----------|--------|
| Cloned mesh | ✅ Yes | Independent resource |
| Shared ShaderMaterial | ❌ No | Used by multiple meshes |
| Foliage mesh material | ❌ No | Shared with base mesh |
| Water shader material | ❌ No | Shared across water meshes |
| Reference tiles (GamePreview) | ❌ No | Original mesh, not clone |

### Thin Instances

```typescript
// ✅ Correct order - always refresh bounding info last
mesh.thinInstanceSetBuffer("matrix", matrices, 16, false);
mesh.thinInstanceCount = count;
mesh.thinInstanceRefreshBoundingInfo();  // Must call after buffer set
```

### ShaderMaterial

```typescript
// ✅ Use unique name to prevent caching issues
const material = new ShaderMaterial(
  `terrain_${Date.now()}`,  // Unique name
  scene,
  { vertex: "terrain", fragment: "terrain" },
  options
);

// ✅ Always add error handler for debugging
material.onError = (effect, errors) => {
  console.error("Shader compile error:", errors);
};
```

### Material Cloning

```typescript
// ⚠️ Cloned mesh shares material by default
const clone = originalMesh.clone("clone");
clone.material = originalMesh.material;  // Same reference!

// ✅ For independent material, explicitly clone
clone.material = originalMesh.material.clone(`mat_${name}`);

// ⚠️ Often need to disable backface culling for clones
if (clone.material && "backFaceCulling" in clone.material) {
  (clone.material as StandardMaterial).backFaceCulling = false;
}
```

### Async Loading

```typescript
// ✅ Use observable for texture loading
texture.onLoadObservable.addOnce(async () => {
  const pixels = await texture.readPixels();  // Async!
  // Process pixels...
  texture.dispose();  // Cleanup after use
});
```

---

## Development Rules

### Prohibited

- Mock-up/fake features without real implementation
- Fixing issues without examining actual code
- Unsolicited Plan B that reduces scope
- Declaring completion without build/execution verification
- Partially following docs then improvising
- Leaving debug statements after fixing
- Keeping failed approach code
- Proceeding without cleanup

### Git Workflow

- Checkpoint before significant changes: `git add -A && git commit -m "checkpoint: before X"`
- On failure: `git checkout .` or revert to checkpoint
- No half-finished attempts in codebase

### Debug Code

- Use marker: `// DEBUG:` or `# DEBUG:`
- Remove all before completion: `grep -r "DEBUG:" .`

### Failed Approaches

- Delete entirely, don't comment out
- Use git to recover if needed

### Completion Checklist

- [ ] Debug statements removed
- [ ] Failed approach remnants removed
- [ ] No unnecessary comments
- [ ] Build/test passes
