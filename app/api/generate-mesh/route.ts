import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a 3D mesh generator. When given a description of an object, you generate procedural mesh data.

Output ONLY valid JSON in this exact format (no markdown, no explanation):
{
  "name": "object_name",
  "vertices": [x,y,z, x,y,z, ...],
  "indices": [0,1,2, ...],
  "normals": [nx,ny,nz, ...],
  "colors": [r,g,b,a, r,g,b,a, ...]
}

Rules:
- vertices: flat array of x,y,z coordinates. Object should be centered at origin, ~1-3 units in size.
- indices: triangle indices (3 per triangle, counter-clockwise winding)
- normals: one normal per vertex (same length as vertices)
- colors: RGBA per vertex (4 values per vertex, 0-1 range)
- Keep vertex count reasonable (50-200 vertices for simple objects)
- Make recognizable shapes using basic geometry (boxes, cylinders, spheres, cones)
- Use appropriate colors for the object

Example for a simple red cube:
{"name":"cube","vertices":[-0.5,-0.5,-0.5,0.5,-0.5,-0.5,0.5,0.5,-0.5,-0.5,0.5,-0.5,-0.5,-0.5,0.5,0.5,-0.5,0.5,0.5,0.5,0.5,-0.5,0.5,0.5],"indices":[0,1,2,0,2,3,4,6,5,4,7,6,0,4,5,0,5,1,2,6,7,2,7,3,0,3,7,0,7,4,1,5,6,1,6,2],"normals":[0,0,-1,0,0,-1,0,0,-1,0,0,-1,0,0,1,0,0,1,0,0,1,0,0,1],"colors":[0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1,0.8,0.2,0.2,1]}`;

export async function POST(request: NextRequest) {
  try {
    const { message } = await request.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Generate mesh data for: ${message}`
        }
      ]
    });

    const content = response.content[0];
    if (content.type !== "text") {
      return NextResponse.json({ error: "Unexpected response type" }, { status: 500 });
    }

    // Parse JSON response
    let meshData;
    try {
      meshData = JSON.parse(content.text);
    } catch {
      // Try to extract JSON from response
      const jsonMatch = content.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        meshData = JSON.parse(jsonMatch[0]);
      } else {
        return NextResponse.json({ error: "Failed to parse mesh data" }, { status: 500 });
      }
    }

    // Validate mesh data
    if (!meshData.vertices || !meshData.indices || !meshData.normals) {
      return NextResponse.json({ error: "Invalid mesh data structure" }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      message: `${message} 메시를 생성했습니다!\n\n- 버텍스: ${meshData.vertices.length / 3}개\n- 삼각형: ${meshData.indices.length / 3}개`,
      meshData
    });
  } catch (error) {
    console.error("Failed to generate mesh:", error);
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Failed to generate mesh"
    }, { status: 500 });
  }
}
