// Reads what the chat menus and panels show about a project, and runs small CLI commands for them.
import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { join, relative } from "node:path";
import { repoDir } from "./brand";
import { DIRECTOR_PREFIX } from "./chat";
import { toolEnv } from "./env";
import { findFolder, librarySnapshot } from "./library";
import { runningServer } from "./preview";
import type { CaptionStyle, MenuData, ScriptData, ScriptWord } from "../shared/types";

export async function runCli(
  args: string[],
  timeoutMs = 60_000,
  input?: string,
): Promise<{ ok: boolean; output: string }> {
  const env = await toolEnv();
  return new Promise((resolve) => {
    const child = spawn("hyperframes", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, output: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output });
    });
    child.stdin.end(input);
  });
}

/**
 * Puts a project back to how it was before a run. While the editor is open it owns the project's
 * history, so the request goes through it; otherwise the CLI can do it directly.
 */
export async function undoRun(dir: string, at: string): Promise<{ ok: boolean; message: string }> {
  const server = runningServer(dir);
  if (!server) {
    const result = await runCli(["history", "restore", at, "--dir", dir]);
    return { ok: result.ok, message: result.output.slice(-200) };
  }
  const base = `http://localhost:${server.port}/api/projects/${encodeURIComponent(server.projectId)}/history`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  // Records anything just written before looking back through the history.
  await post("/checkpoint", {});
  const listed = (await (await fetch(base)).json()) as {
    entries?: { id: string; endedAt?: number; startedAt: number }[];
  };
  const started = Date.parse(at);
  const before = (listed.entries ?? [])
    .filter((entry) => (entry.endedAt ?? entry.startedAt) < started)
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const response = await post("/restore", { point: before?.id ?? "start" });
  return { ok: response.ok, message: response.ok ? "" : (await response.text()).slice(0, 200) };
}

let captionCache: CaptionStyle[] | null = null;

/** The caption styles this repo ships, with the preview videos the registry publishes. */
export async function captionStyles(): Promise<CaptionStyle[]> {
  if (captionCache) return captionCache;
  const root = join(repoDir, "registry", "components");
  const names = (await fs.readdir(root).catch(() => [] as string[])).filter((name) =>
    name.startsWith("caption-"),
  );
  const styles = await Promise.all(
    names.map(async (name): Promise<CaptionStyle | null> => {
      try {
        const item = JSON.parse(
          await fs.readFile(join(root, name, "registry-item.json"), "utf8"),
        ) as {
          title?: string;
          description?: string;
          preview?: { video?: string };
        };
        return {
          name,
          title: item.title ?? name,
          description: item.description ?? "",
          preview: item.preview?.video ?? null,
        };
      } catch {
        return null;
      }
    }),
  );
  captionCache = styles.filter((style): style is CaptionStyle => style !== null);
  return captionCache;
}

async function projectFiles(dir: string): Promise<{ label: string; path: string }[]> {
  const found: { label: string; path: string }[] = [];
  const walk = async (folder: string, depth: number) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      if (entry.name.startsWith(".")) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        if (depth < 2) await walk(path, depth + 1);
      } else {
        const label = relative(dir, path);
        found.push({ label, path: label });
      }
    }
  };
  await walk(join(dir, "assets"), 0);
  await walk(join(dir, "compositions"), 1);
  return found;
}

async function skillNames(): Promise<string[]> {
  const entries = await fs
    .readdir(join(repoDir, "skills"), { withFileTypes: true })
    .catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

export async function menuData(key: string): Promise<MenuData> {
  const library = await librarySnapshot();
  const scoped = key.startsWith(DIRECTOR_PREFIX)
    ? (findFolder(key.slice(DIRECTOR_PREFIX.length))?.paths ?? [])
    : [];
  const files = existsSync(join(key, "index.html")) ? await projectFiles(key) : [];
  return {
    files,
    projects: library.projects
      .filter(
        (project) => project.dir !== key && !project.archived && !scoped.includes(project.dir),
      )
      .map((project) => ({ label: project.name, path: project.dir })),
    captions: await captionStyles(),
    skills: await skillNames(),
  };
}

interface WhisperToken {
  text?: string;
  offsets?: { from?: number; to?: number };
}

/** Whisper's output splits words into tokens: a token that starts with a space starts a word. */
function wordsFromWhisper(segments: { tokens?: WhisperToken[] }[]): ScriptWord[] {
  const words: ScriptWord[] = [];
  for (const segment of segments) {
    for (const token of segment.tokens ?? []) {
      const text = token.text ?? "";
      if (!text || text.startsWith("[_")) continue;
      const start = (token.offsets?.from ?? 0) / 1000;
      const end = (token.offsets?.to ?? 0) / 1000;
      const last = words[words.length - 1];
      if (!text.startsWith(" ") && last) {
        last.text += text;
        last.end = end;
      } else {
        words.push({ text: text.trim(), start, end });
      }
    }
  }
  return words.filter((word) => word.text);
}

function parseTranscript(raw: unknown): ScriptWord[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item: { text?: string; word?: string; start?: number; end?: number }) => {
      const text = item.text ?? item.word;
      return typeof text === "string" && typeof item.start === "number"
        ? [{ text: text.trim(), start: item.start, end: item.end ?? item.start }]
        : [];
    });
  }
  const record = raw as { transcription?: { tokens?: WhisperToken[] }[]; words?: unknown };
  if (record?.transcription) return wordsFromWhisper(record.transcription);
  return record?.words ? parseTranscript(record.words) : [];
}

const cutFile = (dir: string): string => join(dir, ".hyperframes", "script-cuts.json");

export async function readScript(dir: string): Promise<ScriptData> {
  const assets = await fs.readdir(join(dir, "assets")).catch(() => [] as string[]);
  const candidates = [
    join(dir, "transcript.json"),
    ...assets
      .filter((name) => name.endsWith("transcript.json"))
      .map((name) => join(dir, "assets", name)),
  ];
  let words: ScriptWord[] = [];
  for (const path of candidates) {
    try {
      words = parseTranscript(JSON.parse(await fs.readFile(path, "utf8")));
      if (words.length > 0) break;
    } catch {
      /* try the next one */
    }
  }
  let cut: number[] = [];
  try {
    cut = JSON.parse(await fs.readFile(cutFile(dir), "utf8")) as number[];
  } catch {
    /* nothing cut yet */
  }
  return { words, cut };
}

export async function saveScriptCut(dir: string, cut: number[]): Promise<void> {
  await fs.mkdir(join(dir, ".hyperframes"), { recursive: true });
  await fs.writeFile(cutFile(dir), JSON.stringify(cut));
}
