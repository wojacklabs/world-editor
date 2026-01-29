"use client";

import { useEditorStore } from "@/lib/editor/store/editorStore";
import type { WeatherPreset } from "@/lib/editor/types/EditorTypes";

const WEATHER_PRESETS: { id: WeatherPreset; label: string; icon: string }[] = [
  { id: "clear", label: "Clear", icon: "sun" },
  { id: "cloudy", label: "Cloudy", icon: "cloud" },
  { id: "rainy", label: "Rainy", icon: "rain" },
  { id: "stormy", label: "Stormy", icon: "storm" },
  { id: "snowy", label: "Snowy", icon: "snow" },
];

function WeatherIcon({ type }: { type: string }) {
  switch (type) {
    case "sun":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      );
    case "cloud":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
        </svg>
      );
    case "rain":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 13v8M8 13v8M12 15v8M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
        </svg>
      );
    case "storm":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9" />
          <polyline points="13 11 9 17 15 17 11 23" />
        </svg>
      );
    case "snow":
      return (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 17.58A5 5 0 0 0 18 8h-1.26A8 8 0 1 0 4 16.25" />
          <line x1="8" y1="16" x2="8.01" y2="16" />
          <line x1="8" y1="20" x2="8.01" y2="20" />
          <line x1="12" y1="18" x2="12.01" y2="18" />
          <line x1="12" y1="22" x2="12.01" y2="22" />
          <line x1="16" y1="16" x2="16.01" y2="16" />
          <line x1="16" y1="20" x2="16.01" y2="20" />
        </svg>
      );
    default:
      return null;
  }
}

function formatTime(time: number): string {
  const hours = Math.floor(time);
  const minutes = Math.floor((time % 1) * 60);
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function getTimeLabel(time: number): string {
  if (time >= 5 && time < 7) return "Dawn";
  if (time >= 7 && time < 12) return "Morning";
  if (time >= 12 && time < 14) return "Noon";
  if (time >= 14 && time < 17) return "Afternoon";
  if (time >= 17 && time < 20) return "Dusk";
  if (time >= 20 || time < 5) return "Night";
  return "";
}

export default function WeatherPanel() {
  const {
    weather,
    setTimeOfDay,
    setWeatherPreset,
    setCloudCoverage,
    setWindSpeed,
    setWindDirection,
    setFogDensity,
  } = useEditorStore();

  return (
    <section className="p-3 space-y-4">
      {/* Time of Day */}
      <div>
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-3">
          Time of Day
        </h3>
        <div className="space-y-2">
          <div className="flex justify-between text-[11px]">
            <span className="text-zinc-400">{formatTime(weather.timeOfDay)}</span>
            <span className="text-zinc-500">{getTimeLabel(weather.timeOfDay)}</span>
          </div>
          <input
            type="range"
            min="0"
            max="24"
            step="0.1"
            value={weather.timeOfDay}
            onChange={(e) => setTimeOfDay(parseFloat(e.target.value))}
            className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:bg-zinc-300"
          />
          <div className="flex justify-between text-[9px] text-zinc-600">
            <span>00:00</span>
            <span>06:00</span>
            <span>12:00</span>
            <span>18:00</span>
            <span>24:00</span>
          </div>
        </div>
      </div>

      {/* Weather Presets */}
      <div>
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-2">
          Weather
        </h3>
        <div className="grid grid-cols-5 gap-1">
          {WEATHER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => setWeatherPreset(preset.id)}
              className={`flex flex-col items-center gap-1 py-2 rounded-lg transition-all ${
                weather.weatherPreset === preset.id
                  ? "bg-zinc-800 text-zinc-200"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
              }`}
              title={preset.label}
            >
              <WeatherIcon type={preset.icon} />
              <span className="text-[9px]">{preset.label.slice(0, 5)}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Cloud Coverage */}
      <div>
        <div className="flex justify-between text-[11px] mb-2">
          <span className="text-zinc-500">Cloud Coverage</span>
          <span className="text-zinc-400 tabular-nums">{Math.round(weather.cloudCoverage * 100)}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={weather.cloudCoverage}
          onChange={(e) => setCloudCoverage(parseFloat(e.target.value))}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:bg-zinc-300"
        />
      </div>

      {/* Wind Controls */}
      <div>
        <h3 className="text-[11px] font-medium text-zinc-500 uppercase tracking-wide mb-3">
          Wind
        </h3>
        <div className="space-y-3">
          <div>
            <div className="flex justify-between text-[11px] mb-2">
              <span className="text-zinc-500">Speed</span>
              <span className="text-zinc-400 tabular-nums">{Math.round(weather.windSpeed * 100)}%</span>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={weather.windSpeed}
              onChange={(e) => setWindSpeed(parseFloat(e.target.value))}
              className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:bg-zinc-300"
            />
          </div>
          <div>
            <div className="flex justify-between text-[11px] mb-2">
              <span className="text-zinc-500">Direction</span>
              <span className="text-zinc-400 tabular-nums">{Math.round(weather.windDirection)}&deg;</span>
            </div>
            <input
              type="range"
              min="0"
              max="360"
              step="5"
              value={weather.windDirection}
              onChange={(e) => setWindDirection(parseInt(e.target.value))}
              className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:bg-zinc-300"
            />
          </div>
        </div>
      </div>

      {/* Fog Density */}
      <div>
        <div className="flex justify-between text-[11px] mb-2">
          <span className="text-zinc-500">Fog Density</span>
          <span className="text-zinc-400 tabular-nums">{(weather.fogDensity * 1000).toFixed(1)}</span>
        </div>
        <input
          type="range"
          min="0"
          max="0.05"
          step="0.001"
          value={weather.fogDensity}
          onChange={(e) => setFogDensity(parseFloat(e.target.value))}
          className="w-full h-1 bg-zinc-800 rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-zinc-400 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:bg-zinc-300"
        />
      </div>
    </section>
  );
}
