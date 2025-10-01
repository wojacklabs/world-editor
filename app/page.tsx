"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { EditorEngine } from "@/lib/editor/core/EditorEngine";
import EditorToolbar from "@/components/editor/EditorToolbar";
import EditorSidebar from "@/components/editor/EditorSidebar";
import PropertiesPanel from "@/components/editor/PropertiesPanel";
import AssetChatPanel from "@/components/editor/AssetChatPanel";
import AssetLibraryPanel from "@/components/editor/AssetLibraryPanel";
import PlacedAssetPanel from "@/components/editor/PlacedAssetPanel";
import { useEditorStore } from "@/lib/editor/store/editorStore";
import { SavedAsset } from "@/lib/editor/assets/AssetLibrary";
import { MeshData, createMeshFromData } from "@/lib/editor/assets/CustomMeshBuilder";

import { SceneLoader } from "@babylonjs/core/Loading/sceneLoader";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import "@babylonjs/loaders/glTF";

const WorldEditor = dynamic(
  () => import("@/components/editor/WorldEditor"),
  { ssr: false }
);

// Placed asset in the scene
export interface PlacedAsset {
  id: string;
  name: string;
  glbPath?: string;
  node: TransformNode;
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
}

export default function EditorPage() {
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [isGameMode, setIsGameMode] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [projectName, setProjectName] = useState("terrain-project");
  const [dispStrength, setDispStrength] = useState(0.5);
  const [terrainResolution, setTerrainResolution] = useState(512);
  const { setModified, resetState } = useEditorStore();

  // Placed assets management
  const [placedAssets, setPlacedAssets] = useState<PlacedAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  const handleEngineReady = useCallback((eng: EditorEngine) => {
    setEngine(eng);
    eng.setOnGameModeChange(setIsGameMode);
  }, []);

  const handleNewProject = useCallback(() => {
    if (engine) {
      engine.createNewTerrain(64, terrainResolution);
      resetState();
      // Clear all placed assets
      placedAssets.forEach((asset) => asset.node.dispose());
      setPlacedAssets([]);
      setSelectedAssetId(null);
    }
  }, [engine, resetState, placedAssets, terrainResolution]);

  const handleSave = useCallback(() => {
    setIsSaveDialogOpen(true);
  }, []);

  const handleSaveConfirm = useCallback(() => {
    if (!engine) return;

    const heightmap = engine.getHeightmap();
    const terrainMesh = engine.getTerrainMesh();
    if (!heightmap || !terrainMesh) return;

    const splatMap = terrainMesh.getSplatMap();

    const project = {
      version: "1.1.0",
      name: projectName,
      createdAt: new Date().toISOString(),
      modifiedAt: new Date().toISOString(),
      terrain: {
        size: heightmap.getScale(),
        resolution: heightmap.getResolution() - 1,
        heightmap: heightmap.toBase64(),
        splatmap: splatMap.toBase64(),
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
      settings: {
        seamlessTiling: false,
        waterLevel: 0,
        dispStrength: dispStrength,
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
  }, [engine, setModified, placedAssets, projectName, dispStrength]);

  const handleExportGLB = useCallback(async () => {
    if (!engine) return;

    const terrainMesh = engine.getTerrainMesh();
    if (!terrainMesh) return;

    let bakedMesh = null;
    try {
      const { GLTF2Export } = await import("@babylonjs/serializers/glTF");

      // Create baked mesh with displacement applied to vertices
      bakedMesh = terrainMesh.createBakedMeshForExport();
      if (!bakedMesh) {
        alert("Failed to create export mesh");
        return;
      }

      const scene = engine.getScene();
      const glb = await GLTF2Export.GLBAsync(scene, "terrain", {
        shouldExportNode: (node) => node.name === "terrain_export",
      });

      const blob = glb.glTFFiles["terrain.glb"] as Blob;
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
        bakedMesh.material?.dispose();
        bakedMesh.dispose();
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

  const handleMakeSeamless = useCallback(() => {
    if (!engine) return;

    const heightmap = engine.getHeightmap();
    const terrainMesh = engine.getTerrainMesh();

    if (heightmap && terrainMesh) {
      heightmap.makeSeamless();
      terrainMesh.updateFromHeightmap();
      setModified(true);
    }
  }, [engine, setModified]);

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
      engine.createNewTerrain(64, value);
      setModified(true);
    }
  }, [engine, setModified]);

  const handleToggleGameMode = useCallback(() => {
    if (engine) {
      engine.toggleGameMode();
    }
  }, [engine]);

  // Handle mesh generated from Claude Code
  const handleMeshGenerated = useCallback((meshData: MeshData) => {
    if (!engine) return;

    const scene = engine.getScene();

    // Remove previous preview if exists
    const existingPreview = scene.getMeshByName("claude_preview");
    if (existingPreview) {
      existingPreview.dispose();
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
      // Parse the URL for SceneLoader
      // For local files like "/assets/model.glb", we need to split into rootUrl and filename
      let rootUrl: string;
      let fileName: string;

      if (glbPath.startsWith("/")) {
        // Local file
        const lastSlash = glbPath.lastIndexOf("/");
        rootUrl = glbPath.substring(0, lastSlash + 1);
        fileName = glbPath.substring(lastSlash + 1);
      } else if (glbPath.startsWith("http")) {
        // Remote URL
        const url = new URL(glbPath);
        const pathParts = url.pathname.split("/");
        fileName = pathParts.pop() || "";
        rootUrl = url.origin + pathParts.join("/") + "/";
      } else {
        rootUrl = "";
        fileName = glbPath;
      }

      console.log(`Loading GLB: rootUrl=${rootUrl}, fileName=${fileName}`);

      // Load GLB
      const result = await SceneLoader.ImportMeshAsync(
        "",
        rootUrl,
        fileName,
        scene
      );

      if (result.meshes.length > 0) {
        // Create a unique ID for this placed asset
        const assetId = `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create a parent TransformNode for all loaded meshes
        const parent = new TransformNode(assetId, scene);

        result.meshes.forEach((mesh, index) => {
          mesh.name = `${assetId}_mesh_${index}`;
          mesh.parent = parent;
        });

        // Position at center of terrain
        const heightmap = engine.getHeightmap();
        let posX = 32, posY = 1, posZ = 32;
        if (heightmap) {
          posX = heightmap.getScale() / 2;
          posZ = heightmap.getScale() / 2;
          posY = heightmap.getInterpolatedHeight(posX, posZ) + 1;
        }
        parent.position.set(posX, posY, posZ);

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

        console.log(`Placed asset: ${name} (${result.meshes.length} meshes)`);
      }
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
          asset.node.position = new Vector3(
            updates.position.x,
            updates.position.y,
            updates.position.z
          );
        }

        if (updates.rotation) {
          updated.rotation = updates.rotation;
          asset.node.rotation = new Vector3(
            updates.rotation.x * Math.PI / 180,
            updates.rotation.y * Math.PI / 180,
            updates.rotation.z * Math.PI / 180
          );
        }

        if (updates.scale) {
          updated.scale = updates.scale;
          asset.node.scaling = new Vector3(
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
      if (asset) {
        asset.node.dispose();
      }
      return prev.filter((a) => a.id !== assetId);
    });
    if (selectedAssetId === assetId) {
      setSelectedAssetId(null);
    }
    setModified(true);
  }, [selectedAssetId, setModified]);

  // Randomize rotation
  const handleRandomizeRotation = useCallback((assetId: string) => {
    const randomY = Math.random() * 360;
    handleUpdateAsset(assetId, {
      rotation: { x: 0, y: randomY, z: 0 },
    });
  }, [handleUpdateAsset]);

  // Handle library asset placement at specific position (click-to-place)
  const handleLibraryAssetPlace = useCallback(async (
    glbPath: string,
    name: string,
    position: { x: number; y: number; z: number }
  ) => {
    if (!engine) return;

    const scene = engine.getScene();

    try {
      let rootUrl: string;
      let fileName: string;

      if (glbPath.startsWith("/")) {
        const lastSlash = glbPath.lastIndexOf("/");
        rootUrl = glbPath.substring(0, lastSlash + 1);
        fileName = glbPath.substring(lastSlash + 1);
      } else if (glbPath.startsWith("http")) {
        const url = new URL(glbPath);
        const pathParts = url.pathname.split("/");
        fileName = pathParts.pop() || "";
        rootUrl = url.origin + pathParts.join("/") + "/";
      } else {
        rootUrl = "";
        fileName = glbPath;
      }

      const result = await SceneLoader.ImportMeshAsync("", rootUrl, fileName, scene);

      if (result.meshes.length > 0) {
        const assetId = `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const parent = new TransformNode(assetId, scene);

        result.meshes.forEach((mesh, index) => {
          mesh.name = `${assetId}_mesh_${index}`;
          mesh.parent = parent;
        });

        // Position at clicked location
        parent.position.set(position.x, position.y, position.z);

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
      }
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

  // Get selected asset
  const selectedAsset = placedAssets.find((a) => a.id === selectedAssetId);

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
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <EditorToolbar
        engine={engine}
        isGameMode={isGameMode}
        onNewProject={handleNewProject}
        onSave={handleSave}
        onExportGLB={handleExportGLB}
        onExportHeightmap={handleExportHeightmap}
        onToggleGameMode={handleToggleGameMode}
        onOpenAIChat={() => setIsChatOpen(true)}
        onOpenLibrary={() => setIsLibraryOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden">
        {!isGameMode && <EditorSidebar />}

        <div className="flex-1">
          <WorldEditor
            onEngineReady={handleEngineReady}
            onLibraryAssetPlace={handleLibraryAssetPlace}
          />
        </div>

        {!isGameMode && (
          <div className="flex flex-col bg-zinc-950">
            <PropertiesPanel
              onMakeSeamless={handleMakeSeamless}
              dispStrength={dispStrength}
              onDispStrengthChange={handleDispStrengthChange}
              terrainResolution={terrainResolution}
              onTerrainResolutionChange={handleTerrainResolutionChange}
            />
            {/* Placed Asset Panel */}
            <PlacedAssetPanel
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
