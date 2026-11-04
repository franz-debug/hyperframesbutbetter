import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { basename, extname, join } from "node:path";
import { projectsRoot } from "./brand";
import { toolEnv } from "./env";
import type { Orientation } from "../shared/types";

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mxf)$/i;

/** Macs leave hidden "._" companion files on cards and drives. They aren't videos. */
export const isVideoFile = (name: string): boolean => VIDEO.test(name) && !name.startsWith(".");

export function projectNameFromPrompt(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  const name = words.join(" ").slice(0, 48).trim();
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : "Untitled video";
}

export const projectNameFromFile = (path: string): string =>
  basename(path, extname(path))
    .replace(/[/\\:]/g, " ")
    .trim() || "Untitled video";

export function uniqueProjectName(name: string): string {
  const root = projectsRoot();
  if (!existsSync(join(root, name))) return name;
  for (let n = 2; ; n++) {
    const candidate = `${name} ${n}`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
}

/** An empty project, for a video made from scratch. Skills come from the chat, not an install. */
export async function createBlankProject(
  prompt: string,
  orientation: Orientation,
  files: string[],
): Promise<string> {
  const root = projectsRoot();
  await fs.mkdir(root, { recursive: true });
  const name = uniqueProjectName(projectNameFromPrompt(prompt));
  const args = [
    "init",
    name,
    "--example",
    "blank",
    "--non-interactive",
    "--skip-transcribe",
    "--skip-skills",
    `--resolution=${orientation}`,
  ];
  const env = await toolEnv();
  await new Promise<void>((done, fail) => {
    execFile("hyperframes", args, { cwd: root, env, timeout: 120_000 }, (error, _out, stderr) => {
      if (error) fail(new Error(stderr.trim() || error.message));
      else done();
    });
  });
  const dir = join(root, name);
  if (!existsSync(join(dir, "index.html"))) {
    throw new Error(`The project was not created at ${dir}.`);
  }
  await copyIntoAssets(dir, files);
  return dir;
}

export async function copyIntoAssets(dir: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const assets = join(dir, "assets");
  await fs.mkdir(assets, { recursive: true });
  for (const file of files) await fs.copyFile(file, join(assets, basename(file)));
}
