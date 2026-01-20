"use client";

import { useEffect, useRef, useState } from "react";
import { EditorEngine } from "@/lib/editor/core/EditorEngine";
import { useEditorStore } from "@/lib/editor/store/editorStore";

interface WorldEditorProps {
  onEngineReady?: (engine: EditorEngine) => void;
  onLibraryAssetPlace?: (glbPath: string, name: string, position: { x: number; y: number; z: number }) => void;
  onProceduralAssetPlace?: (assetType: string, name: string, position: { x: number; y: number; z: number }, scale: number, seed: number) => void;
}

export default function WorldEditor({ onEngineReady, onLibraryAssetPlace, onProceduralAssetPlace }: WorldEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EditorEngine | null>(null);
  const animationRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const [engineReady, setEngineReady] = useState(false);

  const {
    activeTool,
    activeHeightmapTool,
    brushSettings,
    selectedMaterial,
    selectedAssetType,
    assetSettings,
    showGrid,
    showWireframe,
    debugVisibility,
    debugRenderMode,
    setModified,
    randomizeAssetSeed,
    pendingAsset,
    clearPendingAsset,
  } = useEditorStore();

  // Initialize engine
  useEffect(() => {
    if (!canvasRef.current) return;

    let mounted = true;

    const initEngine = async () => {
      try {
        const engine = new EditorEngine(canvasRef.current!);
        await engine.init();

        if (!mounted) {
          engine.dispose();
          return;
        }

        engineRef.current = engine;
        setEngineReady(true);

        engine.setOnModified(() => {
          setModified(true);
        });

        onEngineReady?.(engine);
      } catch (error) {
        console.error("Failed to initialize editor engine:", error);
      }
    };

    initEngine();

    return () => {
      mounted = false;
      setEngineReady(false);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      if (engineRef.current) {
        engineRef.current.dispose();
        engineRef.current = null;
      }
    };
  }, [onEngineReady, setModified]);

  // Brush application loop
  useEffect(() => {
    if (!engineReady || !engineRef.current) return;

    const applyBrush = (time: number) => {
      const deltaTime = (time - lastTimeRef.current) / 1000;
      lastTimeRef.current = time;

      if (engineRef.current) {
        if (activeTool === "heightmap") {
          engineRef.current.applyBrush(activeHeightmapTool, brushSettings, deltaTime);
        } else if (activeTool === "biome") {
          engineRef.current.applyBiomeBrush(selectedMaterial, brushSettings);
        }
      }

      animationRef.current = requestAnimationFrame(applyBrush);
    };

    animationRef.current = requestAnimationFrame(applyBrush);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [engineReady, activeTool, activeHeightmapTool, brushSettings, selectedMaterial]);

  // Update brush preview size
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.updateBrushPreview(brushSettings.size);
    }
  }, [brushSettings.size]);

  // Update grid visibility
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setGridVisible(showGrid);
    }
  }, [showGrid]);

  // Update wireframe mode
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setWireframe(showWireframe);
    }
  }, [showWireframe]);

  // Update debug visibility
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setTerrainVisible(debugVisibility.terrain);
      engineRef.current.setSplatMapEnabled(debugVisibility.splatMap);
      engineRef.current.setWaterVisible(debugVisibility.water);
      engineRef.current.setFoliageVisible(debugVisibility.foliage);
    }
  }, [debugVisibility]);

  // Update debug render mode
  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setDebugRenderMode(debugRenderMode);
    }
  }, [debugRenderMode]);

  // Props tool: Create preview when entering props mode or when type/seed changes
  useEffect(() => {
    if (!engineReady || !engineRef.current) return;

    if (activeTool === "props") {
      // Create preview when entering props mode or type/seed changes
      engineRef.current.createPropPreview(
        selectedAssetType,
        assetSettings.size,
        assetSettings.seed
      );
      engineRef.current.setPropPreviewVisible(true);
    } else {
      // Hide preview when leaving props mode
      engineRef.current.setPropPreviewVisible(false);
    }
  }, [engineReady, activeTool, selectedAssetType, assetSettings.seed]);

  // Update preview size separately (preserves position)
  useEffect(() => {
    if (!engineReady || !engineRef.current || activeTool !== "props") return;
    engineRef.current.updatePropPreviewSize(assetSettings.size);
  }, [engineReady, activeTool, assetSettings.size]);

  // Update preview position on mouse move
  useEffect(() => {
    if (!engineReady || !engineRef.current || activeTool !== "props") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleMouseMove = () => {
      if (!engineRef.current) return;

      const scene = engineRef.current.getScene();
      const pickResult = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (mesh) => mesh.name === "terrain"
      );

      if (pickResult?.hit && pickResult.pickedPoint) {
        engineRef.current.updatePropPreviewPosition(
          pickResult.pickedPoint.x,
          pickResult.pickedPoint.z
        );
      }
    };

    canvas.addEventListener("mousemove", handleMouseMove);
    return () => canvas.removeEventListener("mousemove", handleMouseMove);
  }, [engineReady, activeTool]);

  // Handle prop placement on click (procedural assets via props tool)
  useEffect(() => {
    if (!engineReady || !engineRef.current || activeTool !== "props") return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleClick = (e: MouseEvent) => {
      if (!engineRef.current) return;

      // Ignore if shift/ctrl is held (camera pan)
      if (e.shiftKey || e.ctrlKey) return;

      const scene = engineRef.current.getScene();
      const pickResult = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (mesh) => mesh.name === "terrain"
      );

      if (pickResult?.hit && pickResult.pickedPoint) {
        const pos = pickResult.pickedPoint;
        const store = useEditorStore.getState();

        // Check if there's a pending asset to place
        if (store.pendingAsset) {
          if (store.pendingAsset.type === "library" && store.pendingAsset.glbPath) {
            // Library asset placement
            onLibraryAssetPlace?.(
              store.pendingAsset.glbPath,
              store.pendingAsset.name,
              { x: pos.x, y: pos.y, z: pos.z }
            );
            store.clearPendingAsset();
            store.setModified(true);
          } else if (store.pendingAsset.type === "procedural" && store.pendingAsset.assetType) {
            // Procedural asset placement via pending asset
            onProceduralAssetPlace?.(
              store.pendingAsset.assetType,
              store.pendingAsset.name,
              { x: pos.x, y: pos.y, z: pos.z },
              store.assetSettings.size,
              store.assetSettings.seed
            );
            store.clearPendingAsset();
            store.setModified(true);
            // Randomize seed for next placement
            store.randomizeAssetSeed();
          }
        } else {
          // Direct placement via preview (main flow for procedural assets)
          engineRef.current.updatePropPreviewPosition(pos.x, pos.z);
          const result = engineRef.current.placeCurrentPropPreview();
          if (result) {
            store.setModified(true);
            // Sync store seed with the new preview seed
            store.setAssetSettings({ seed: result.newSeed });
          }
        }
      }
    };

    canvas.addEventListener("click", handleClick);
    return () => canvas.removeEventListener("click", handleClick);
  }, [engineReady, activeTool, onLibraryAssetPlace, onProceduralAssetPlace]);

  // Handle library asset placement (any tool mode when pendingAsset is set)
  useEffect(() => {
    if (!engineReady || !engineRef.current) return;
    if (!pendingAsset || activeTool === "props") return; // Skip if in props mode (handled above)

    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleClick = (e: MouseEvent) => {
      if (!engineRef.current) return;

      // Ignore if shift/ctrl is held (camera pan)
      if (e.shiftKey || e.ctrlKey) return;

      const scene = engineRef.current.getScene();
      const pickResult = scene.pick(
        scene.pointerX,
        scene.pointerY,
        (mesh) => mesh.name === "terrain"
      );

      if (pickResult?.hit && pickResult.pickedPoint) {
        const pos = pickResult.pickedPoint;
        const store = useEditorStore.getState();

        if (store.pendingAsset?.type === "library" && store.pendingAsset.glbPath) {
          onLibraryAssetPlace?.(
            store.pendingAsset.glbPath,
            store.pendingAsset.name,
            { x: pos.x, y: pos.y, z: pos.z }
          );
          store.clearPendingAsset();
          store.setModified(true);
        }
      }
    };

    canvas.addEventListener("click", handleClick);
    return () => canvas.removeEventListener("click", handleClick);
  }, [engineReady, activeTool, pendingAsset, onLibraryAssetPlace]);

  // Disable camera wheel zoom in props mode (we handle it manually)
  useEffect(() => {
    if (!engineReady || !engineRef.current) return;

    if (activeTool === "props") {
      engineRef.current.setCameraWheelEnabled(false);
    } else {
      engineRef.current.setCameraWheelEnabled(true);
    }
  }, [engineReady, activeTool]);

  // Scroll behavior: Regular scroll = asset scale (in props mode), Shift+scroll = zoom
  useEffect(() => {
    if (!engineReady || !engineRef.current) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      // Only handle if mouse is over canvas
      if (!canvas.contains(e.target as Node)) return;

      const store = useEditorStore.getState();

      if (store.activeTool === "props") {
        e.preventDefault();
        e.stopPropagation();

        if (e.metaKey) {
          // Cmd+scroll: zoom camera
          // deltaY > 0 = scroll down = zoom out (increase radius)
          // deltaY < 0 = scroll up = zoom in (decrease radius)
          if (engineRef.current) {
            engineRef.current.zoomCamera(e.deltaY);
          }
        } else {
          // Regular scroll: change asset scale
          const delta = e.deltaY > 0 ? -0.1 : 0.1;
          const newSize = Math.max(0.2, Math.min(5, store.assetSettings.size + delta));
          store.setAssetSize(newSize);
        }
      }
      // In other modes: Babylon.js camera handles zoom normally
    };

    // Use window-level listener to catch event before Babylon.js scene handler
    window.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => window.removeEventListener("wheel", handleWheel, { capture: true });
  }, [engineReady, activeTool]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const store = useEditorStore.getState();

      // ESC to cancel pending asset
      if (e.key === "Escape") {
        if (store.pendingAsset) {
          store.clearPendingAsset();
          return;
        }
      }

      // Bracket keys for brush size
      if (e.key === "[") {
        store.setBrushSize(store.brushSettings.size - 1);
      } else if (e.key === "]") {
        store.setBrushSize(store.brushSettings.size + 1);
      }

      // Tool shortcuts
      if (e.key === "1") store.setActiveTool("select");
      if (e.key === "2") store.setActiveTool("heightmap");
      if (e.key === "3") store.setActiveTool("biome");
      if (e.key === "4") store.setActiveTool("props");

      // Heightmap tool shortcuts (when heightmap tool is active)
      if (store.activeTool === "heightmap") {
        if (e.key === "q") store.setActiveHeightmapTool("raise");
        if (e.key === "w") store.setActiveHeightmapTool("lower");
        if (e.key === "e") store.setActiveHeightmapTool("flatten");
        if (e.key === "r") store.setActiveHeightmapTool("smooth");
      }

      // Randomize asset seed when in props mode
      if (store.activeTool === "props" && e.key === "r") {
        store.randomizeAssetSeed();
      }

      // View toggles
      if (e.key === "g") store.toggleGrid();
      if (e.key === "f") store.toggleWireframe();

      // Focus on terrain
      if (e.key === "h" && engineRef.current) {
        engineRef.current.focusOnTerrain();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className="relative w-full h-full bg-zinc-900">
      <canvas
        ref={canvasRef}
        className="w-full h-full outline-none"
        style={{ touchAction: "none" }}
      />

      {/* Controls hint */}
      <div className="absolute bottom-4 left-4 text-xs text-zinc-500 bg-zinc-900/80 px-3 py-2 rounded-lg">
        <p>Drag: Rotate | Cmd+Scroll: Zoom | Shift+Drag: Pan | [ ]: Brush Size</p>
        <p className="mt-1">1-4: Tools | Q/W/E/R: Height Brushes | G: Grid | F: Wireframe</p>
        {pendingAsset && (
          <p className="mt-1 text-green-400">Click on terrain to place &quot;{pendingAsset.name}&quot; | ESC: Cancel</p>
        )}
        {activeTool === "props" && !pendingAsset && (
          <p className="mt-1 text-blue-400">Click to place | Scroll: Scale | R: Randomize</p>
        )}
      </div>
    </div>
  );
}
