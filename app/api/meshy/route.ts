import { NextRequest, NextResponse } from "next/server";

const MESHY_API_BASE = "https://api.meshy.ai/openapi/v2";

// Create a new Text-to-3D task (preview or refine)
export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.MESHY_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "MESHY_API_KEY not configured" },
        { status: 500 }
      );
    }

    const body = await request.json();
    const { mode = "preview", prompt, artStyle = "realistic", previewTaskId } = body;

    // Validate based on mode
    if (mode === "preview") {
      if (!prompt || typeof prompt !== "string") {
        return NextResponse.json({ error: "Prompt required for preview" }, { status: 400 });
      }

      // Create preview task (mesh only, no texture)
      const response = await fetch(`${MESHY_API_BASE}/text-to-3d`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "preview",
          prompt: prompt.slice(0, 600),
          art_style: artStyle,
          topology: "triangle",
          target_polycount: 10000,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Meshy API error:", error);
        return NextResponse.json(
          { error: `Meshy API error: ${response.status}` },
          { status: response.status }
        );
      }

      const data = await response.json();

      return NextResponse.json({
        success: true,
        taskId: data.result,
        mode: "preview",
        message: "Preview 생성 시작... (1단계/2단계)",
      });
    } else if (mode === "refine") {
      if (!previewTaskId) {
        return NextResponse.json({ error: "previewTaskId required for refine" }, { status: 400 });
      }

      // Create refine task (adds texture to preview)
      const response = await fetch(`${MESHY_API_BASE}/text-to-3d`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode: "refine",
          preview_task_id: previewTaskId,
          enable_pbr: true, // Include PBR maps (roughness, metallic, normal)
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Meshy API refine error:", error);
        return NextResponse.json(
          { error: `Meshy API error: ${response.status}` },
          { status: response.status }
        );
      }

      const data = await response.json();

      return NextResponse.json({
        success: true,
        taskId: data.result,
        mode: "refine",
        message: "Refine 생성 시작... (2단계/2단계) 텍스처 적용 중",
      });
    } else {
      return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
    }
  } catch (error) {
    console.error("Failed to create Meshy task:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// Check task status
export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.MESHY_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "MESHY_API_KEY not configured" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get("taskId");

    if (!taskId) {
      return NextResponse.json({ error: "taskId required" }, { status: 400 });
    }

    const response = await fetch(`${MESHY_API_BASE}/text-to-3d/${taskId}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Meshy API error:", error);
      return NextResponse.json(
        { error: `Meshy API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Determine task type from response
    const taskType = data.type || (data.preview_task_id ? "refine" : "preview");

    return NextResponse.json({
      taskId: data.id,
      taskType, // "text-to-3d-preview" or "text-to-3d-refine"
      status: data.status,
      progress: data.progress || 0,
      modelUrls: data.model_urls || null,
      thumbnailUrl: data.thumbnail_url || null,
      textureUrls: data.texture_urls || null,
    });
  } catch (error) {
    console.error("Failed to check Meshy task:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
