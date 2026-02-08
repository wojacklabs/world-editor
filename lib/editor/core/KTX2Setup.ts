import { setKTX2Enabled } from "../../shared/rendering/KTX2State";

/**
 * Initialize KTX2 texture support.
 *
 * For Three.js, KTX2Loader requires a WebGLRenderer instance, so actual
 * loader initialization is deferred to the renderer setup. This function
 * only checks if the Basis Universal transcoder WASM files are reachable
 * and sets the global KTX2 enabled flag accordingly.
 *
 * Default behavior is self-hosted decoder lookup at /ktx2.
 * You can override with NEXT_PUBLIC_KTX2_DECODER_BASE_URL.
 */
export async function initializeKTX2Support(): Promise<boolean> {
  const configuredBase = process.env.NEXT_PUBLIC_KTX2_DECODER_BASE_URL?.trim();
  const candidates = configuredBase ? [configuredBase] : ["/ktx2"];

  for (const basePath of candidates) {
    if (await canReachDecoder(basePath)) {
      setKTX2Enabled(true);
      console.log(`[KTX2Setup] KTX2 texture support available (${basePath})`);
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
 * Copy Basis Universal transcoder files to public/ktx2/ and use this config.
 */
export function initializeKTX2SupportSelfHosted(
  basePath: string = "/ktx2"
): void {
  void basePath;
  setKTX2Enabled(true);
  console.log("[KTX2Setup] KTX2 texture support initialized (self-hosted)");
}

function normalizeBasePath(basePath: string): string {
  return basePath.replace(/\/+$/, "");
}

async function canReachDecoder(basePath: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  const base = normalizeBasePath(basePath);
  // Check for Basis Universal transcoder (used by Three.js KTX2Loader)
  const decoderUrl = `${base}/msc_basis_transcoder.js`;

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
