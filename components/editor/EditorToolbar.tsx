"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { EditorEngine } from "@/lib/editor/core/EditorEngine";
import type { ToolType } from "@/lib/editor/types/EditorTypes";

interface EditorToolbarProps {
  engine: EditorEngine | null;
  isGameMode: boolean;
  onNewProject: () => void;
  onSave: () => void;
  onExportGLB: () => void;
  onExportHeightmap: () => void;
  onToggleGameMode: () => void;
  onOpenAIChat?: () => void;
  onOpenLibrary?: () => void;
}

export default function EditorToolbar({
  engine,
  isGameMode,
  onNewProject,
  onSave,
  onExportGLB,
  onExportHeightmap,
  onToggleGameMode,
  onOpenAIChat,
  onOpenLibrary,
}: EditorToolbarProps) {
  const { isModified, activeTool } = useEditorStore();

  const TOOL_LABEL: Record<ToolType, string> = {
    select: "Select",
    heightmap: "Terrain",
    biome: "Biome",
    props: "Props",
    environment: "Env",
  };

  const buttonBase = "px-3 py-1.5 text-[12px] rounded-md transition-all";
  const buttonDefault = `${buttonBase} text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60`;
  const buttonDisabled = "opacity-40 pointer-events-none";

  return (
    <header className="h-11 bg-zinc-950 border-b border-zinc-800/60 flex items-center px-3 gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-zinc-200">World Editor</span>
        <span className="text-[11px] text-zinc-600">/</span>
        <span className="text-[11px] text-zinc-500">{TOOL_LABEL[activeTool]}</span>
      </div>

      <div className="w-px h-5 bg-zinc-800/70 mx-1" />

      <div className="flex items-center gap-1">
        <button
          onClick={onNewProject}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          New
        </button>
        <button
          onClick={onSave}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""} flex items-center gap-1.5`}
        >
          Save
          {isModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-300" />}
        </button>
      </div>

      <div className="w-px h-5 bg-zinc-800/70 mx-1" />

      <div className="flex items-center gap-1">
        <button
          onClick={onExportGLB}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Export GLB
        </button>
        <button
          onClick={onExportHeightmap}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Export PNG
        </button>
      </div>

      <div className="flex-1" />

      {!isGameMode && (
        <div className="hidden lg:flex items-center gap-1 mr-2">
          <button
            onClick={onOpenAIChat}
            className={buttonDefault}
          >
            Generate
          </button>
          <button
            onClick={onOpenLibrary}
            className={buttonDefault}
          >
            Library
          </button>
        </div>
      )}

      {isGameMode ? (
        <span className="text-[11px] text-zinc-500 mr-2">
          WASD / Mouse Look / Space Jump
        </span>
      ) : (
        <span className="hidden md:block text-[10px] text-zinc-600 mr-2">
          1-5 Tool | [ ] Brush | Shift+R Seed
        </span>
      )}

      <button
        onClick={() => engine?.focusOnTerrain()}
        disabled={isGameMode}
        className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        title="Focus terrain (H)"
      >
        Focus
      </button>

      <button
        onClick={onToggleGameMode}
        className={`px-4 py-1.5 text-[12px] rounded-md transition-all ${
          isGameMode
            ? "bg-zinc-100 text-zinc-900 hover:bg-white"
            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
        }`}
      >
        {isGameMode ? "Exit" : "Play"}
      </button>
    </header>
  );
}
