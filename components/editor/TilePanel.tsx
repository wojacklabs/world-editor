"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getManualTileManager,
  type TileRef,
  type SeamlessDirection,
} from "@/lib/editor/tiles/ManualTileManager";

interface TilePanelProps {
  onSaveTile: (name: string, existingId?: string) => void;
  onLoadTile: (tileId: string) => void;
  onCreateNewTile: (name: string) => void;
  onConnectSeamless: (direction: SeamlessDirection, targetTileId: string) => void;
  activeTileId: string | null;
  isDirty: boolean;
}

export default function TilePanel({
  onSaveTile,
  onLoadTile,
  onCreateNewTile,
  onConnectSeamless,
  activeTileId,
  isDirty,
}: TilePanelProps) {
  const [tiles, setTiles] = useState<TileRef[]>([]);
  const [newTileName, setNewTileName] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [connectDirection, setConnectDirection] = useState<SeamlessDirection>("right");
  const [expandedTiles, setExpandedTiles] = useState(false);

  const tileManager = getManualTileManager();

  const refreshTileList = useCallback(() => {
    setTiles(tileManager.getTileList());
  }, [tileManager]);

  useEffect(() => {
    refreshTileList();
  }, [refreshTileList]);

  const handleCreateTile = () => {
    if (newTileName.trim()) {
      onCreateNewTile(newTileName.trim());
      setNewTileName("");
      setShowCreateDialog(false);
      refreshTileList();
    }
  };

  const handleSaveTile = () => {
    const activeTile = activeTileId ? tileManager.getTile(activeTileId) : null;
    const name = activeTile?.name || `Tile ${tiles.length + 1}`;
    onSaveTile(name, activeTileId || undefined);
    refreshTileList();
  };

  const handleLoadTile = (tileId: string) => {
    if (isDirty) {
      if (!confirm("현재 타일의 변경사항이 저장되지 않습니다. 계속하시겠습니까?")) {
        return;
      }
    }
    onLoadTile(tileId);
  };

  const handleDeleteTile = (tileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm("이 타일을 삭제하시겠습니까?")) {
      tileManager.deleteTile(tileId);
      refreshTileList();
    }
  };

  const handleExportTile = (tileId: string, e: React.MouseEvent) => {
    e.stopPropagation();
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
          if (newId) {
            refreshTileList();
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleConnect = (targetTileId: string) => {
    onConnectSeamless(connectDirection, targetTileId);
    setShowConnectDialog(false);
    refreshTileList();
  };

  const activeTile = activeTileId ? tileManager.getTile(activeTileId) : null;

  return (
    <section className="p-4">
      <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-3">
        Tile Management
      </h3>

      {/* Current Tile Status */}
      <div className="mb-4 p-3 bg-zinc-900 rounded-lg">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-zinc-400">Current</span>
          {isDirty && (
            <span className="text-[10px] text-yellow-500">Unsaved</span>
          )}
        </div>
        <div className="text-sm text-zinc-200 truncate">
          {activeTile?.name || "New Tile"}
        </div>
        {activeTile && (
          <div className="text-[10px] text-zinc-600 mt-1">
            {activeTile.resolution}x{activeTile.resolution}
          </div>
        )}
      </div>

      {/* Action Buttons */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        <button
          onClick={() => setShowCreateDialog(true)}
          className="py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-300 transition-colors"
        >
          New Tile
        </button>
        <button
          onClick={handleSaveTile}
          className={`py-2 text-xs rounded transition-colors ${
            isDirty
              ? "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
              : "text-zinc-400 border border-zinc-800 hover:border-zinc-700 hover:text-zinc-300"
          }`}
        >
          Save
        </button>
      </div>

      {/* Connect Seamless Button */}
      {activeTileId && (
        <button
          onClick={() => setShowConnectDialog(true)}
          className="w-full mb-4 py-2 text-xs text-zinc-400 border border-zinc-800 rounded hover:border-zinc-600 hover:text-zinc-300 transition-colors"
        >
          Connect Tiles (Seamless)
        </button>
      )}

      {/* Tile List */}
      <div className="space-y-2">
        <button
          onClick={() => setExpandedTiles(!expandedTiles)}
          className="flex items-center justify-between w-full text-[11px] text-zinc-500 hover:text-zinc-400"
        >
          <span>Saved Tiles ({tiles.length})</span>
          <span>{expandedTiles ? "−" : "+"}</span>
        </button>

        {expandedTiles && (
          <div className="space-y-1 max-h-48 overflow-y-auto">
            {tiles.length === 0 ? (
              <p className="text-[10px] text-zinc-600 py-2">No saved tiles</p>
            ) : (
              tiles.map((tile) => (
                <div
                  key={tile.id}
                  onClick={() => handleLoadTile(tile.id)}
                  className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${
                    activeTileId === tile.id
                      ? "bg-zinc-800"
                      : "hover:bg-zinc-900"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-zinc-300 truncate">
                      {tile.name}
                    </div>
                    <div className="text-[10px] text-zinc-600">
                      {tile.resolution}x{tile.resolution}
                      {tile.hasConnections && " • Connected"}
                    </div>
                  </div>
                  <div className="flex gap-1 ml-2">
                    <button
                      onClick={(e) => handleExportTile(tile.id, e)}
                      className="p-1 text-zinc-600 hover:text-zinc-400"
                      title="Export"
                    >
                      ↓
                    </button>
                    <button
                      onClick={(e) => handleDeleteTile(tile.id, e)}
                      className="p-1 text-zinc-600 hover:text-red-400"
                      title="Delete"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Import Button */}
      <button
        onClick={handleImportTile}
        className="w-full mt-3 py-2 text-[10px] text-zinc-500 border border-dashed border-zinc-800 rounded hover:border-zinc-700 hover:text-zinc-400 transition-colors"
      >
        Import Tile (.json)
      </button>

      {/* Create Dialog */}
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

      {/* Connect Dialog */}
      {showConnectDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 w-80">
            <h4 className="text-sm text-zinc-200 mb-3">Connect Tiles</h4>
            <p className="text-[10px] text-zinc-500 mb-4">
              Select direction and target tile to make edges seamless
            </p>

            {/* Direction Selection */}
            <div className="mb-4">
              <div className="text-[10px] text-zinc-500 mb-2">Direction from current tile:</div>
              <div className="grid grid-cols-4 gap-1">
                {(["left", "right", "top", "bottom"] as SeamlessDirection[]).map((dir) => (
                  <button
                    key={dir}
                    onClick={() => setConnectDirection(dir)}
                    className={`py-2 text-xs rounded transition-all ${
                      connectDirection === dir
                        ? "bg-zinc-700 text-zinc-200"
                        : "text-zinc-500 border border-zinc-800 hover:text-zinc-300"
                    }`}
                  >
                    {dir === "left" ? "←" : dir === "right" ? "→" : dir === "top" ? "↑" : "↓"}
                  </button>
                ))}
              </div>
            </div>

            {/* Target Tile Selection */}
            <div className="mb-4">
              <div className="text-[10px] text-zinc-500 mb-2">Target tile:</div>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {tiles
                  .filter((t) => t.id !== activeTileId)
                  .map((tile) => (
                    <button
                      key={tile.id}
                      onClick={() => handleConnect(tile.id)}
                      className="w-full text-left px-3 py-2 text-xs text-zinc-400 hover:bg-zinc-800 rounded transition-colors"
                    >
                      {tile.name}
                    </button>
                  ))}
                {tiles.filter((t) => t.id !== activeTileId).length === 0 && (
                  <p className="text-[10px] text-zinc-600 py-2">No other tiles available</p>
                )}
              </div>
            </div>

            <button
              onClick={() => setShowConnectDialog(false)}
              className="w-full py-2 text-xs text-zinc-400 border border-zinc-700 rounded hover:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
