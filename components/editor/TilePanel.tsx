"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getManualTileManager,
  type TileRef,
  type SeamlessDirection,
} from "@/lib/editor/tiles/ManualTileManager";
import { useEditorStore } from "@/lib/editor/store/editorStore";

// ============================================
// Types
// ============================================

type TabType = "tile" | "world";
type TileMode = "clone" | "mirror";

interface TilePanelProps {
  onSaveTile: (name: string, existingId?: string) => void;
  onLoadTile: (tileId: string) => void;
  onCreateNewTile: (name: string) => void;
  activeTileId: string | null;
  isDirty: boolean;
  // From PropertiesPanel
  onMakeSeamless: () => void;
  onMakeSeamlessDirection?: (direction: SeamlessDirection) => void;
  dispStrength: number;
  onDispStrengthChange: (value: number) => void;
  terrainResolution: number;
  onTerrainResolutionChange: (value: number) => void;
  tileMode: TileMode;
  onTileModeChange: (mode: TileMode) => void;
  // World Grid callbacks
  onWorldGridChange?: () => void;
}

const RESOLUTION_OPTIONS = [128, 256, 512, 1024, 2048, 4096];

// ============================================
// Shared Components
// ============================================

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
        active
          ? "text-zinc-200 border-b-2 border-zinc-200"
          : "text-zinc-500 hover:text-zinc-400 border-b-2 border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-zinc-800/50">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full px-4 py-3 flex items-center justify-between text-[11px] font-medium text-zinc-500 uppercase tracking-wide hover:text-zinc-400 transition-colors"
      >
        <span>{title}</span>
        <span className="text-zinc-600">{isOpen ? "−" : "+"}</span>
      </button>
      {isOpen && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

// ============================================
// Tile Tab Components
// ============================================

function CurrentTileSection({
  activeTile,
  isDirty,
  onSave,
  onNew,
}: {
  activeTile: { name: string; resolution: number } | null;
  isDirty: boolean;
  onSave: () => void;
  onNew: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="p-3 bg-zinc-900 rounded-lg">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm text-zinc-200 truncate">
            {activeTile?.name || "New Tile"}
          </span>
          {isDirty && (
            <span className="text-[10px] text-yellow-500 px-1.5 py-0.5 bg-yellow-500/10 rounded">
              Unsaved
            </span>
          )}
        </div>
        {activeTile && (
          <div className="text-[10px] text-zinc-600">
            {activeTile.resolution}×{activeTile.resolution}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={onNew}
          className="py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-300 transition-colors"
        >
          New
        </button>
        <button
          onClick={onSave}
          className={`py-2 text-xs rounded transition-colors ${
            isDirty
              ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
              : "text-zinc-400 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300"
          }`}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function TileLibrarySection({
  tiles,
  activeTileId,
  onLoadTile,
  onExportTile,
  onDeleteTile,
  onImportTile,
  onDragStart,
}: {
  tiles: TileRef[];
  activeTileId: string | null;
  onLoadTile: (id: string) => void;
  onExportTile: (id: string) => void;
  onDeleteTile: (id: string) => void;
  onImportTile: () => void;
  onDragStart: (e: React.DragEvent, tileId: string) => void;
}) {
  return (
    <div className="space-y-2">
      {tiles.length === 0 ? (
        <p className="text-[10px] text-zinc-600 py-2">No saved tiles</p>
      ) : (
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {tiles.map((tile) => (
            <div
              key={tile.id}
              draggable
              onDragStart={(e) => onDragStart(e, tile.id)}
              onClick={() => onLoadTile(tile.id)}
              className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                activeTileId === tile.id
                  ? "bg-zinc-800"
                  : "hover:bg-zinc-900"
              }`}
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <span className="text-zinc-600 text-xs cursor-grab">≡</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-zinc-300 truncate">{tile.name}</div>
                  <div className="text-[10px] text-zinc-600">
                    {tile.resolution}×{tile.resolution}
                  </div>
                </div>
              </div>
              <div className="flex gap-1 ml-2">
                <button
                  onClick={(e) => { e.stopPropagation(); onExportTile(tile.id); }}
                  className="p-1 text-zinc-600 hover:text-zinc-400"
                  title="Export"
                >
                  ↓
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onDeleteTile(tile.id); }}
                  className="p-1 text-zinc-600 hover:text-red-400"
                  title="Delete"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        onClick={onImportTile}
        className="w-full py-2 text-[10px] text-zinc-500 border border-dashed border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-400 transition-colors"
      >
        + Import Tile (.json)
      </button>
    </div>
  );
}

function BrushSettingsSection() {
  const {
    activeTool,
    brushSettings,
    setBrushSize,
    setBrushStrength,
    setBrushSettings,
  } = useEditorStore();

  if (activeTool !== "heightmap" && activeTool !== "biome") {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Size */}
      <div>
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-xs text-zinc-400">Size</span>
          <span className="text-xs text-zinc-300 tabular-nums">{brushSettings.size}</span>
        </div>
        <input
          type="range"
          min="1"
          max="50"
          step="1"
          value={brushSettings.size}
          onChange={(e) => setBrushSize(parseFloat(e.target.value))}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
        />
      </div>

      {/* Strength */}
      <div>
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-xs text-zinc-400">Strength</span>
          <span className="text-xs text-zinc-300 tabular-nums">{Math.round(brushSettings.strength * 100)}%</span>
        </div>
        <input
          type="range"
          min="0.01"
          max="1"
          step="0.01"
          value={brushSettings.strength}
          onChange={(e) => setBrushStrength(parseFloat(e.target.value))}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
        />
      </div>

      {/* Falloff */}
      <div>
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-xs text-zinc-400">Falloff</span>
          <span className="text-xs text-zinc-300 tabular-nums">{Math.round(brushSettings.falloff * 100)}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={brushSettings.falloff}
          onChange={(e) => setBrushSettings({ falloff: parseFloat(e.target.value) })}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
        />
      </div>
    </div>
  );
}

function ViewSettingsSection() {
  const { showGrid, showWireframe, toggleGrid, toggleWireframe } = useEditorStore();

  return (
    <div className="flex gap-2">
      <button
        onClick={toggleGrid}
        className={`flex-1 py-2 text-xs rounded transition-all ${
          showGrid
            ? "bg-zinc-800 text-zinc-200"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
        }`}
      >
        Grid
      </button>
      <button
        onClick={toggleWireframe}
        className={`flex-1 py-2 text-xs rounded transition-all ${
          showWireframe
            ? "bg-zinc-800 text-zinc-200"
            : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50"
        }`}
      >
        Wire
      </button>
    </div>
  );
}

function TerrainSettingsSection({
  terrainResolution,
  onTerrainResolutionChange,
  dispStrength,
  onDispStrengthChange,
  tileMode,
  onTileModeChange,
  onMakeSeamless,
  onMakeSeamlessDirection,
}: {
  terrainResolution: number;
  onTerrainResolutionChange: (value: number) => void;
  dispStrength: number;
  onDispStrengthChange: (value: number) => void;
  tileMode: TileMode;
  onTileModeChange: (mode: TileMode) => void;
  onMakeSeamless: () => void;
  onMakeSeamlessDirection?: (direction: SeamlessDirection) => void;
}) {
  return (
    <div className="space-y-4">
      {/* Size & Resolution */}
      <div className="space-y-2">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">Size</span>
          <span className="text-zinc-400">64 × 64</span>
        </div>
        <div>
          <div className="flex justify-between items-baseline mb-2">
            <span className="text-xs text-zinc-500">Resolution</span>
            <span className="text-xs text-zinc-400">{terrainResolution + 1}×{terrainResolution + 1}</span>
          </div>
          <select
            value={terrainResolution}
            onChange={(e) => onTerrainResolutionChange(parseInt(e.target.value))}
            className="w-full py-1.5 px-2 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-300 cursor-pointer hover:border-zinc-700 transition-colors focus:outline-none focus:border-zinc-600"
          >
            {RESOLUTION_OPTIONS.map((res) => (
              <option key={res} value={res}>
                {res} ({res + 1}×{res + 1})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Rock Displacement */}
      <div>
        <div className="flex justify-between items-baseline mb-2">
          <span className="text-xs text-zinc-400">Rock Displacement</span>
          <span className="text-xs text-zinc-300 tabular-nums">{dispStrength.toFixed(2)}</span>
        </div>
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={dispStrength}
          onChange={(e) => onDispStrengthChange(parseFloat(e.target.value))}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-colors"
        />
      </div>

      {/* Tile Mode */}
      <div>
        <div className="text-xs text-zinc-500 mb-2">Tile Mode</div>
        <div className="flex gap-2">
          <button
            onClick={() => onTileModeChange("mirror")}
            className={`flex-1 py-1.5 text-xs rounded transition-all ${
              tileMode === "mirror"
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
            }`}
          >
            Mirror
          </button>
          <button
            onClick={() => onTileModeChange("clone")}
            className={`flex-1 py-1.5 text-xs rounded transition-all ${
              tileMode === "clone"
                ? "bg-zinc-700 text-zinc-200"
                : "text-zinc-500 border border-zinc-800 hover:text-zinc-300 hover:border-zinc-700"
            }`}
          >
            Clone
          </button>
        </div>
      </div>

      {/* Seamless */}
      <div>
        <button
          onClick={onMakeSeamless}
          className="w-full py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-300 transition-colors"
        >
          Make Seamless (All)
        </button>
        {onMakeSeamlessDirection && (
          <div className="grid grid-cols-4 gap-1 mt-2">
            {(["left", "right", "top", "bottom"] as const).map((dir) => (
              <button
                key={dir}
                onClick={() => onMakeSeamlessDirection(dir)}
                className="py-1.5 text-[10px] text-zinc-500 border border-zinc-800 rounded hover:border-zinc-600 hover:text-zinc-300 transition-colors"
                title={`Make ${dir} edge seamless`}
              >
                {dir === "left" ? "←" : dir === "right" ? "→" : dir === "top" ? "↑" : "↓"}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================
// World Tab Components
// ============================================

function WorldGridSection({
  tiles,
  onWorldGridChange,
}: {
  tiles: TileRef[];
  onWorldGridChange?: () => void;
}) {
  const tileManager = getManualTileManager();
  const [selectedCell, setSelectedCell] = useState<{ x: number; y: number } | null>(null);
  const [placements, setPlacements] = useState<Map<string, string>>(new Map());
  // Load gridSize from tileManager (persisted in worldConfig)
  const [gridSize, setGridSize] = useState(() => tileManager.getWorldConfig().gridSize || 7);
  const [gridOffset, setGridOffset] = useState({ x: 0, y: 0 }); // Pan offset

  const centerOffset = Math.floor(gridSize / 2);

  // Load placements
  useEffect(() => {
    const allPlacements = tileManager.getAllPlacements();
    const map = new Map<string, string>();
    allPlacements.forEach((p) => {
      map.set(`${p.gridX},${p.gridY}`, p.tileId);
    });
    setPlacements(map);

    // Auto-expand grid to fit all placements
    if (allPlacements.length > 0) {
      const maxDist = Math.max(
        ...allPlacements.map((p) => Math.max(Math.abs(p.gridX), Math.abs(p.gridY)))
      );
      const neededSize = maxDist * 2 + 3; // +3 for padding
      if (neededSize > gridSize) {
        setGridSize(Math.min(15, neededSize));
      }
    }
  }, [tileManager]);

  // DEBUG: Trigger world grid update when World tab is opened
  useEffect(() => {
    console.log("[WorldGridSection] Component mounted, triggering onWorldGridChange");
    onWorldGridChange?.();
  }, [onWorldGridChange]);

  const getPlacement = (x: number, y: number): string | null => {
    return placements.get(`${x},${y}`) || null;
  };

  const getTileInitial = (tileId: string): string => {
    const tile = tileManager.getTile(tileId);
    return tile?.name.charAt(0).toUpperCase() || "?";
  };

  const handleSetPlacement = (tileId: string) => {
    if (!selectedCell) return;
    tileManager.setPlacement(selectedCell.x, selectedCell.y, tileId);
    setPlacements((prev) => {
      const next = new Map(prev);
      next.set(`${selectedCell.x},${selectedCell.y}`, tileId);
      return next;
    });
    // Notify parent to update rendering
    onWorldGridChange?.();
  };

  const handleClearPlacement = () => {
    if (!selectedCell) return;
    tileManager.clearPlacement(selectedCell.x, selectedCell.y);
    setPlacements((prev) => {
      const next = new Map(prev);
      next.delete(`${selectedCell.x},${selectedCell.y}`);
      return next;
    });
    // Notify parent to update rendering
    onWorldGridChange?.();
  };

  const handlePan = (dx: number, dy: number) => {
    setGridOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  };

  const handleZoom = (delta: number) => {
    setGridSize((prev) => {
      const newSize = Math.max(3, Math.min(15, prev + delta));
      // Save to tileManager so GamePreview can read it
      tileManager.setGridSize(newSize);
      console.log("[TilePanel] handleZoom: gridSize changed from", prev, "to", newSize);
      // Notify parent to update rendering
      onWorldGridChange?.();
      return newSize;
    });
  };

  return (
    <div className="space-y-3">
      {/* Grid controls */}
      <div className="flex items-center justify-between">
        <p className="text-[10px] text-zinc-600">
          Click to assign tiles
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleZoom(-2)}
            className="w-5 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
            title="Zoom in (smaller grid)"
          >
            +
          </button>
          <span className="text-[9px] text-zinc-500 w-8 text-center">{gridSize}x{gridSize}</span>
          <button
            onClick={() => handleZoom(2)}
            className="w-5 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
            title="Zoom out (larger grid)"
          >
            -
          </button>
        </div>
      </div>

      {/* Pan controls */}
      <div className="flex justify-center gap-1">
        <button
          onClick={() => handlePan(0, -1)}
          className="w-6 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
        >
          ▲
        </button>
      </div>
      <div className="flex justify-center gap-1">
        <button
          onClick={() => handlePan(-1, 0)}
          className="w-6 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
        >
          ◀
        </button>
        <button
          onClick={() => setGridOffset({ x: 0, y: 0 })}
          className="w-6 h-5 flex items-center justify-center text-[9px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
          title="Center on (0,0)"
        >
          ●
        </button>
        <button
          onClick={() => handlePan(1, 0)}
          className="w-6 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
        >
          ▶
        </button>
      </div>
      <div className="flex justify-center gap-1">
        <button
          onClick={() => handlePan(0, 1)}
          className="w-6 h-5 flex items-center justify-center text-[10px] bg-zinc-800 hover:bg-zinc-700 rounded text-zinc-400"
        >
          ▼
        </button>
      </div>

      {/* Grid */}
      <div
        className="grid gap-px bg-zinc-700 p-px rounded"
        style={{ gridTemplateColumns: `repeat(${gridSize}, 1fr)` }}
      >
        {Array.from({ length: gridSize * gridSize }).map((_, i) => {
          const localX = (i % gridSize) - centerOffset;
          const localY = Math.floor(i / gridSize) - centerOffset;
          const x = localX + gridOffset.x;
          const y = localY + gridOffset.y;
          const placement = getPlacement(x, y);
          const isCenter = x === 0 && y === 0;
          const isSelected = selectedCell?.x === x && selectedCell?.y === y;

          return (
            <button
              key={i}
              onClick={() => setSelectedCell({ x, y })}
              className={`aspect-square flex items-center justify-center text-[10px] font-medium transition-colors ${
                isCenter
                  ? "bg-blue-600/80 text-white"
                  : placement
                  ? "bg-zinc-600 text-zinc-200"
                  : "bg-zinc-800 text-zinc-500"
              } ${isSelected ? "ring-2 ring-white ring-inset" : ""}`}
              title={`(${x}, ${y})`}
            >
              {isCenter ? "★" : placement ? getTileInitial(placement) : "?"}
            </button>
          );
        })}
      </div>

      {/* Selected cell info */}
      {selectedCell && (
        <div className="space-y-2 p-2 bg-zinc-900 rounded">
          <div className="text-[10px] text-zinc-400">
            Position: ({selectedCell.x}, {selectedCell.y})
            {selectedCell.x === 0 && selectedCell.y === 0 && (
              <span className="ml-2 text-blue-400">(Current view)</span>
            )}
          </div>
          <select
            value={getPlacement(selectedCell.x, selectedCell.y) || ""}
            onChange={(e) => {
              if (e.target.value) {
                handleSetPlacement(e.target.value);
              } else {
                handleClearPlacement();
              }
            }}
            className="w-full py-1.5 px-2 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-300 cursor-pointer focus:outline-none focus:border-zinc-600"
          >
            <option value="">? (기본 지형)</option>
            {tiles.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {getPlacement(selectedCell.x, selectedCell.y) && (
            <button
              onClick={handleClearPlacement}
              className="w-full py-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Clear assignment
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Main Component
// ============================================

export default function TilePanel({
  onSaveTile,
  onLoadTile,
  onCreateNewTile,
  activeTileId,
  isDirty,
  onMakeSeamless,
  onMakeSeamlessDirection,
  dispStrength,
  onDispStrengthChange,
  terrainResolution,
  onTerrainResolutionChange,
  tileMode,
  onTileModeChange,
  onWorldGridChange,
}: TilePanelProps) {
  const [activeTab, setActiveTab] = useState<TabType>("tile");
  const [tiles, setTiles] = useState<TileRef[]>([]);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newTileName, setNewTileName] = useState("");

  const tileManager = getManualTileManager();

  const refreshData = useCallback(() => {
    setTiles(tileManager.getTileList());
  }, [tileManager]);

  useEffect(() => {
    refreshData();
  }, [refreshData]);

  const activeTile = activeTileId ? tileManager.getTile(activeTileId) : null;

  // Tile handlers
  const handleSaveTile = () => {
    const name = activeTile?.name || `Tile ${tiles.length + 1}`;
    onSaveTile(name, activeTileId || undefined);
    refreshData();
  };

  const handleLoadTile = (tileId: string) => {
    if (isDirty && !confirm("현재 타일의 변경사항이 저장되지 않습니다. 계속하시겠습니까?")) {
      return;
    }
    onLoadTile(tileId);
  };

  const handleCreateTile = () => {
    if (newTileName.trim()) {
      onCreateNewTile(newTileName.trim());
      setNewTileName("");
      setShowCreateDialog(false);
      refreshData();
    }
  };

  const handleDeleteTile = (tileId: string) => {
    if (confirm("이 타일을 삭제하시겠습니까?")) {
      tileManager.deleteTile(tileId);
      refreshData();
    }
  };

  const handleExportTile = (tileId: string) => {
    const json = tileManager.exportTile(tileId);
    if (json) {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const tile = tileManager.getTile(tileId);
      a.href = url;
      a.download = `${tile?.name || "tile"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleImportTile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const json = ev.target?.result as string;
          const newId = tileManager.importTile(json);
          if (newId) refreshData();
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleDragStart = (e: React.DragEvent, tileId: string) => {
    e.dataTransfer.setData("tileId", tileId);
    e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="w-56 bg-zinc-950 border-l border-zinc-800/50 flex flex-col h-full">
      {/* Tab Header */}
      <div className="flex border-b border-zinc-800">
        <TabButton active={activeTab === "tile"} onClick={() => setActiveTab("tile")}>
          📝 Tile
        </TabButton>
        <TabButton active={activeTab === "world"} onClick={() => setActiveTab("world")}>
          🌍 World
        </TabButton>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === "tile" ? (
          <>
            <CollapsibleSection title="Current Tile">
              <CurrentTileSection
                activeTile={activeTile ? {
                  name: activeTile.name,
                  resolution: activeTile.resolution,
                } : null}
                isDirty={isDirty}
                onSave={handleSaveTile}
                onNew={() => setShowCreateDialog(true)}
              />
            </CollapsibleSection>

            <CollapsibleSection title={`Tile Library (${tiles.length})`}>
              <TileLibrarySection
                tiles={tiles}
                activeTileId={activeTileId}
                onLoadTile={handleLoadTile}
                onExportTile={handleExportTile}
                onDeleteTile={handleDeleteTile}
                onImportTile={handleImportTile}
                onDragStart={handleDragStart}
              />
            </CollapsibleSection>

            <CollapsibleSection title="Brush">
              <BrushSettingsSection />
            </CollapsibleSection>

            <CollapsibleSection title="View">
              <ViewSettingsSection />
            </CollapsibleSection>

            <CollapsibleSection title="Terrain">
              <TerrainSettingsSection
                terrainResolution={terrainResolution}
                onTerrainResolutionChange={onTerrainResolutionChange}
                dispStrength={dispStrength}
                onDispStrengthChange={onDispStrengthChange}
                tileMode={tileMode}
                onTileModeChange={onTileModeChange}
                onMakeSeamless={onMakeSeamless}
                onMakeSeamlessDirection={onMakeSeamlessDirection}
              />
            </CollapsibleSection>
          </>
        ) : (
          <>
            <CollapsibleSection title="World Grid">
              <p className="text-[10px] text-zinc-600 mb-3">
                기본 지형으로 무한 확장됩니다. 특정 위치에 다른 타일을 지정하려면 그리드를 클릭하세요.
              </p>
              <WorldGridSection tiles={tiles} onWorldGridChange={onWorldGridChange} />
            </CollapsibleSection>
          </>
        )}
      </div>

      {/* Shortcuts Footer */}
      <section className="p-3 border-t border-zinc-800/50">
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-zinc-600">
          <span>[ ]</span><span>Brush size</span>
          <span>G</span><span>Grid</span>
          <span>F</span><span>Wireframe</span>
        </div>
      </section>

      {/* Create Tile Dialog */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 w-72">
            <h4 className="text-sm text-zinc-200 mb-3">Create New Tile</h4>
            <input
              type="text"
              value={newTileName}
              onChange={(e) => setNewTileName(e.target.value)}
              placeholder="Tile name"
              className="w-full px-3 py-2 text-sm bg-zinc-800 border border-zinc-700 rounded text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreateTile()}
            />
            <div className="flex gap-2 mt-4">
              <button
                onClick={() => setShowCreateDialog(false)}
                className="flex-1 py-2 text-xs text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTile}
                className="flex-1 py-2 text-xs bg-zinc-700 text-zinc-200 rounded hover:bg-zinc-600"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
