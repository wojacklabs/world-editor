"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { EditorEngine } from "@/lib/editor/core/EditorEngine";
import type { ToolType } from "@/lib/editor/types/EditorTypes";

interface EditorToolbarProps {
  engine: EditorEngine | null;
  isGameMode: boolean;
  leftPanelVisible: boolean;
  rightPanelVisible: boolean;
  onNewProject: () => void;
  onSave: () => void;
  onExportGLB: () => void;
  onExportHeightmap: () => void;
  onToggleGameMode: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  onOpenAIChat?: () => void;
  onOpenLibrary?: () => void;
}

export default function EditorToolbar({
  engine,
  isGameMode,
  leftPanelVisible,
  rightPanelVisible,
  onNewProject,
  onSave,
  onExportGLB,
  onExportHeightmap,
  onToggleGameMode,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenAIChat,
  onOpenLibrary,
}: EditorToolbarProps) {
  const { isModified, activeTool } = useEditorStore();

  const TOOL_LABEL: Record<ToolType, string> = {
    select: "Select",
    heightmap: "Terrain",
    biome: "Biome",
    props: "Props",
    environment: "Environment",
  };

  const buttonBase = "px-3 py-1.5 text-[12px] rounded-md transition-all";
  const buttonDefault = `${buttonBase} text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800`;
  const buttonDisabled = "opacity-40 pointer-events-none";

  return (
    <header className="h-12 bg-zinc-950 border-b border-zinc-800/60 flex items-center px-2 sm:px-3 gap-1.5 sm:gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="hidden md:block text-sm font-medium text-zinc-200">World Editor</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 whitespace-nowrap">
          {TOOL_LABEL[activeTool]}
        </span>
      </div>

      <div className="hidden lg:flex items-center gap-1 border border-zinc-800/70 rounded-lg p-0.5">
        <button
          onClick={onToggleLeftPanel}
          disabled={isGameMode}
          className={`px-2.5 py-1.5 text-[11px] rounded-md transition-all ${
            leftPanelVisible ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
          } ${isGameMode ? buttonDisabled : ""}`}
        >
          Tools
        </button>
        <button
          onClick={onToggleRightPanel}
          disabled={isGameMode}
          className={`px-2.5 py-1.5 text-[11px] rounded-md transition-all ${
            rightPanelVisible ? "bg-zinc-800 text-zinc-200" : "text-zinc-500 hover:text-zinc-300"
          } ${isGameMode ? buttonDisabled : ""}`}
        >
          Inspector
        </button>
      </div>

      <div className="hidden lg:block w-px h-5 bg-zinc-800/70" />

      <div className="flex items-center gap-1">
        <button
          onClick={onNewProject}
          disabled={isGameMode}
          className={`hidden sm:inline-flex ${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
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

      <div className="hidden xl:flex items-center gap-1">
        <button
          onClick={onOpenAIChat}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Generate
        </button>
        <button
          onClick={onOpenLibrary}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          Library
        </button>
      </div>

      <div className="flex-1" />

      <div className="hidden xl:flex items-center gap-1">
        <button
          onClick={onExportGLB}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          GLB
        </button>
        <button
          onClick={onExportHeightmap}
          disabled={isGameMode}
          className={`${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
        >
          PNG
        </button>
      </div>

      <button
        onClick={() => engine?.focusOnTerrain()}
        disabled={isGameMode}
        className={`hidden md:inline-flex ${buttonDefault} ${isGameMode ? buttonDisabled : ""}`}
      >
        Focus
      </button>

      <button
        onClick={onToggleGameMode}
        className={`px-3 sm:px-4 py-1.5 text-[12px] rounded-md transition-all ${
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
