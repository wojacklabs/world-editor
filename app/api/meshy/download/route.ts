import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

// Download GLB from Meshy and save locally
export async function POST(request: NextRequest) {
  try {
    const { glbUrl, name } = await request.json();

    if (!glbUrl || typeof glbUrl !== "string") {
      return NextResponse.json({ error: "glbUrl required" }, { status: 400 });
    }

    // Fetch GLB from Meshy
    const response = await fetch(glbUrl);
    if (!response.ok) {
      return NextResponse.json(
        { error: `Failed to fetch GLB: ${response.status}` },
        { status: 500 }
      );
    }

    const buffer = await response.arrayBuffer();

    // Generate filename
    const timestamp = Date.now();
    const safeName = (name || "model")
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 50);
    const filename = `${safeName}_${timestamp}.glb`;

    // Ensure assets directory exists
    const assetsDir = path.join(process.cwd(), "public", "assets");
    await mkdir(assetsDir, { recursive: true });

    // Save file
    const filePath = path.join(assetsDir, filename);
    await writeFile(filePath, Buffer.from(buffer));

    // Return local URL
    const localUrl = `/assets/${filename}`;

    return NextResponse.json({
      success: true,
      localUrl,
      filename,
    });
  } catch (error) {
    console.error("Failed to download GLB:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
