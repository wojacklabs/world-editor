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

const TOOL_ITEMS: { id: ToolType; label: string; description: string; key: string }[] = [
  { id: "select", label: "Select", description: "오브젝트 선택/정리", key: "1" },
  { id: "heightmap", label: "Terrain", description: "지형 높이 조형", key: "2" },
  { id: "biome", label: "Biome", description: "재질/수면 페인팅", key: "3" },
  { id: "props", label: "Props", description: "프롭 배치", key: "4" },
  { id: "environment", label: "Environment", description: "시간/날씨", key: "5" },
];

const HEIGHTMAP_TOOLS: { id: HeightmapTool; label: string; key: string }[] = [
  { id: "raise", label: "Raise", key: "Q" },
  { id: "lower", label: "Lower", key: "T" },
  { id: "flatten", label: "Flatten", key: "E" },
  { id: "smooth", label: "Smooth", key: "R" },
];

const BIOMES: { id: BiomeType; label: string; color: string }[] = [
  { id: "grass", label: "Grass", color: "#4a7c23" },
  { id: "dirt", label: "Dirt", color: "#8b6914" },
  { id: "rock", label: "Rock", color: "#6b6b6b" },
  { id: "sand", label: "Sand", color: "#c2a366" },
  { id: "water", label: "Water", color: "#2d6a8f" },
];

const PROP_TYPES: { id: ProceduralAssetType; label: string }[] = [
  { id: "rock", label: "Rock" },
  { id: "tree", label: "Tree" },
  { id: "bush", label: "Bush" },
  { id: "grass_clump", label: "Grass" },
];

function SliderField({
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
    <label className="block">
      <div className="flex items-center justify-between text-[11px] mb-1.5">
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
        className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-300 [&::-webkit-slider-thumb]:rounded-full hover:[&::-webkit-slider-thumb]:bg-white"
      />
    </label>
  );
}

function PanelSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-zinc-800/70 rounded-xl bg-zinc-900/30">
      <header className="px-3 py-2.5 border-b border-zinc-800/60">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{title}</h3>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

export default function EditorSidebar() {
  const {
    activeTool,
    activeHeightmapTool,
    selectedMaterial,
    selectedAssetType,
    brushSettings,
    assetSettings,
    waterType,
    waterFlowAngle,
    pendingAsset,
    setActiveTool,
    setActiveHeightmapTool,
    setSelectedMaterial,
    setSelectedAssetType,
    setBrushSize,
    setBrushStrength,
    setAssetSize,
    setWaterType,
    setWaterFlowAngle,
    randomizeAssetSeed,
    clearPendingAsset,
  } = useEditorStore();

  return (
    <aside className="w-72 h-full min-h-0 bg-zinc-950 border-r border-zinc-800/60 flex flex-col shrink-0">
      <header className="p-3 border-b border-zinc-800/60">
        <h2 className="text-sm font-medium text-zinc-200">Workflow</h2>
        <p className="text-[11px] text-zinc-600 mt-1">모드를 먼저 선택하고 캔버스에서 바로 작업합니다.</p>
      </header>

      <div className="p-2 border-b border-zinc-800/60">
        {TOOL_ITEMS.map((tool) => (
          <button
            key={tool.id}
            onClick={() => setActiveTool(tool.id)}
            className={`w-full px-2.5 py-2 rounded-lg flex items-center gap-2 transition-all ${
              activeTool === tool.id
                ? "bg-zinc-800 text-zinc-200"
                : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
            }`}
          >
            <span className="w-5 text-[10px] text-zinc-600">{tool.key}</span>
            <div className="flex-1 text-left min-w-0">
              <div className="text-xs">{tool.label}</div>
              <div className="text-[10px] text-zinc-600 truncate">{tool.description}</div>
            </div>
          </button>
        ))}
      </div>

      {pendingAsset && (
        <div className="mx-3 mt-3 px-2.5 py-2 bg-zinc-900 border border-zinc-800 rounded-lg">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[11px] text-zinc-300 truncate">
                Place: {pendingAsset.name}
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

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTool === "heightmap" && (
          <>
            <PanelSection title="Brush Mode">
              <div className="grid grid-cols-2 gap-1.5">
                {HEIGHTMAP_TOOLS.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => setActiveHeightmapTool(tool.id)}
                    className={`py-1.5 text-[11px] rounded-md transition-all ${
                      activeHeightmapTool === tool.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {tool.label}
                    <span className="ml-1 text-[10px] text-zinc-600">{tool.key}</span>
                  </button>
                ))}
              </div>
            </PanelSection>
            <PanelSection title="Brush">
              <div className="space-y-3">
                <SliderField
                  label="Size"
                  value={brushSettings.size}
                  valueText={`${brushSettings.size}`}
                  min={1}
                  max={50}
                  onChange={setBrushSize}
                />
                <SliderField
                  label="Strength"
                  value={brushSettings.strength}
                  valueText={`${Math.round(brushSettings.strength * 100)}%`}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={setBrushStrength}
                />
              </div>
            </PanelSection>
          </>
        )}

        {activeTool === "biome" && (
          <>
            <PanelSection title="Material">
              <div className="space-y-1">
                {BIOMES.map((biome) => (
                  <button
                    key={biome.id}
                    onClick={() => setSelectedMaterial(biome.id)}
                    className={`w-full px-2.5 py-2 rounded-md flex items-center gap-2 transition-all ${
                      selectedMaterial === biome.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    <span className="w-3 h-3 rounded" style={{ backgroundColor: biome.color }} />
                    <span className="text-xs">{biome.label}</span>
                  </button>
                ))}
              </div>
            </PanelSection>

            <PanelSection title="Brush">
              <SliderField
                label="Size"
                value={brushSettings.size}
                valueText={`${brushSettings.size}`}
                min={1}
                max={50}
                onChange={setBrushSize}
              />
            </PanelSection>

            {selectedMaterial === "water" && (
              <PanelSection title="Water">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-1.5">
                    {(["lake", "river"] as WaterType[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setWaterType(type)}
                        className={`py-1.5 text-xs rounded-md transition-all ${
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
                    <SliderField
                      label="Direction"
                      value={waterFlowAngle}
                      valueText={`${Math.round(waterFlowAngle)}°`}
                      min={0}
                      max={360}
                      step={5}
                      onChange={setWaterFlowAngle}
                    />
                  )}
                </div>
              </PanelSection>
            )}
          </>
        )}

        {activeTool === "props" && (
          <>
            <PanelSection title="Asset">
              <div className="grid grid-cols-2 gap-1.5">
                {PROP_TYPES.map((type) => (
                  <button
                    key={type.id}
                    onClick={() => {
                      setSelectedAssetType(type.id);
                      clearPendingAsset();
                    }}
                    className={`py-2 text-xs rounded-md transition-all ${
                      selectedAssetType === type.id
                        ? "bg-zinc-800 text-zinc-200"
                        : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    {type.label}
                  </button>
                ))}
              </div>
            </PanelSection>
            <PanelSection title="Placement">
              <div className="space-y-3">
                <SliderField
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
                  className="w-full py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-md text-zinc-400 hover:text-zinc-300 hover:border-zinc-700"
                >
                  Randomize Seed (Shift+R)
                </button>
              </div>
            </PanelSection>
          </>
        )}

        {activeTool === "select" && (
          <PanelSection title="Selection">
            <p className="text-xs text-zinc-400">오브젝트를 선택해서 우측 패널에서 수정하세요.</p>
            <p className="text-[10px] text-zinc-600 mt-1.5">Delete: 제거 / Esc: 선택 해제</p>
          </PanelSection>
        )}

        {activeTool === "environment" && (
          <PanelSection title="Environment">
            <WeatherPanel />
          </PanelSection>
        )}
      </div>
    </aside>
  );
}
