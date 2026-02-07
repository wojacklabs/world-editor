"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type {
  ToolType,
  HeightmapTool,
  BiomeType,
  ProceduralAssetType,
  WaterType,
} from "@/lib/editor/types/EditorTypes";
import WeatherPanel from "./WeatherPanel";

const BIOME_COLORS: Record<BiomeType, string> = {
  grass: "#4a7c23",
  dirt: "#8b6914",
  rock: "#6b6b6b",
  sand: "#c2a366",
  water: "#2d6a8f",
};

const TOOL_ITEMS: { id: ToolType; label: string; short: string; key: string }[] = [
  { id: "select", label: "Select", short: "S", key: "1" },
  { id: "heightmap", label: "Terrain", short: "T", key: "2" },
  { id: "biome", label: "Biome", short: "B", key: "3" },
  { id: "props", label: "Props", short: "P", key: "4" },
  { id: "environment", label: "Env", short: "E", key: "5" },
];

const HEIGHTMAP_TOOLS: { id: HeightmapTool; label: string; key: string }[] = [
  { id: "raise", label: "Raise", key: "Q" },
  { id: "lower", label: "Lower", key: "T" },
  { id: "flatten", label: "Flatten", key: "E" },
  { id: "smooth", label: "Smooth", key: "R" },
];

const BIOMES: { id: BiomeType; label: string; description: string }[] = [
  { id: "grass", label: "Grass", description: "풀밭" },
  { id: "dirt", label: "Dirt", description: "흙길" },
  { id: "rock", label: "Rock", description: "바위" },
  { id: "sand", label: "Sand", description: "모래" },
  { id: "water", label: "Water", description: "물" },
];

const ASSET_TYPES: { id: ProceduralAssetType; label: string }[] = [
  { id: "rock", label: "Rock" },
  { id: "tree", label: "Tree" },
  { id: "bush", label: "Bush" },
  { id: "grass_clump", label: "Grass" },
];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-[11px] font-medium text-zinc-400 uppercase tracking-wide">{title}</h3>
        {description && <p className="text-[10px] text-zinc-600 mt-1">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function Slider({
  label,
  value,
  valueText,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  valueText: string;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-2">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400 tabular-nums">{valueText}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:cursor-pointer hover:[&::-webkit-slider-thumb]:bg-zinc-300"
      />
    </div>
  );
}

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
    clearPendingAsset,
  } = useEditorStore();

  const activeToolLabel = TOOL_ITEMS.find((item) => item.id === activeTool)?.label ?? "Tool";

  const handleAssetTypeClick = (type: ProceduralAssetType) => {
    setSelectedAssetType(type);
    clearPendingAsset();
  };

  return (
    <aside className="w-80 bg-zinc-950 border-r border-zinc-800/60 flex">
      <div className="w-16 border-r border-zinc-800/60 px-2 py-3 flex flex-col items-center gap-2">
        {TOOL_ITEMS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`w-full aspect-square rounded-lg flex flex-col items-center justify-center transition-all ${
              activeTool === tool.id
                ? "bg-zinc-800 text-zinc-100 shadow-sm"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
            }`}
            title={`${tool.label} (${tool.key})`}
          >
            <span className="text-xs font-medium leading-none">{tool.short}</span>
            <span className="text-[9px] leading-none mt-1 text-zinc-500">{tool.key}</span>
          </button>
        ))}
        <div className="mt-auto text-[9px] text-zinc-600 text-center leading-tight">
          1-5
          <br />
          Mode
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="px-4 py-3 border-b border-zinc-800/60">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-200">{activeToolLabel}</h2>
            <span className="text-[10px] text-zinc-600">Context</span>
          </div>
        </header>

        {pendingAsset && (
          <div className="mx-4 mt-3 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded-lg">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse" />
                <span className="text-[11px] text-zinc-300 truncate">
                  Placing: {pendingAsset.name}
                </span>
              </div>
              <button
                onClick={clearPendingAsset}
                className="text-[10px] text-zinc-500 hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
          {activeTool === "heightmap" && (
            <>
              <Section title="Brush Mode" description="지형 편집 방식 선택">
                <div className="grid grid-cols-2 gap-1.5">
                  {HEIGHTMAP_TOOLS.map((tool) => (
                    <button
                      key={tool.id}
                      onClick={() => setActiveHeightmapTool(tool.id)}
                      className={`py-2 text-[11px] rounded-md transition-all ${
                        activeHeightmapTool === tool.id
                          ? "bg-zinc-800 text-zinc-200"
                          : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
                      }`}
                    >
                      {tool.label}
                      <span className="ml-1 text-[10px] text-zinc-600">{tool.key}</span>
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Brush Settings">
                <Slider
                  label="Size"
                  value={brushSettings.size}
                  valueText={`${brushSettings.size}`}
                  min={1}
                  max={50}
                  onChange={setBrushSize}
                />
                <Slider
                  label="Strength"
                  value={brushSettings.strength}
                  valueText={`${Math.round(brushSettings.strength * 100)}%`}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={setBrushStrength}
                />
              </Section>
            </>
          )}

          {activeTool === "biome" && (
            <>
              <Section title="Biome" description="재질을 선택해 페인팅">
                <div className="space-y-1">
                  {BIOMES.map((biome) => (
                    <button
                      key={biome.id}
                      onClick={() => setSelectedMaterial(biome.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all ${
                        selectedMaterial === biome.id ? "bg-zinc-800" : "hover:bg-zinc-900"
                      }`}
                    >
                      <div className="w-4 h-4 rounded" style={{ backgroundColor: BIOME_COLORS[biome.id] }} />
                      <div className="flex flex-col items-start min-w-0">
                        <span className={`text-xs ${selectedMaterial === biome.id ? "text-zinc-200" : "text-zinc-500"}`}>
                          {biome.label}
                        </span>
                        <span className="text-[10px] text-zinc-600">{biome.description}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </Section>

              <Section title="Brush Settings">
                <Slider
                  label="Size"
                  value={brushSettings.size}
                  valueText={`${brushSettings.size}`}
                  min={1}
                  max={50}
                  onChange={setBrushSize}
                />
              </Section>

              {selectedMaterial === "water" && (
                <Section title="Water">
                  <div className="flex gap-1">
                    {(["lake", "river"] as WaterType[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setWaterType(type)}
                        className={`flex-1 py-2 text-[11px] rounded-md transition-all ${
                          waterType === type
                            ? "bg-zinc-800 text-zinc-100"
                            : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                        }`}
                      >
                        {type === "lake" ? "Lake" : "River"}
                      </button>
                    ))}
                  </div>

                  {waterType === "river" && (
                    <Slider
                      label="Direction"
                      value={waterFlowAngle}
                      valueText={`${Math.round(waterFlowAngle)}°`}
                      min={0}
                      max={360}
                      step={5}
                      onChange={setWaterFlowAngle}
                    />
                  )}
                </Section>
              )}
            </>
          )}

          {activeTool === "props" && (
            <>
              <Section title="Asset Type" description="클릭으로 즉시 배치">
                <div className="grid grid-cols-2 gap-1.5">
                  {ASSET_TYPES.map((asset) => (
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
              </Section>

              <Section title="Placement">
                <Slider
                  label="Scale"
                  value={assetSettings.size}
                  valueText={`${assetSettings.size.toFixed(1)}x`}
                  min={0.2}
                  max={5}
                  step={0.1}
                  onChange={setAssetSize}
                />

                <button
                  onClick={randomizeAssetSeed}
                  className="w-full py-2 text-xs text-zinc-400 border border-zinc-800 rounded-lg hover:border-zinc-700 hover:text-zinc-300 transition-colors"
                >
                  Randomize Seed (Shift+R)
                </button>
              </Section>
            </>
          )}

          {activeTool === "select" && (
            <Section title="Selection">
              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-3">
                <p className="text-xs text-zinc-400">캔버스에서 오브젝트를 클릭해 선택하세요.</p>
                <p className="text-[10px] text-zinc-600 mt-2">Delete: 제거 / Esc: 해제</p>
              </div>
            </Section>
          )}

          {activeTool === "environment" && <WeatherPanel />}
        </div>

        <footer className="px-4 py-2 border-t border-zinc-800/60">
          <span className="text-[10px] text-zinc-600">Canvas-first editing</span>
        </footer>
      </div>
    </aside>
  );
}
