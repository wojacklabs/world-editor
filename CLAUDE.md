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

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### Do NOT

- Create mock-up or fake features that simulate functionality without real implementation
- Attempt to fix issues based only on logs/symptoms without examining the actual code
- Propose unsolicited Plan B that reduces scope or changes direction when stuck
- Declare completion after just writing code - must verify via build/execution
- Partially follow official documentation then improvise the rest - follow official docs completely or ask for guidance
- Leave debug console.log/print statements after fixing issues
- Keep failed approach code "for later" - remove immediately
- Proceed to next task without cleaning up current task's artifacts
- Dismiss user-reported errors as user mistakes - trust the user's observations
- "Fix" errors by modifying core specs/requirements to make the error disappear
- Avoid solving the actual problem by working around it with alternative approaches

### Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### Revert & Cleanup Rules

#### Git Checkpoint
- Before attempting significant changes: `git add -A && git commit -m "checkpoint: before trying X"`
- When approach fails: `git checkout .` or revert to checkpoint commit
- Never leave half-finished failed attempts in the codebase

#### Debug Code Management
- When adding debug logs, use marker comment: `// DEBUG:` or `# DEBUG:`
- After fixing issue, search and remove all debug code: `grep -r "DEBUG:" .`
- Verify no debug statements remain before declaring task complete

#### Failed Approach Handling
- If an approach fails, completely remove all related code before trying next approach
- Do not comment out failed code - delete it entirely
- Use git to recover if needed later, not commented code

### Completion Checklist (verify before declaring any task done)
- [ ] All debug console.log/print removed
- [ ] No remnants of failed approaches
- [ ] No unnecessary comments added
- [ ] Build/test passes

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
