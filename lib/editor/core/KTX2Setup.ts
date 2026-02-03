import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";
import { setKTX2Enabled } from "../../shared/rendering/KTX2State";

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/\/+$/, "");
}

function applyKTX2UrlConfig(basePath: string): void {
  const base = normalizeBasePath(basePath);
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: `${base}/babylon.ktx2Decoder.js`,
    wasmUASTCToASTC: `${base}/uastc_astc.wasm`,
    wasmUASTCToBC7: `${base}/uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM: `${base}/uastc_rgba8_unorm_v2.wasm`,
    wasmUASTCToRGBA_SRGB: `${base}/uastc_rgba8_srgb_v2.wasm`,
    wasmUASTCToR8_UNORM: `${base}/uastc_r8_unorm.wasm`,
    wasmUASTCToRG8_UNORM: `${base}/uastc_rg8_unorm.wasm`,
    wasmZSTDDecoder: `${base}/zstddec.wasm`,
    jsMSCTranscoder: `${base}/msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${base}/msc_basis_transcoder.wasm`,
  };
}

async function canReachDecoder(basePath: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  const base = normalizeBasePath(basePath);
  const decoderUrl = `${base}/babylon.ktx2Decoder.js`;

  try {
    const head = await fetch(decoderUrl, {
      method: "HEAD",
      cache: "no-store",
    });
    if (head.ok) {
      return true;
    }

    // Some setups block HEAD; fall back to GET probe.
    if (head.status === 405 || head.status === 501) {
      const get = await fetch(decoderUrl, {
        method: "GET",
        cache: "no-store",
      });
      return get.ok;
    }
  } catch {
    // Ignore and report unavailable.
  }

  return false;
}

/**
 * Initialize KTX2 texture support for Babylon.js.
 *
 * Default behavior is self-hosted decoder lookup at /ktx2.
 * You can override with NEXT_PUBLIC_KTX2_DECODER_BASE_URL.
 */
export async function initializeKTX2Support(): Promise<boolean> {
  const configuredBase = process.env.NEXT_PUBLIC_KTX2_DECODER_BASE_URL?.trim();
  const candidates = configuredBase ? [configuredBase] : ["/ktx2"];

  for (const basePath of candidates) {
    if (await canReachDecoder(basePath)) {
      applyKTX2UrlConfig(basePath);
      setKTX2Enabled(true);
      console.log(`[KTX2Setup] KTX2 texture support initialized (${basePath})`);
      return true;
    }
  }

  setKTX2Enabled(false);
  console.warn(
    "[KTX2Setup] KTX2 decoder unavailable. Falling back to jpg/png textures."
  );
  return false;
}

/**
 * Force self-hosted configuration for production.
 * Copy decoder files to public/ktx2/ and use this config.
 */
export function initializeKTX2SupportSelfHosted(
  basePath: string = "/ktx2"
): void {
  applyKTX2UrlConfig(basePath);
  setKTX2Enabled(true);
  console.log("[KTX2Setup] KTX2 texture support initialized (self-hosted)");
}
