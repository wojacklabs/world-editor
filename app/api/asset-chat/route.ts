import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".claude-assets");
const REQUESTS_FILE = path.join(DATA_DIR, "requests.json");
const RESPONSES_FILE = path.join(DATA_DIR, "responses.json");

interface ChatRequest {
  id: string;
  message: string;
  timestamp: string;
  processed: boolean;
}

interface MeshData {
  name: string;
  vertices: number[];      // [x,y,z, x,y,z, ...]
  indices: number[];       // triangle indices
  normals: number[];       // [nx,ny,nz, ...]
  uvs?: number[];          // [u,v, u,v, ...]
  colors?: number[];       // [r,g,b,a, r,g,b,a, ...] vertex colors
}

interface ChatResponse {
  id: string;
  requestId: string;
  message: string;
  meshData?: MeshData;     // 프로시저럴 메시 데이터
  timestamp: string;
}

async function ensureDataDir() {
  if (!existsSync(DATA_DIR)) {
    await mkdir(DATA_DIR, { recursive: true });
  }
}

async function readRequests(): Promise<ChatRequest[]> {
  try {
    const data = await readFile(REQUESTS_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function writeRequests(requests: ChatRequest[]) {
  await ensureDataDir();
  await writeFile(REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

async function readResponses(): Promise<ChatResponse[]> {
  try {
    const data = await readFile(RESPONSES_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return [];
  }
}

// POST: Add new chat request
export async function POST(request: NextRequest) {
  try {
    const { message } = await request.json();

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const requests = await readRequests();

    const newRequest: ChatRequest = {
      id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      message: message.trim(),
      timestamp: new Date().toISOString(),
      processed: false,
    };

    requests.push(newRequest);
    await writeRequests(requests);

    return NextResponse.json({
      success: true,
      requestId: newRequest.id,
      message: "요청이 저장되었습니다. Claude Code에게 '에셋 요청 처리해줘'라고 말해주세요."
    });
  } catch (error) {
    console.error("Failed to save request:", error);
    return NextResponse.json({ error: "Failed to save request" }, { status: 500 });
  }
}

// GET: Check for responses
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const requestId = searchParams.get("requestId");
    const afterTimestamp = searchParams.get("after");

    const responses = await readResponses();

    if (requestId) {
      // Find specific response
      const response = responses.find(r => r.requestId === requestId);
      return NextResponse.json({ response: response || null });
    }

    if (afterTimestamp) {
      // Get responses after timestamp
      const filtered = responses.filter(r => r.timestamp > afterTimestamp);
      return NextResponse.json({ responses: filtered });
    }

    // Return latest response
    const latest = responses.length > 0 ? responses[responses.length - 1] : null;
    return NextResponse.json({ response: latest });
  } catch (error) {
    console.error("Failed to read responses:", error);
    return NextResponse.json({ error: "Failed to read responses" }, { status: 500 });
  }
}
