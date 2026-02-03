import { KhronosTextureContainer2 } from "@babylonjs/core/Misc/khronosTextureContainer2";

/**
 * Initialize KTX2 texture support for Babylon.js
 * 
 * KTX2 (Khronos Texture Format 2.0) provides GPU-compressed textures that:
 * - Reduce VRAM usage by 50-75%
 * - Decrease loading times
 * - Support multiple GPU compression formats (BC, ASTC, ETC)
 * 
 * The decoder files are loaded from a CDN by default.
 * For production, consider self-hosting these files.
 */
export function initializeKTX2Support(): void {
  // Configure KTX2 decoder URL
  // Uses Babylon.js preview CDN for decoder files (compatible with Babylon.js 8.x)
  const cdnBase = "https://preview.babylonjs.com/ktx2Decoder";

  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: `${cdnBase}/ktx2Decoder.js`,
    wasmUASTCToASTC: `${cdnBase}/uastc_astc.wasm`,
    wasmUASTCToBC7: `${cdnBase}/uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM: `${cdnBase}/uastc_rgba32_unorm.wasm`,
    wasmUASTCToRGBA_SRGB: `${cdnBase}/uastc_rgba32_srgb.wasm`,
    wasmUASTCToR8_UNORM: null,
    wasmUASTCToRG8_UNORM: null,
    wasmZSTDDecoder: `${cdnBase}/zstddec.wasm`,
    // ETC1S/Basis Universal transcoder for ETC1S encoded textures
    jsMSCTranscoder: `${cdnBase}/msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${cdnBase}/msc_basis_transcoder.wasm`,
  };

  console.log("[KTX2Setup] KTX2 texture support initialized");
}

/**
 * Self-hosted configuration for production
 * Copy decoder files to public/ktx2/ and use this config
 */
export function initializeKTX2SupportSelfHosted(basePath: string = "/ktx2"): void {
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: `${basePath}/ktx2Decoder.js`,
    wasmUASTCToASTC: `${basePath}/uastc_astc.wasm`,
    wasmUASTCToBC7: `${basePath}/uastc_bc7.wasm`,
    wasmUASTCToRGBA_UNORM: `${basePath}/uastc_rgba32_unorm.wasm`,
    wasmUASTCToRGBA_SRGB: `${basePath}/uastc_rgba32_srgb.wasm`,
    wasmUASTCToR8_UNORM: null,
    wasmUASTCToRG8_UNORM: null,
    wasmZSTDDecoder: `${basePath}/zstddec.wasm`,
    // ETC1S/Basis Universal transcoder for ETC1S encoded textures
    jsMSCTranscoder: `${basePath}/msc_basis_transcoder.js`,
    wasmMSCTranscoder: `${basePath}/msc_basis_transcoder.wasm`,
  };

  console.log("[KTX2Setup] KTX2 texture support initialized (self-hosted)");
}
