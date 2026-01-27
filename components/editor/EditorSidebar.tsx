"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { ToolType, HeightmapTool, MaterialType, BiomeType, ProceduralAssetType, WaterType } from "@/lib/editor/types/EditorTypes";

const BIOME_COLORS: Record<BiomeType, string> = {
  grass: "#4a7c23",
  dirt: "#8b6914",
  rock: "#6b6b6b",
  sand: "#c2a366",
  water: "#2d6a8f",
};

export default function EditorSidebar() {
  const {
    activeTool,
    activeHeightmapTool,
    selectedMaterial,
    selectedAssetType,
    assetSettings,
    brushSettings,
    pendingAsset,
    setActiveTool,
    setActiveHeightmapTool,
    setSelectedMaterial,
    setSelectedAssetType,
    setAssetSize,
    setBrushSize,
    setBrushStrength,
    randomizeAssetSeed,
    waterType,
    waterFlowAngle,
    setWaterType,
    setWaterFlowAngle,
    setPendingAsset,
    clearPendingAsset,
  } = useEditorStore();

  const tools: { id: ToolType; label: string; key: string }[] = [
    { id: "select", label: "Select", key: "1" },
    { id: "heightmap", label: "Terrain", key: "2" },
    { id: "biome", label: "Biome", key: "3" },
    { id: "props", label: "Props", key: "4" },
  ];

  const heightmapTools: { id: HeightmapTool; label: string; key: string }[] = [
    { id: "raise", label: "Raise", key: "Q" },
    { id: "lower", label: "Lower", key: "W" },
    { id: "flatten", label: "Flat", key: "E" },
    { id: "smooth", label: "Smooth", key: "R" },
  ];

  const biomes: { id: BiomeType; label: string; description: string }[] = [
    { id: "grass", label: "Grass", description: "풀밭" },
    { id: "dirt", label: "Dirt", description: "흙길" },
    { id: "rock", label: "Rock", description: "바위" },
    { id: "sand", label: "Sand", description: "모래" },
    { id: "water", label: "Water", description: "물" },
  ];

  const assetTypes: { id: ProceduralAssetType; label: string }[] = [
    { id: "rock", label: "Rock" },
    { id: "tree", label: "Tree" },
    { id: "bush", label: "Bush" },
    { id: "grass_clump", label: "Grass" },
  ];

  const handleAssetTypeClick = (type: ProceduralAssetType) => {
    setSelectedAssetType(type);
    // Don't set pendingAsset for procedural assets - use PropManager preview system
    clearPendingAsset();
  };

  return (
    <aside className="w-52 bg-zinc-950 border-r border-zinc-800/50 flex flex-col">
      {/* Tools */}
      <div className="p-3">
        <div className="flex gap-0.5 bg-zinc-900 rounded-lg p-0.5">
          {tools.map((tool) => (
            <button
              key={tool.id}
              onClick={() => setActiveTool(tool.id)}
              className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
                activeTool === tool.id
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
              title={tool.key}
            >
              {tool.label}
            </button>
          ))}
        </div>
      </div>

      {/* Pending Asset Indicator */}
      {pendingAsset && (
        <div className="mx-3 mb-2 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full animate-pulse" />
              <span className="text-[11px] text-zinc-400">Placing: {pendingAsset.name}</span>
            </div>
            <button
              onClick={clearPendingAsset}
              className="text-zinc-500 hover:text-zinc-300 text-[10px]"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Heightmap Tools */}
        {activeTool === "heightmap" && (
          <section className="p-3 space-y-4">
            <div>
              <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-2">
                Mode
              </h3>
              <div className="grid grid-cols-4 gap-1">
                {heightmapTools.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => setActiveHeightmapTool(tool.id)}
                    className={`py-2 text-[10px] rounded transition-all ${
                      activeHeightmapTool === tool.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
                    }`}
                    title={tool.key}
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-[11px] mb-2">
                  <span className="text-zinc-500">Size</span>
                  <span className="text-zinc-400 tabular-nums">{brushSettings.size}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="30"
                  value={brushSettings.size}
                  onChange={(e) => setBrushSize(parseInt(e.target.value))}
                  className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
                />
              </div>
              <div>
                <div className="flex justify-between text-[11px] mb-2">
                  <span className="text-zinc-500">Strength</span>
                  <span className="text-zinc-400 tabular-nums">{Math.round(brushSettings.strength * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={brushSettings.strength}
                  onChange={(e) => setBrushStrength(parseFloat(e.target.value))}
                  className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
                />
              </div>
            </div>
          </section>
        )}

        {/* Biome Selection */}
        {activeTool === "biome" && (
          <section className="p-3 space-y-4">
            <div>
              <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-2">
                Biome
              </h3>
              <div className="space-y-0.5">
                {biomes.map((biome) => (
                  <button
                    key={biome.id}
                    onClick={() => setSelectedMaterial(biome.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
                      selectedMaterial === biome.id
                        ? "bg-zinc-800"
                        : "hover:bg-zinc-900"
                    }`}
                  >
                    <div
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: BIOME_COLORS[biome.id] }}
                    />
                    <div className="flex flex-col items-start">
                      <span className={`text-xs ${selectedMaterial === biome.id ? "text-zinc-200" : "text-zinc-500"}`}>
                        {biome.label}
                      </span>
                      <span className="text-[10px] text-zinc-600">
                        {biome.description}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] mb-2">
                <span className="text-zinc-500">Size</span>
                <span className="text-zinc-400 tabular-nums">{brushSettings.size}</span>
              </div>
              <input
                type="range"
                min="1"
                max="30"
                value={brushSettings.size}
                onChange={(e) => setBrushSize(parseInt(e.target.value))}
                className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
              />
            </div>

            {/* Water Type Controls */}
            {selectedMaterial === "water" && (
              <div className="space-y-3">
                <div>
                  <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-2">
                    Water Type
                  </h3>
                  <div className="flex gap-1">
                    {(["lake", "river"] as WaterType[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setWaterType(type)}
                        className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
                          waterType === type
                            ? "bg-zinc-700 text-zinc-100"
                            : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {type === "lake" ? "Lake" : "River"}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-1">
                    {waterType === "lake" ? "잔잔한 호수" : "흐르는 강"}
                  </p>
                </div>

                {/* Flow Direction (River only) */}
                {waterType === "river" && (
                  <div>
                    <div className="flex justify-between text-[11px] mb-2">
                      <span className="text-zinc-500">Direction</span>
                      <span className="text-zinc-400 tabular-nums">{Math.round(waterFlowAngle)}&deg;</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="360"
                      step="5"
                      value={waterFlowAngle}
                      onChange={(e) => setWaterFlowAngle(parseInt(e.target.value))}
                      className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
                    />
                  </div>
                )}
              </div>
            )}

            <p className="text-[10px] text-zinc-600 mt-2">
              마우스를 떼면 데코레이션이 생성됩니다
            </p>
          </section>
        )}

        {/* Props */}
        {activeTool === "props" && (
          <section className="p-3 space-y-4">
            <div>
              <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-2">
                Asset Type
              </h3>
              <div className="grid grid-cols-2 gap-1">
                {assetTypes.map((asset) => (
                  <button
                    key={asset.id}
                    onClick={() => handleAssetTypeClick(asset.id)}
                    className={`py-3 text-xs rounded-lg transition-all ${
                      selectedAssetType === asset.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
                    }`}
                  >
                    {asset.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="flex justify-between text-[11px] mb-2">
                <span className="text-zinc-500">Scale</span>
                <span className="text-zinc-400 tabular-nums">{assetSettings.size.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="5"
                step="0.1"
                value={assetSettings.size}
                onChange={(e) => setAssetSize(parseFloat(e.target.value))}
                className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
              />
            </div>

            <button
              onClick={randomizeAssetSeed}
              className="w-full py-2 text-xs text-zinc-500 border border-zinc-800 rounded-lg hover:border-zinc-700 hover:text-zinc-400 transition-colors"
            >
              Randomize (R)
            </button>
          </section>
        )}

        {/* Select Tool */}
        {activeTool === "select" && (
          <section className="p-3">
            <div className="py-8 text-center">
              <p className="text-xs text-zinc-500">Click objects to select</p>
              <p className="text-[10px] text-zinc-600 mt-2">
                Del: Remove / Esc: Deselect
              </p>
            </div>
          </section>
        )}
      </div>

      {/* Footer */}
      <footer className="p-3 border-t border-zinc-800/50">
        <span className="text-[10px] text-zinc-600">v0.1</span>
      </footer>
    </aside>
  );
}
