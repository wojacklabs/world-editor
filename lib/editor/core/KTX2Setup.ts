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
  // Uses Babylon.js CDN for decoder files (WASM-based)
  KhronosTextureContainer2.URLConfig = {
    jsDecoderModule: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/ktx2Decoder.js",
    wasmUASTCToASTC: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/uastc_astc.wasm",
    wasmUASTCToBC7: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/uastc_bc7.wasm",
    wasmUASTCToRGBA_UNORM: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/uastc_rgba32_unorm.wasm",
    wasmUASTCToRGBA_SRGB: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/uastc_rgba32_srgb.wasm",
    wasmUASTCToR8_UNORM: null,
    wasmUASTCToRG8_UNORM: null,
    wasmZSTDDecoder: "https://cdn.babylonjs.com/ktx2Decoder/0.1.0/zstddec.wasm",
    jsMSCTranscoder: null,
    wasmMSCTranscoder: null,
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
    jsMSCTranscoder: null,
    wasmMSCTranscoder: null,
  };

  console.log("[KTX2Setup] KTX2 texture support initialized (self-hosted)");
}
