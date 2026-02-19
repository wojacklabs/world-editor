"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WorldLoader } from "@/lib/loader/WorldLoader";
import { TerrainRenderer } from "@/lib/loader/TerrainRenderer";
import { FoliageRenderer } from "@/lib/loader/FoliageRenderer";
import { SkyWeatherRenderer } from "@/lib/loader/SkyWeatherRenderer";
import { WaterRenderer } from "@/lib/loader/WaterRenderer";
import { ProceduralPropsRenderer } from "@/lib/loader/ProceduralPropsRenderer";
import { PostProcessingPipeline } from "@/lib/loader/PostProcessingPipeline";
import { PointLightsRenderer } from "@/lib/loader/PointLightsRenderer";

export default function ViewerPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ---- Renderer ----
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    SkyWeatherRenderer.enableShadows(renderer);

    // ---- Scene & Camera ----
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x9cbfe5, 0.008);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000);
    camera.position.set(32, 30, 80);

    const controls = new OrbitControls(camera, canvas);
    controls.target.set(32, 0, 32);
    controls.enableDamping = true;
    controls.update();

    // ---- Systems ----
    const terrain = new TerrainRenderer(scene);
    const foliage = new FoliageRenderer(scene, {
      lodDistances: { near: 100, mid: 200, far: 450 },
    });
    const sky = new SkyWeatherRenderer(scene);
    const water = new WaterRenderer(scene);
    const procProps = new ProceduralPropsRenderer(scene);
    const pointLights = new PointLightsRenderer(scene);
    let pipeline: PostProcessingPipeline | null = null;

    // ---- Load world ----
    async function loadWorld(json: string) {
      const result = WorldLoader.loadWorld(json);
      if (!result.success || !result.data) {
        console.error("Load failed:", result.errors);
        return;
      }

      const world = result.data;
      const tile = world.mainTile;
      if (!tile) {
        console.error("No main tile found");
        return;
      }

      console.log(`Loaded: "${world.name}" (${tile.resolution}x${tile.resolution}, size=${tile.size})`);

      // Terrain
      terrain.create({
        heightmap: tile.heightmap,
        resolution: tile.resolution,
        splatmap: tile.splatmap,
        waterMask: tile.waterMask,
        size: tile.size,
        seaLevel: tile.seaLevel,
      });
      if (world.settings.dispStrength != null) {
        terrain.setDispStrength(world.settings.dispStrength);
      }

      // Foliage
      foliage.loadTile(tile.foliage);

      // Weather
      if (world.weather) {
        sky.setWeather(world.weather);
      }

      // Water
      water.create({
        size: tile.size,
        seaLevel: tile.seaLevel,
        sunDirection: sky.getSunDirection(),
        waterType: world.settings.waterType,
        waterFlowAngle: world.settings.waterFlowAngle,
      });

      // Procedural props
      if (world.proceduralProps.length > 0) {
        await procProps.loadPropsAsync(world.proceduralProps);
      }

      // Point lights
      if (world.pointLights.length > 0) {
        pointLights.loadLights(world.pointLights);
      }

      // Post-processing
      pipeline = new PostProcessingPipeline(
        renderer, scene, camera,
        window.innerWidth, window.innerHeight
      );
      pipeline.syncWeather(
        sky.fogColor,
        sky.fogDensity,
        sky.getSunDirection(),
        new THREE.Color(1.0, 0.95, 0.85)
      );

      // Sync terrain lighting
      terrain.setSunDirection(sky.getSunDirection());
      terrain.setFog(sky.fogColor, sky.fogDensity);

      // Center camera
      camera.position.set(tile.size / 2, tile.size * 0.5, tile.size * 1.2);
      controls.target.set(tile.size / 2, 0, tile.size / 2);
      controls.update();

      console.log("World loaded successfully");
    }

    // ---- Auto-load from /example.json ----
    fetch("/example.json")
      .then((r) => r.ok ? r.text() : Promise.reject("No /example.json"))
      .then(loadWorld)
      .catch((e) => console.log("Auto-load skipped:", e));

    // ---- File drop/input handler ----
    function handleFile(file: File) {
      file.text().then(loadWorld);
    }

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files[0];
      if (file) handleFile(file);
    };
    const onDragOver = (e: DragEvent) => e.preventDefault();
    canvas.addEventListener("drop", onDrop);
    canvas.addEventListener("dragover", onDragOver);

    // Expose for file input
    (window as unknown as Record<string, unknown>).__viewerHandleFile = handleFile;

    // ---- Render loop ----
    const clock = new THREE.Clock();
    let animId = 0;

    function animate() {
      animId = requestAnimationFrame(animate);
      const time = clock.getElapsedTime();
      const delta = clock.getDelta();

      controls.update();

      sky.update(time, delta || 0.016, camera.position);
      water.update(time, camera.position);
      terrain.updateLOD(camera.position);
      terrain.updateCameraPosition(camera.position);
      foliage.updateTime(time);
      foliage.updateCamera(camera.position);
      foliage.updateVisibility(camera);

      if (pipeline) {
        pipeline.updateCamera(camera);
        pipeline.render();
      } else {
        renderer.render(scene, camera);
      }
    }
    animate();

    // ---- Resize ----
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      pipeline?.resize(w, h);
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("resize", onResize);
      canvas.removeEventListener("drop", onDrop);
      canvas.removeEventListener("dragover", onDragOver);
      terrain.dispose();
      foliage.dispose();
      sky.dispose();
      water.dispose();
      procProps.dispose();
      pointLights.dispose();
      pipeline?.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div className="relative w-screen h-screen bg-black">
      <canvas ref={canvasRef} className="w-full h-full" />
      <div className="absolute top-4 left-4 flex gap-2 items-center">
        <div className="bg-black/70 text-white px-3 py-1.5 rounded text-sm">
          World Viewer (Loader)
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              const handler = (window as unknown as Record<string, (f: File) => void>).__viewerHandleFile;
              if (handler) handler(file);
            }
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="bg-zinc-800/80 hover:bg-zinc-700 text-white px-3 py-1.5 rounded text-sm transition"
        >
          Load JSON
        </button>
        <span className="text-zinc-500 text-xs">or drag & drop</span>
      </div>
    </div>
  );
}
