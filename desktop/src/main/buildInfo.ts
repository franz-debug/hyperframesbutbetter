import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  repoDir: string;
  commit: string;
  builtAt: string;
}

export default function buildInfo(): BuildInfo {
  return JSON.parse(readFileSync(join(__dirname, "build-info.json"), "utf8")) as BuildInfo;
}
