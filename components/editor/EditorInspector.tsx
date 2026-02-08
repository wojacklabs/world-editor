"use client";

import { useState } from "react";
import type { PlacedAsset } from "@/app/page";
import { getManualTileManager } from "@/lib/editor/tiles/ManualTileManager";
import { useEditorStore } from "@/lib/editor/store/editorStore";

interface EditorInspectorProps {
  onSaveTile: (name: string, existingId?: string) => void;
  onLoadTile: (tileId: string) => void;
  onCreateNewTile: (name: string) => void;
  activeTileId: string | null;
  isDirty: boolean;
  dispStrength: number;
  onDispStrengthChange: (value: number) => void;
  terrainResolution: number;
  onTerrainResolutionChange: (value: number) => void;
  terrainSize: number;
  onTerrainSizeChange: (value: number) => void;
  assets: PlacedAsset[];
  selectedAssetId: string | null;
  onSelectAsset: (id: string | null) => void;
  onUpdateAsset: (
    id: string,
    updates: Partial<Pick<PlacedAsset, "position" | "rotation" | "scale">>
  ) => void;
  onDeleteAsset: (id: string) => void;
  onRandomizeRotation: (id: string) => void;
}

type InspectorTab = "scene" | "objects";

const TERRAIN_SIZE_OPTIONS = [64, 128, 256, 512];
const RESOLUTION_OPTIONS = [128, 256, 512, 1024, 2048, 4096];
const tileManager = getManualTileManager();

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-zinc-800/70 rounded-xl bg-zinc-900/30">
      <header className="px-3 py-2.5 border-b border-zinc-800/60 flex items-center justify-between">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
        {action}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function AxisFields({
  values,
  step,
  onChange,
}: {
  values: { x: number; y: number; z: number };
  step: number;
  onChange: (next: { x: number; y: number; z: number }) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(["x", "y", "z"] as const).map((axis) => (
        <label key={axis} className="relative">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[9px] text-zinc-600 uppercase">
            {axis}
          </span>
          <input
            type="number"
            step={step}
            value={values[axis].toFixed(step < 1 ? 1 : 0)}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              onChange({
                ...values,
                [axis]: Number.isFinite(next) ? next : 0,
              });
            }}
            className="w-full pl-5 pr-1 py-1.5 text-[11px] bg-zinc-900 border border-zinc-800 rounded text-zinc-300 text-right focus:outline-none focus:border-zinc-700"
          />
        </label>
      ))}
    </div>
  );
}

export default function EditorInspector({
  onSaveTile,
  onLoadTile,
  onCreateNewTile,
  activeTileId,
  isDirty,
  dispStrength,
  onDispStrengthChange,
  terrainResolution,
  onTerrainResolutionChange,
  terrainSize,
  onTerrainSizeChange,
  assets,
  selectedAssetId,
  onSelectAsset,
  onUpdateAsset,
  onDeleteAsset,
  onRandomizeRotation,
}: EditorInspectorProps) {
  const [preferredTab, setPreferredTab] = useState<InspectorTab>("scene");
  const [showNewTileInput, setShowNewTileInput] = useState(false);
  const [newTileName, setNewTileName] = useState("");
  const [tiles, setTiles] = useState(() => tileManager.getTileList());
  const { showGrid, showWireframe, toggleGrid, toggleWireframe } = useEditorStore();

  const activeTab: InspectorTab = selectedAssetId ? "objects" : preferredTab;
  const activeTile = activeTileId ? tileManager.getTile(activeTileId) : null;
  const selectedAsset = assets.find((asset) => asset.id === selectedAssetId) ?? null;
  const refreshTiles = () => setTiles(tileManager.getTileList());

  const handleSaveTile = () => {
    const name = activeTile?.name || `Tile ${tiles.length + 1}`;
    onSaveTile(name, activeTileId || undefined);
    refreshTiles();
  };

  const handleLoadTile = (tileId: string) => {
    if (isDirty && !confirm("현재 타일의 변경사항이 저장되지 않습니다. 계속하시겠습니까?")) {
      return;
    }
    onLoadTile(tileId);
  };

  const handleCreateTile = () => {
    const name = newTileName.trim();
    if (!name) return;
    onCreateNewTile(name);
    setNewTileName("");
    setShowNewTileInput(false);
    refreshTiles();
  };

  const handleDeleteTile = (tileId: string) => {
    if (!confirm("이 템플릿을 삭제하시겠습니까?")) {
      return;
    }
    tileManager.deleteTile(tileId);
    refreshTiles();
  };

  const handleExportTile = (tileId: string) => {
    const json = tileManager.exportTile(tileId);
    if (!json) return;

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const tile = tileManager.getTile(tileId);

    link.href = url;
    link.download = `${tile?.name || "tile"}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const handleImportTile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const json = e.target?.result as string;
        const newId = tileManager.importTile(json);
        if (newId) refreshTiles();
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <aside className="w-80 h-full min-h-0 bg-zinc-950 border-l border-zinc-800/60 flex flex-col shrink-0">
      <header className="p-2 border-b border-zinc-800/60 flex items-center gap-1.5">
        <button
          onClick={() => setPreferredTab("scene")}
          className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
            activeTab === "scene"
              ? "bg-zinc-800 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          Scene
          {isDirty && <span className="ml-1 text-amber-300">•</span>}
        </button>
        <button
          onClick={() => setPreferredTab("objects")}
          className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
            activeTab === "objects"
              ? "bg-zinc-800 text-zinc-200"
              : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
          }`}
        >
          Objects {assets.length > 0 ? `(${assets.length})` : ""}
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTab === "scene" && (
          <>
            <Section
              title="Template"
              action={
                <button
                  onClick={() => setShowNewTileInput((prev) => !prev)}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  New
                </button>
              }
            >
              <div className="p-3 bg-zinc-900 rounded-lg border border-zinc-800/70">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-zinc-200 truncate">{activeTile?.name || "New Tile"}</span>
                  {isDirty && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                      Unsaved
                    </span>
                  )}
                </div>
                {activeTile && (
                  <p className="text-[10px] text-zinc-600 mt-1">
                    {activeTile.resolution} × {activeTile.resolution}
                  </p>
                )}
              </div>

              {showNewTileInput && (
                <div className="mt-2 flex items-center gap-1.5">
                  <input
                    type="text"
                    value={newTileName}
                    onChange={(e) => setNewTileName(e.target.value)}
                    placeholder="Template name"
                    className="flex-1 px-2.5 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-200 focus:outline-none focus:border-zinc-700"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateTile();
                      if (e.key === "Escape") setShowNewTileInput(false);
                    }}
                  />
                  <button
                    onClick={handleCreateTile}
                    className="px-2.5 py-1.5 text-xs bg-zinc-800 text-zinc-200 rounded hover:bg-zinc-700"
                  >
                    Add
                  </button>
                </div>
              )}

              <div className="mt-2 grid grid-cols-2 gap-1.5">
                <button
                  onClick={handleSaveTile}
                  className={`py-1.5 text-xs rounded transition-all ${
                    isDirty
                      ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
                      : "bg-zinc-900 text-zinc-400 border border-zinc-800 hover:border-zinc-700"
                  }`}
                >
                  Save
                </button>
                <button
                  onClick={handleImportTile}
                  className="py-1.5 text-xs bg-zinc-900 text-zinc-400 border border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-300"
                >
                  Import
                </button>
              </div>
            </Section>

            <Section title={`Library (${tiles.length})`}>
              {tiles.length === 0 ? (
                <p className="text-[11px] text-zinc-600">저장된 템플릿이 없습니다.</p>
              ) : (
                <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                  {tiles.map((tile) => (
                    <div
                      key={tile.id}
                      className={`rounded-md border ${
                        tile.id === activeTileId
                          ? "bg-zinc-800/70 border-zinc-700"
                          : "bg-zinc-900/30 border-zinc-800/70"
                      }`}
                    >
                      <div className="px-2 py-1.5 flex items-center gap-2">
                        <button
                          onClick={() => handleLoadTile(tile.id)}
                          className="flex-1 text-left min-w-0"
                        >
                          <div className="text-[11px] text-zinc-200 truncate">{tile.name}</div>
                          <div className="text-[9px] text-zinc-600">{tile.resolution} × {tile.resolution}</div>
                        </button>
                        <button
                          onClick={() => handleExportTile(tile.id)}
                          className="text-[10px] text-zinc-500 hover:text-zinc-300"
                          title="Export"
                        >
                          ↓
                        </button>
                        <button
                          onClick={() => handleDeleteTile(tile.id)}
                          className="text-[10px] text-zinc-500 hover:text-red-300"
                          title="Delete"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section title="Terrain">
              <div className="space-y-3">
                <label className="block">
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="text-zinc-500">Size</span>
                    <span className="text-zinc-400">{terrainSize} × {terrainSize}</span>
                  </div>
                  <select
                    value={terrainSize}
                    onChange={(e) => onTerrainSizeChange(parseInt(e.target.value, 10))}
                    className="w-full px-2 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-200 focus:outline-none focus:border-zinc-700"
                  >
                    {TERRAIN_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size} × {size}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="text-zinc-500">Resolution</span>
                    <span className="text-zinc-400">{terrainResolution + 1} × {terrainResolution + 1}</span>
                  </div>
                  <select
                    value={terrainResolution}
                    onChange={(e) => onTerrainResolutionChange(parseInt(e.target.value, 10))}
                    className="w-full px-2 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-200 focus:outline-none focus:border-zinc-700"
                  >
                    {RESOLUTION_OPTIONS.map((res) => (
                      <option key={res} value={res}>
                        {res} ({res + 1} × {res + 1})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <div className="flex items-center justify-between text-[11px] mb-1.5">
                    <span className="text-zinc-500">Rock Displacement</span>
                    <span className="text-zinc-400 tabular-nums">{dispStrength.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.05"
                    value={dispStrength}
                    onChange={(e) => onDispStrengthChange(parseFloat(e.target.value))}
                    className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-white"
                  />
                </label>
              </div>
            </Section>

            <Section title="Viewport">
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  onClick={toggleGrid}
                  className={`py-1.5 text-xs rounded transition-all ${
                    showGrid
                      ? "bg-zinc-800 text-zinc-200"
                      : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Grid
                </button>
                <button
                  onClick={toggleWireframe}
                  className={`py-1.5 text-xs rounded transition-all ${
                    showWireframe
                      ? "bg-zinc-800 text-zinc-200"
                      : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  Wireframe
                </button>
              </div>
            </Section>
          </>
        )}

        {activeTab === "objects" && (
          <>
            <Section title={`Scene Objects (${assets.length})`}>
              {assets.length === 0 ? (
                <p className="text-[11px] text-zinc-600">오브젝트가 없습니다. Generate 또는 Library로 추가하세요.</p>
              ) : (
                <div className="space-y-1 max-h-52 overflow-y-auto pr-1">
                  {assets.map((asset) => (
                    <button
                      key={asset.id}
                      onClick={() => onSelectAsset(asset.id === selectedAssetId ? null : asset.id)}
                      className={`w-full px-2.5 py-2 rounded-md text-left flex items-center gap-2 transition-all ${
                        selectedAssetId === asset.id
                          ? "bg-zinc-800 text-zinc-200"
                          : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${selectedAssetId === asset.id ? "bg-zinc-300" : "bg-zinc-700"}`} />
                      <span className="text-xs truncate flex-1">{asset.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </Section>

            {selectedAsset && (
              <Section
                title={selectedAsset.name}
                action={
                  <button
                    onClick={() => onDeleteAsset(selectedAsset.id)}
                    className="text-[10px] text-zinc-500 hover:text-red-300"
                  >
                    Delete
                  </button>
                }
              >
                <div className="space-y-3">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-600">Position</span>
                    </div>
                    <AxisFields
                      values={selectedAsset.position}
                      step={0.5}
                      onChange={(next) => onUpdateAsset(selectedAsset.id, { position: next })}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-600">Rotation</span>
                      <button
                        onClick={() => onRandomizeRotation(selectedAsset.id)}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300"
                      >
                        Random
                      </button>
                    </div>
                    <AxisFields
                      values={selectedAsset.rotation}
                      step={15}
                      onChange={(next) => onUpdateAsset(selectedAsset.id, { rotation: next })}
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[10px] uppercase tracking-wide text-zinc-600">Scale</span>
                      <button
                        onClick={() => onUpdateAsset(selectedAsset.id, { scale: { x: 1, y: 1, z: 1 } })}
                        className="text-[10px] text-zinc-500 hover:text-zinc-300"
                      >
                        Reset
                      </button>
                    </div>
                    <div className="flex items-center justify-between text-[11px] mb-1.5">
                      <span className="text-zinc-500">Uniform</span>
                      <span className="text-zinc-400 tabular-nums">{selectedAsset.scale.x.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min="0.1"
                      max="5"
                      step="0.1"
                      value={selectedAsset.scale.x}
                      onChange={(e) => {
                        const value = parseFloat(e.target.value);
                        onUpdateAsset(selectedAsset.id, {
                          scale: { x: value, y: value, z: value },
                        });
                      }}
                      className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-white"
                    />
                  </div>
                </div>
              </Section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
