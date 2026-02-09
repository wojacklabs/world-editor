"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { EditorEngine } from "@/lib/editor/core/EditorEngine";
import EditorToolbar from "@/components/editor/EditorToolbar";
import EditorSidebar from "@/components/editor/EditorSidebar";
import EditorInspector from "@/components/editor/EditorInspector";
import AssetChatPanel from "@/components/editor/AssetChatPanel";
import AssetLibraryPanel from "@/components/editor/AssetLibraryPanel";
import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { HanokPlanPreset } from "@/lib/editor/types/EditorTypes";
import { SavedAsset } from "@/lib/editor/assets/AssetLibrary";
import { MeshData, createMeshFromData } from "@/lib/editor/assets/CustomMeshBuilder";
import { getManualTileManager } from "@/lib/editor/tiles/ManualTileManager";
import { createWorldRenderingConfig } from "@/lib/shared/foliage/FoliageQualityProfile";

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const WorldEditor = dynamic(
  () => import("@/components/editor/WorldEditor"),
  { ssr: false }
);

// Placed asset in the scene
export interface PlacedAsset {
  id: string;
  name: string;
  glbPath?: string;
  node: THREE.Group;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export default function EditorPage() {
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [isGameMode, setIsGameMode] = useState(false);
  const [leftPanelVisible, setLeftPanelVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("terrain-project");
  const [dispStrength, setDispStrength] = useState(0.5);
  const [terrainResolution, setTerrainResolution] = useState(512);
  const [terrainSize, setTerrainSize] = useState(64);
  const [activeTileId, setActiveTileId] = useState<string | null>(null);
  const [tileDirty, setTileDirty] = useState(false);
  const { setModified, resetState, weather } = useEditorStore();

  // Placed assets management
  const [placedAssets, setPlacedAssets] = useState<PlacedAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const handleEngineReady = useCallback((eng: EditorEngine) => {
    setEngine(eng);
    eng.setOnGameModeChange(setIsGameMode);
  }, []);

  const handleNewProject = useCallback(() => {
    if (engine) {
      engine.createNewTerrain(terrainSize, terrainResolution);
      resetState();
      // Clear all placed assets
      const scene = engine.getScene();
      placedAssets.forEach((asset) => scene.remove(asset.node));
      setPlacedAssets([]);
      setSelectedAssetId(null);
    }
  }, [engine, resetState, placedAssets, terrainSize, terrainResolution]);

  const handleSave = useCallback(() => {
    setIsSaveDialogOpen(true);
  }, []);

  const handleSaveConfirm = useCallback(() => {
    if (!engine) return;

    const heightmap = engine.getHeightmap();
    const terrainMesh = engine.getTerrainMesh();
    if (!heightmap || !terrainMesh) return;

    const splatMap = terrainMesh.getSplatMap();
    const foliageData = engine.exportFoliageData();
    const proceduralProps = engine.exportProceduralProps();

    const project = {
      version: "2.0.0",
      name: projectName,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      terrain: {
        size: heightmap.getScale(),
        resolution: heightmap.getResolution() - 1,
        heightmap: heightmap.toBase64(),
        splatmap: splatMap.toBase64(),
        seaLevel: engine.getSeaLevel(),
      },
      materials: { slots: [] },
      props: placedAssets.map((a) => ({
        id: a.id,
        name: a.name,
        glbPath: a.glbPath,
        position: a.position,
        rotation: a.rotation,
        scale: a.scale,
      })),
      rendering: createWorldRenderingConfig(),
      proceduralProps: proceduralProps,
      foliage: foliageData,
      settings: {
        seamlessTiling: false,
        waterLevel: 0,
        dispStrength: dispStrength,
      },
      weather: {
        timeOfDay: weather.timeOfDay,
        weatherPreset: weather.weatherPreset,
        cloudCoverage: weather.cloudCoverage,
        precipitationIntensity: weather.precipitationIntensity,
        windSpeed: weather.windSpeed,
        windDirection: weather.windDirection,
        fogDensity: weather.fogDensity,
      },
    };

    const json = JSON.stringify(project, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    // Sanitize filename
    const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, "-") || "terrain-project";

    const a = document.createElement("a");
    a.href = url;
    a.download = `${sanitizedName}.json`;
    a.click();

    URL.revokeObjectURL(url);
    setModified(false);
    setIsSaveDialogOpen(false);
  }, [engine, setModified, placedAssets, projectName, dispStrength, weather]);

  const handleExportGLB = useCallback(async () => {
    if (!engine) return;

    const terrainMesh = engine.getTerrainMesh();
    if (!terrainMesh) return;

    let bakedMesh: THREE.Mesh | null = null;
    try {
      const { GLTFExporter } = await import("three/addons/exporters/GLTFExporter.js");

      // Create baked mesh with displacement applied to vertices
      bakedMesh = terrainMesh.createBakedMeshForExport();
      if (!bakedMesh) {
        alert("Failed to create export mesh");
        return;
      }

      const exporter = new GLTFExporter();
      const glb = await exporter.parseAsync(bakedMesh, { binary: true });

      const blob = new Blob(
        [glb instanceof ArrayBuffer ? glb : JSON.stringify(glb)],
        { type: "application/octet-stream" }
      );
      const url = URL.createObjectURL(blob);

      const a = document.createElement("a");
      a.href = url;
      a.download = "terrain.glb";
      a.click();

      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Failed to export GLB:", error);
      alert("Failed to export GLB. Check console for details.");
    } finally {
      // Clean up temporary export mesh
      if (bakedMesh) {
        const scene = engine.getScene();
        scene.remove(bakedMesh);
        bakedMesh.geometry?.dispose();
        if (bakedMesh.material) {
          if (Array.isArray(bakedMesh.material)) {
            bakedMesh.material.forEach((m) => m.dispose());
          } else {
            bakedMesh.material.dispose();
          }
        }
      }
    }
  }, [engine]);

  const handleExportHeightmap = useCallback(() => {
    if (!engine) return;

    const heightmap = engine.getHeightmap();
    if (!heightmap) return;

    const dataUrl = heightmap.toPNGDataURL();

    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = "heightmap.png";
    a.click();
  }, [engine]);

  const handleTerrainSizeChange = useCallback((value: number) => {
    setTerrainSize(value);
    if (engine) {
      engine.createNewTerrain(value, terrainResolution);
      setModified(true);
    }
  }, [engine, terrainResolution, setModified]);

  const handleDispStrengthChange = useCallback((value: number) => {
    setDispStrength(value);
    if (!engine) return;

    const terrainMesh = engine.getTerrainMesh();
    if (terrainMesh) {
      terrainMesh.setDispStrength(value);
      // Displacement is now handled in GPU shader - no CPU update needed
      setModified(true);
    }
  }, [engine, setModified]);

  const handleTerrainResolutionChange = useCallback((value: number) => {
    setTerrainResolution(value);
    if (engine) {
      // Recreate terrain with new resolution
      engine.createNewTerrain(terrainSize, value);
      setModified(true);
    }
  }, [engine, terrainSize, setModified]);

  const handleToggleGameMode = useCallback(() => {
    if (engine) {
      engine.toggleGameMode();
    }
  }, [engine]);

  // ============================================
  // Manual Tile Management Handlers
  // ============================================

  const handleSaveTile = useCallback((name: string, existingId?: string) => {
    if (!engine) return;

    const tileData = engine.getCurrentTileData();
    if (!tileData) return;

    const tileManager = getManualTileManager();
    const newId = tileManager.saveTileFromCurrent(
      name,
      tileData.heightmapData,
      tileData.splatmapData,
      tileData.waterMaskData,
      tileData.resolution,
      tileData.size,
      tileData.seaLevel,
      tileData.waterDepth,
      existingId,
      tileData.foliageData
    );

    setActiveTileId(newId);
    setTileDirty(false);
    console.log(`[Page] Tile saved: ${name} (${newId}), foliage types: ${Object.keys(tileData.foliageData || {}).length}`);
  }, [engine]);

  const handleLoadTile = useCallback((tileId: string) => {
    if (!engine) return;

    const tileManager = getManualTileManager();
    const tile = tileManager.loadTile(tileId);
    if (!tile) return;

    engine.loadTileData(
      tile.heightmapData,
      tile.splatmapData,
      tile.waterMaskData,
      tile.resolution,
      tile.size,
      tile.seaLevel,
      tile.waterDepth,
      tile.foliageData
    );

    setActiveTileId(tileId);
    setTileDirty(false);
    console.log(`[Page] Tile loaded: ${tile.name} (${tileId}), foliage: ${tile.foliageData ? 'yes' : 'no'}`);
  }, [engine]);

  const handleCreateNewTile = useCallback((name: string) => {
    if (!engine) return;

    const tileManager = getManualTileManager();
    const newId = tileManager.createTile(name, terrainResolution, 64);

    // Load the newly created tile (no foliage data for new tiles - will generate)
    const tile = tileManager.loadTile(newId);
    if (tile) {
      engine.loadTileData(
        tile.heightmapData,
        tile.splatmapData,
        tile.waterMaskData,
        tile.resolution,
        tile.size,
        tile.seaLevel,
        tile.waterDepth,
        tile.foliageData
      );
    }

    setActiveTileId(newId);
    setTileDirty(false);
    console.log(`[Page] New tile created: ${name} (${newId})`);
  }, [engine, terrainResolution]);

  // Mark tile dirty when modified
  useEffect(() => {
    if (engine) {
      engine.setOnModified(() => {
        setModified(true);
        setTileDirty(true);
      });
    }
  }, [engine, setModified]);

  // Handle mesh generated from Claude Code
  const handleMeshGenerated = useCallback((meshData: MeshData) => {
    if (!engine) return;

    const scene = engine.getScene();

    // Remove previous preview if exists
    const existingPreview = scene.getObjectByName("claude_preview");
    if (existingPreview) {
      scene.remove(existingPreview);
      if (existingPreview instanceof THREE.Mesh) {
        existingPreview.geometry?.dispose();
        if (existingPreview.material) {
          if (Array.isArray(existingPreview.material)) {
            existingPreview.material.forEach((m) => m.dispose());
          } else {
            existingPreview.material.dispose();
          }
        }
      }
    }

    // Create mesh from data
    const mesh = createMeshFromData(meshData, scene);
    mesh.name = "claude_preview";

    // Position at center of terrain, slightly above
    const heightmap = engine.getHeightmap();
    if (heightmap) {
      const centerX = heightmap.getScale() / 2;
      const centerZ = heightmap.getScale() / 2;
      const centerY = heightmap.getInterpolatedHeight(centerX, centerZ);
      mesh.position.set(centerX, centerY, centerZ);
    } else {
      mesh.position.set(32, 0, 32);
    }

    console.log(`Created preview mesh: ${meshData.name} (${meshData.vertices.length / 3} vertices)`);
  }, [engine]);

  // Handle GLB generated from Meshy API or loaded from library
  const handleGlbGenerated = useCallback(async (glbPath: string, name: string) => {
    if (!engine) return;

    const scene = engine.getScene();

    try {
      console.log(`Loading GLB: ${glbPath}`);

      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(glbPath);

      // Create a unique ID for this placed asset
      const assetId = `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create a parent Group for all loaded meshes
      const parent = new THREE.Group();
      parent.name = assetId;

      // Move children from loaded scene to parent group
      while (gltf.scene.children.length > 0) {
        const child = gltf.scene.children[0];
        child.name = `${assetId}_mesh_${parent.children.length}`;
        parent.add(child);
      }

      // Position at center of terrain
      const heightmap = engine.getHeightmap();
      let posX = 32, posY = 1, posZ = 32;
      if (heightmap) {
        posX = heightmap.getScale() / 2;
        posZ = heightmap.getScale() / 2;
        posY = heightmap.getInterpolatedHeight(posX, posZ) + 1;
      }
      parent.position.set(posX, posY, posZ);

      scene.add(parent);

      // Add to placed assets list
      const placedAsset: PlacedAsset = {
        id: assetId,
        name,
        glbPath,
        node: parent,
        position: { x: posX, y: posY, z: posZ },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };

      setPlacedAssets((prev) => [...prev, placedAsset]);
      setSelectedAssetId(assetId);
      setModified(true);

      console.log(`Placed asset: ${name} (${parent.children.length} meshes)`);
    } catch (error) {
      console.error("Failed to load GLB:", error);
      alert(`GLB 로드 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}`);
    }
  }, [engine, setModified]);

  // Update placed asset transform
  const handleUpdateAsset = useCallback((
    assetId: string,
    updates: Partial<Pick<PlacedAsset, "position" | "rotation" | "scale">>
  ) => {
    setPlacedAssets((prev) =>
      prev.map((asset) => {
        if (asset.id !== assetId) return asset;

        const updated = { ...asset };

        if (updates.position) {
          updated.position = updates.position;
          asset.node.position.set(
            updates.position.x,
            updates.position.y,
            updates.position.z
          );
        }

        if (updates.rotation) {
          updated.rotation = updates.rotation;
          asset.node.rotation.set(
            updates.rotation.x * Math.PI / 180,
            updates.rotation.y * Math.PI / 180,
            updates.rotation.z * Math.PI / 180
          );
        }

        if (updates.scale) {
          updated.scale = updates.scale;
          asset.node.scale.set(
            updates.scale.x,
            updates.scale.y,
            updates.scale.z
          );
        }

        return updated;
      })
    );
    setModified(true);
  }, [setModified]);

  // Delete placed asset
  const handleDeleteAsset = useCallback((assetId: string) => {
    setPlacedAssets((prev) => {
      const asset = prev.find((a) => a.id === assetId);
      if (asset && engine) {
        engine.getScene().remove(asset.node);
      }
      return prev.filter((a) => a.id !== assetId);
    });
    if (selectedAssetId === assetId) {
      setSelectedAssetId(null);
    }
    setModified(true);
  }, [engine, selectedAssetId, setModified]);

  // Randomize rotation
  const handleRandomizeRotation = useCallback((assetId: string) => {
    const randomY = Math.random() * 360;
    handleUpdateAsset(assetId, {
      rotation: { x: 0, y: randomY, z: 0 },
    });
  }, [handleUpdateAsset]);

  // Handle procedural asset placement (Props tab)
  const handleProceduralAssetPlace = useCallback((
    assetType: string,
    _name: string,
    position: { x: number; y: number; z: number },
    settings: {
      size: number;
      seed: number;
      length: number;
      width: number;
      height: number;
      baySize: number;
      planPreset: HanokPlanPreset;
    }
  ): { id: string; newSeed: number } | null => {
    if (!engine) return null;

    const result = engine.placeProp(assetType, position.x, position.z, settings);
    if (result) {
      setModified(true);
      // Generate new seed for next placement
      const newSeed = Math.random() * 10000;
      return { id: result, newSeed };
    }
    return null;
  }, [engine, setModified]);

  // Handle library asset placement at specific position (click-to-place)
  const handleLibraryAssetPlace = useCallback(async (
    glbPath: string,
    name: string,
    position: { x: number; y: number; z: number }
  ) => {
    if (!engine) return;

    const scene = engine.getScene();

    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(glbPath);

      const assetId = `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const parent = new THREE.Group();
      parent.name = assetId;

      while (gltf.scene.children.length > 0) {
        const child = gltf.scene.children[0];
        child.name = `${assetId}_mesh_${parent.children.length}`;
        parent.add(child);
      }

      // Position at clicked location
      parent.position.set(position.x, position.y, position.z);

      scene.add(parent);

      const placedAsset: PlacedAsset = {
        id: assetId,
        name,
        glbPath,
        node: parent,
        position,
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      };

      setPlacedAssets((prev) => [...prev, placedAsset]);
      setSelectedAssetId(assetId);
      setModified(true);

      console.log(`Placed asset at clicked position: ${name}`);
    } catch (error) {
      console.error("Failed to load GLB:", error);
    }
  }, [engine, setModified]);

  // Handle saved asset selection from library (now uses placement mode)
  const handleAssetSelect = useCallback((asset: SavedAsset) => {
    // Asset selection from library now handled by setPendingAsset in AssetLibraryPanel
    // This callback is only for legacy mesh data assets
    if (asset.meshData) {
      handleMeshGenerated(asset.meshData);
    }
    setIsLibraryOpen(false);
  }, [handleMeshGenerated]);

  // Handle asset saved notification
  const handleAssetSaved = useCallback((asset: SavedAsset) => {
    console.log("Asset saved:", asset.name);
  }, []);

  // Keyboard shortcut for game mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "p" && !isGameMode) {
        handleToggleGameMode();
      }
      // Delete selected asset
      if ((e.key === "Delete" || e.key === "Backspace") && selectedAssetId) {
        handleDeleteAsset(selectedAssetId);
      }
      // Deselect
      if (e.key === "Escape") {
        setSelectedAssetId(null);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleToggleGameMode, isGameMode, selectedAssetId, handleDeleteAsset]);

  return (
    <div className="editor-shell flex flex-col h-screen w-screen overflow-hidden">
      <EditorToolbar
        engine={engine}
        isGameMode={isGameMode}
        leftPanelVisible={leftPanelVisible}
        rightPanelVisible={rightPanelVisible}
        onNewProject={handleNewProject}
        onSave={handleSave}
        onExportGLB={handleExportGLB}
        onExportHeightmap={handleExportHeightmap}
        onToggleGameMode={handleToggleGameMode}
        onToggleLeftPanel={() => setLeftPanelVisible((prev) => !prev)}
        onToggleRightPanel={() => setRightPanelVisible((prev) => !prev)}
        onOpenAIChat={() => setIsChatOpen(true)}
        onOpenLibrary={() => setIsLibraryOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        {!isGameMode && leftPanelVisible && (
          <div className="hidden lg:flex h-full">
            <EditorSidebar />
          </div>
        )}

        <div className="flex-1">
          <WorldEditor
            onEngineReady={handleEngineReady}
            onLibraryAssetPlace={handleLibraryAssetPlace}
            onProceduralAssetPlace={handleProceduralAssetPlace}
          />
        </div>

        {!isGameMode && rightPanelVisible && (
          <div className="hidden xl:flex h-full">
            <EditorInspector
              onSaveTile={handleSaveTile}
              onLoadTile={handleLoadTile}
              onCreateNewTile={handleCreateNewTile}
              activeTileId={activeTileId}
              isDirty={tileDirty}
              dispStrength={dispStrength}
              onDispStrengthChange={handleDispStrengthChange}
              terrainResolution={terrainResolution}
              onTerrainResolutionChange={handleTerrainResolutionChange}
              terrainSize={terrainSize}
              onTerrainSizeChange={handleTerrainSizeChange}
              assets={placedAssets}
              selectedAssetId={selectedAssetId}
              onSelectAsset={setSelectedAssetId}
              onUpdateAsset={handleUpdateAsset}
              onDeleteAsset={handleDeleteAsset}
              onRandomizeRotation={handleRandomizeRotation}
            />
          </div>
        )}
      </div>

      {/* AI Asset Chat Panel */}
      <AssetChatPanel
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        onGlbGenerated={handleGlbGenerated}
        onAssetSaved={handleAssetSaved}
      />

      {/* Asset Library Panel */}
      <AssetLibraryPanel
        isOpen={isLibraryOpen}
        onClose={() => setIsLibraryOpen(false)}
        onAssetSelect={handleAssetSelect}
      />

      {/* Save Dialog */}
      {isSaveDialogOpen && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-6 w-96 shadow-xl">
            <h2 className="text-lg font-medium text-zinc-100 mb-4">Save Project</h2>
            <div className="mb-4">
              <label className="block text-sm text-zinc-400 mb-2">
                File Name
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  placeholder="terrain-project"
                  className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded text-zinc-100 text-sm focus:outline-none focus:border-zinc-500"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleSaveConfirm();
                    } else if (e.key === "Escape") {
                      setIsSaveDialogOpen(false);
                    }
                  }}
                />
                <span className="text-zinc-500 text-sm">.json</span>
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setIsSaveDialogOpen(false)}
                className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveConfirm}
                disabled={!projectName.trim()}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
