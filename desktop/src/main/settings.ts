import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { Settings } from "../shared/types";

const file = (): string => join(app.getPath("userData"), "settings.json");

const DEFAULTS: Settings = {
  model: "default",
  effort: "default",
  access: "auto",
  whileBusy: "steer",
  exportOptions: { quality: "1080p", format: "mp4", fps: 30, on: "mac" },
};

let cached: Settings | null = null;

export function currentSettings(): Settings {
  if (cached) return cached;
  try {
    cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(file(), "utf8")) as Partial<Settings>) };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cached = { ...currentSettings(), ...patch };
  writeFileSync(file(), JSON.stringify(cached, null, 2));
  return cached;
}
