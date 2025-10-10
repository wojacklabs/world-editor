"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import {
  getAssetLibrary,
  SavedAsset,
  ChatMessage,
} from "@/lib/editor/assets/AssetLibrary";

interface AssetChatPanelProps {
  onGlbGenerated?: (localGlbUrl: string, name: string) => void;
  onAssetSaved?: (asset: SavedAsset) => void;
  isOpen: boolean;
  onClose: () => void;
}

async function downloadAndSaveGlb(
  glbUrl: string,
  name: string
): Promise<string> {
  const res = await fetch("/api/meshy/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ glbUrl, name }),
  });

  const data = await res.json();
  if (!data.success) {
    throw new Error(data.error || "Failed to download GLB");
  }

  return data.localUrl;
}

type TaskStage = "preview" | "refine";

interface MeshyTask {
  taskId: string;
  prompt: string;
  stage: TaskStage;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED";
  progress: number;
  previewTaskId?: string;
}

export default function AssetChatPanel({
  onGlbGenerated,
  onAssetSaved,
  isOpen,
  onClose,
}: AssetChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      content:
        "Describe the 3D asset you want to create.\n\n" +
        "Examples: 'a wooden bench', 'medieval sword', 'small cactus'\n\n" +
        "Process: Preview (~30s) → Refine (~1min)",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentTask, setCurrentTask] = useState<MeshyTask | null>(null);
  const [currentGlbUrl, setCurrentGlbUrl] = useState<string | null>(null);
  const [assetName, setAssetName] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const library = getAssetLibrary();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const startRefineTask = useCallback(async (previewTaskId: string, prompt: string) => {
    try {
      const res = await fetch("/api/meshy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "refine",
          previewTaskId,
        }),
      });

      const data = await res.json();

      if (data.success && data.taskId) {
        setMessages((prev) => {
          const filtered = prev.filter((m) => !m.id.startsWith("progress-"));
          return [
            ...filtered,
            {
              id: `progress-${data.taskId}`,
              role: "assistant",
              content: "Refine: Applying textures... 0%",
              timestamp: new Date().toISOString(),
            },
          ];
        });

        setCurrentTask({
          taskId: data.taskId,
          prompt,
          stage: "refine",
          status: "PENDING",
          progress: 0,
          previewTaskId,
        });

        return data.taskId;
      } else {
        throw new Error(data.error || "Failed to start refine task");
      }
    } catch (error) {
      console.error("Failed to start refine task:", error);
      throw error;
    }
  }, []);

  const pollTaskStatus = useCallback(async (taskId: string, prompt: string, stage: TaskStage, previewTaskId?: string) => {
    try {
      const res = await fetch(`/api/meshy?taskId=${taskId}`);
      const data = await res.json();

      if (data.error) {
        throw new Error(data.error);
      }

      setCurrentTask({
        taskId,
        prompt,
        stage,
        status: data.status,
        progress: data.progress,
        previewTaskId,
      });

      const stageLabel = stage === "preview" ? "Preview: Generating mesh" : "Refine: Applying textures";
      setMessages((prev) => {
        const progressMsgIndex = prev.findIndex((m) => m.id === `progress-${taskId}`);
        const progressMsg: ChatMessage = {
          id: `progress-${taskId}`,
          role: "assistant",
          content: `${stageLabel}... ${data.progress}%`,
          timestamp: new Date().toISOString(),
        };

        if (progressMsgIndex >= 0) {
          const updated = [...prev];
          updated[progressMsgIndex] = progressMsg;
          return updated;
        }
        return prev;
      });

      if (data.status === "SUCCEEDED") {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        if (stage === "preview") {
          try {
            const refineTaskId = await startRefineTask(taskId, prompt);

            pollIntervalRef.current = setInterval(() => {
              pollTaskStatus(refineTaskId, prompt, "refine", taskId);
            }, 3000);

            pollTaskStatus(refineTaskId, prompt, "refine", taskId);
          } catch (error) {
            console.error("Failed to start refine:", error);
            setMessages((prev) => {
              const filtered = prev.filter((m) => !m.id.startsWith("progress-"));
              return [
                ...filtered,
                {
                  id: `error-${taskId}`,
                  role: "assistant",
                  content: "Failed to start refine stage.",
                  timestamp: new Date().toISOString(),
                },
              ];
            });
            setCurrentTask(null);
            setIsProcessing(false);
          }
        } else {
          const glbUrl = data.modelUrls?.glb;
          if (glbUrl) {
            try {
              setMessages((prev) => {
                const filtered = prev.filter((m) => !m.id.startsWith("progress-"));
                return [
                  ...filtered,
                  {
                    id: `downloading-${taskId}`,
                    role: "assistant",
                    content: "Downloading model...",
                    timestamp: new Date().toISOString(),
                  },
                ];
              });

              const localUrl = await downloadAndSaveGlb(glbUrl, prompt);
              setCurrentGlbUrl(localUrl);
              onGlbGenerated?.(localUrl, prompt);

              setMessages((prev) => {
                const filtered = prev.filter(
                  (m) => !m.id.startsWith("progress-") && !m.id.startsWith("downloading-")
                );
                return [
                  ...filtered,
                  {
                    id: `success-${taskId}`,
                    role: "assistant",
                    content: `Model "${prompt}" ready.\n\nSaved to: ${localUrl}`,
                    timestamp: new Date().toISOString(),
                    assetPreview: data.thumbnailUrl,
                  },
                ];
              });
            } catch (downloadError) {
              console.error("Failed to download GLB:", downloadError);
              setCurrentGlbUrl(glbUrl);
              onGlbGenerated?.(glbUrl, prompt);

              setMessages((prev) => {
                const filtered = prev.filter(
                  (m) => !m.id.startsWith("progress-") && !m.id.startsWith("downloading-")
                );
                return [
                  ...filtered,
                  {
                    id: `success-${taskId}`,
                    role: "assistant",
                    content: `Model "${prompt}" ready. (Using remote URL)`,
                    timestamp: new Date().toISOString(),
                    assetPreview: data.thumbnailUrl,
                  },
                ];
              });
            }
          }

          setCurrentTask(null);
          setIsProcessing(false);
        }
      } else if (data.status === "FAILED") {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
          pollIntervalRef.current = null;
        }

        setMessages((prev) => {
          const filtered = prev.filter((m) => !m.id.startsWith("progress-"));
          return [
            ...filtered,
            {
              id: `failed-${taskId}`,
              role: "assistant",
              content: `${stage === "preview" ? "Preview" : "Refine"} failed. Please try again.`,
              timestamp: new Date().toISOString(),
            },
          ];
        });

        setCurrentTask(null);
        setIsProcessing(false);
      }
    } catch (error) {
      console.error("Failed to poll task status:", error);
    }
  }, [onGlbGenerated, startRefineTask]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isProcessing) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
      timestamp: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, userMessage]);
    const messageText = input.trim();
    setInput("");

    const lower = messageText.toLowerCase();
    if ((lower.includes("save") || lower.includes("저장")) && currentGlbUrl) {
      const name = assetName || `Asset ${Date.now()}`;
      const saved = library.saveAsset({
        name,
        description: messageText,
        type: "custom",
        params: {
          type: "custom",
          seed: 0,
          size: 1,
          sizeVariation: 0,
          noiseScale: 0,
          noiseAmplitude: 0,
          colorBase: { r: 0.7, g: 0.7, b: 0.7 },
          colorDetail: { r: 0.5, g: 0.5, b: 0.5 },
        },
        tags: ["meshy", "custom"],
        glbPath: currentGlbUrl,
      });
      onAssetSaved?.(saved);

      const assistantMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: "assistant",
        content: `Saved as "${name}"`,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
      setCurrentGlbUrl(null);
      setAssetName("");
      return;
    }

    setIsProcessing(true);

    const generatingMessage: ChatMessage = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content: "Sending request...",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, generatingMessage]);

    try {
      const res = await fetch("/api/meshy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          prompt: messageText,
        }),
      });

      const data = await res.json();

      setMessages((prev) => prev.filter((m) => m.id !== generatingMessage.id));

      if (data.success && data.taskId) {
        setMessages((prev) => [
          ...prev,
          {
            id: `progress-${data.taskId}`,
            role: "assistant",
            content: "Preview: Generating mesh... 0%",
            timestamp: new Date().toISOString(),
          },
        ]);

        setCurrentTask({
          taskId: data.taskId,
          prompt: messageText,
          stage: "preview",
          status: "PENDING",
          progress: 0,
        });

        pollIntervalRef.current = setInterval(() => {
          pollTaskStatus(data.taskId, messageText, "preview");
        }, 3000);

        pollTaskStatus(data.taskId, messageText, "preview");
      } else {
        throw new Error(data.error || "Failed to create task");
      }
    } catch (error) {
      console.error("Failed to create Meshy task:", error);

      setMessages((prev) => prev.filter((m) => m.id !== generatingMessage.id));

      const errorMessage: ChatMessage = {
        id: (Date.now() + 2).toString(),
        role: "assistant",
        content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, errorMessage]);
      setIsProcessing(false);
    }
  };

  if (!isOpen) return null;

  const getStageDisplay = () => {
    if (!currentTask) return null;
    const { stage, progress } = currentTask;
    return stage === "preview" ? `Preview ${progress}%` : `Refine ${progress}%`;
  };

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-zinc-950 border-l border-zinc-800/50 flex flex-col z-50">
      {/* Header */}
      <header className="px-4 py-3 border-b border-zinc-800/50 flex justify-between items-center">
        <div>
          <h2 className="text-sm font-medium text-zinc-200">Generate Asset</h2>
          {currentTask && (
            <span className="text-[10px] text-zinc-500">
              {getStageDisplay()}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[90%] rounded-lg px-3 py-2 text-xs ${
                msg.role === "user"
                  ? "bg-zinc-800 text-zinc-200"
                  : "bg-zinc-900 text-zinc-400"
              }`}
            >
              <p className="whitespace-pre-wrap">{msg.content}</p>
              {msg.assetPreview && (
                <img
                  src={msg.assetPreview}
                  alt="Preview"
                  className="mt-2 rounded max-w-full"
                />
              )}
            </div>
          </div>
        ))}

        <div ref={messagesEndRef} />
      </div>

      {/* Current GLB Actions */}
      {currentGlbUrl && (
        <div className="px-4 py-3 border-t border-zinc-800/50">
          <div className="text-[10px] text-zinc-600 mb-2">Generated model ready</div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              placeholder="Asset name..."
              className="flex-1 px-2 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded text-zinc-300 placeholder-zinc-600 focus:border-zinc-700 focus:outline-none"
            />
            <button
              onClick={() => {
                if (currentGlbUrl) {
                  const name = assetName || `Asset ${Date.now()}`;
                  const saved = library.saveAsset({
                    name,
                    description: "",
                    type: "custom",
                    params: {
                      type: "custom",
                      seed: 0,
                      size: 1,
                      sizeVariation: 0,
                      noiseScale: 0,
                      noiseAmplitude: 0,
                      colorBase: { r: 0.7, g: 0.7, b: 0.7 },
                      colorDetail: { r: 0.5, g: 0.5, b: 0.5 },
                    },
                    tags: ["meshy", "custom"],
                    glbPath: currentGlbUrl,
                  });
                  onAssetSaved?.(saved);
                  setCurrentGlbUrl(null);
                  setAssetName("");
                  setMessages((prev) => [
                    ...prev,
                    {
                      id: Date.now().toString(),
                      role: "assistant",
                      content: `Saved as "${name}"`,
                      timestamp: new Date().toISOString(),
                    },
                  ]);
                }
              }}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => {
                if (currentGlbUrl) {
                  onGlbGenerated?.(currentGlbUrl, assetName || "model");
                }
              }}
              className="px-3 py-1.5 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded transition-colors"
            >
              Place
            </button>
          </div>
        </div>
      )}

      {/* Input */}
      <form onSubmit={handleSubmit} className="px-4 py-3 border-t border-zinc-800/50">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe in English..."
            className="flex-1 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-300 placeholder-zinc-600 focus:border-zinc-700 focus:outline-none"
            disabled={isProcessing}
          />
          <button
            type="submit"
            disabled={isProcessing || !input.trim()}
            className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:bg-zinc-900 disabled:text-zinc-600 disabled:cursor-not-allowed text-zinc-300 rounded transition-colors text-xs"
          >
            Go
          </button>
        </div>
      </form>
    </div>
  );
}
