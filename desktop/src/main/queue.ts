// Runs the queue's jobs on this machine, and keeps it awake and informed while they run.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, promises as fs, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { totalmem } from "node:os";
import { basename, join } from "node:path";
import { app, BrowserWindow, Notification, powerSaveBlocker } from "electron";
import { brand, projectsRoot } from "./brand";
import { chatRunToEnd } from "./chat";
import { toolEnv } from "./env";
import {
  addProjectDir,
  isKnownProject,
  moveToFolder,
  projectDisplayName,
  setProjectKitId,
} from "./library";
import { projectNameFromFile, uniqueProjectName } from "./projects";
import { JobQueue } from "./queueCore";
import type { ExportOptions, Job, MemoryPressure, QueueSnapshot } from "../shared/types";

const stateFile = (): string => join(app.getPath("userData"), "queue.json");
let memory: QueueSnapshot["memory"] = { pressure: "normal", usedPercent: 0 };
let awake: number | null = null;
let onLibraryChange: () => void = () => {};

function sh(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5_000 }, (_error, stdout) => resolve(stdout ?? ""));
  });
}

async function readMemory(): Promise<QueueSnapshot["memory"]> {
  const [level, vm] = await Promise.all([
    sh("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
    sh("/usr/bin/vm_stat", []),
  ]);
  const code = Number(level.trim());
  const pressure: MemoryPressure = code >= 4 ? "critical" : code === 2 ? "warning" : "normal";
  const pageSize = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pages = (label: string) =>
    Number(new RegExp(`${label}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0) * pageSize;
  const used =
    pages("Pages active") + pages("Pages wired down") + pages("Pages occupied by compressor");
  return { pressure, usedPercent: Math.min(100, Math.round((used / totalmem()) * 100)) };
}

export function queueSnapshot(): QueueSnapshot {
  return {
    jobs: queue.jobs,
    paused: queue.paused,
    pauseReason: queue.pauseReason,
    waitingForMemory: queue.waitingForMemory,
    memory,
  };
}

function broadcast(): void {
  const snapshot = queueSnapshot();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("queue:changed", snapshot);
  }
}

function persist(): void {
  writeFileSync(stateFile(), JSON.stringify({ jobs: queue.jobs, paused: queue.paused }));
}

function reflectInDock(): void {
  const left = queue.jobs.filter((job) => job.status === "waiting" || job.status === "running");
  app.dock?.setBadge(left.length > 0 ? String(left.length) : "");
  if (queue.isRunning && awake === null) {
    awake = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!queue.isRunning && left.length === 0 && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
}

/** Runs a tool to its end, stopping it if the job is cancelled. */
function runTool(
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    onLine: (line: string) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn("hyperframes", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stop = () => child.kill("SIGTERM");
    options.signal.addEventListener("abort", stop, { once: true });
    let tail = "";
    const read = (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-1500);
      for (const line of text.split("\n")) if (line.trim()) options.onLine(line.trim());
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.once("error", (error) =>
      reject(new Error(`Could not run hyperframes: ${error.message}`)),
    );
    child.once("close", (code) => {
      options.signal.removeEventListener("abort", stop);
      if (code === 0 || options.signal.aborted) resolve();
      else reject(new Error(tail.trim() || `hyperframes stopped (code ${code}).`));
    });
  });
}

const stamp = (): string => {
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}.${p(now.getMinutes())}`;
};

/** Cameras often store vertical video as landscape with a rotation flag. */
function shotVertical(path: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height:stream_side_data=rotation",
    "-of",
    "json",
    path,
  ];
  return new Promise((resolve) => {
    execFile("ffprobe", args, { env, timeout: 30_000 }, (_error, stdout) => {
      try {
        const stream = (
          JSON.parse(stdout) as {
            streams?: {
              width?: number;
              height?: number;
              side_data_list?: { rotation?: number }[];
            }[];
          }
        ).streams?.[0];
        const turned = Math.abs(stream?.side_data_list?.[0]?.rotation ?? 0) % 180 === 90;
        const width = stream?.width ?? 0;
        const height = stream?.height ?? 0;
        resolve(turned ? width > height : height > width);
      } catch {
        resolve(false);
      }
    });
  });
}

async function runImport(job: Job, update: (patch: Partial<Job>) => void, signal: AbortSignal) {
  const source = job.sourcePath;
  if (!source || !existsSync(source)) throw new Error(`Can't find the video at ${source}.`);
  const root = projectsRoot();
  mkdirSync(root, { recursive: true });
  const size = (await fs.stat(source)).size;
  const free = await fs.statfs(root);
  if (free.bavail * free.bsize < size * 2) {
    throw new Error(`Not enough free disk space to import ${basename(source)}.`);
  }
  const name = uniqueProjectName(projectNameFromFile(source));
  update({ stage: "Copying the footage and transcribing it", title: name });
  const env = await toolEnv();
  const args = ["init", name, "--video", source, "--non-interactive", "--skip-skills"];
  if (await shotVertical(source, env)) args.push("--resolution=portrait");
  await runTool(args, {
    cwd: root,
    env,
    signal,
    onLine: (line) => {
      // Drops color codes and any leading spinner characters from the CLI's status line.
      const clean = line.replace(/\[[0-9;]*m/g, "").replace(/^[^\p{L}]+/u, "");
      if (clean.length > 3 && clean.length < 90) update({ stage: clean });
    },
  });
  if (signal.aborted) return;
  const dir = join(root, name);
  if (!existsSync(join(dir, "index.html")))
    throw new Error(`The project wasn't created at ${dir}.`);
  addProjectDir(dir);
  if (job.folderId) moveToFolder(dir, job.folderId);
  if (job.brandKitId) setProjectKitId(dir, job.brandKitId);
  update({ dir, stage: "" });
  onLibraryChange();
}

async function runEdit(job: Job, update: (patch: Partial<Job>) => void, signal: AbortSignal) {
  if (!job.dir || !job.instruction) throw new Error("This edit has no project or instructions.");
  update({ stage: "Claude is editing" });
  const of =
    job.batchSize > 1
      ? ` This is one video from a batch of ${job.batchSize}; only work on this one.`
      : "";
  const text = `${job.instruction}\n\n(${of.trim()} If this project is still named after the raw file, set "name" in meta.json to "<raw file name> - <short topic>". Don't rename the folder. Don't render. Run \`hyperframes check\` when you're done.)`;
  await chatRunToEnd(job.dir, text, job.instruction, signal);
  onLibraryChange();
}

/** The composition's own size, for choosing a same-shape export resolution. */
function compositionShape(dir: string): "portrait" | "landscape" | "square" {
  try {
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const width = Number(/data-width="(\d+)"/.exec(html)?.[1] ?? 1920);
    const height = Number(/data-height="(\d+)"/.exec(html)?.[1] ?? 1080);
    return height > width ? "portrait" : width > height ? "landscape" : "square";
  } catch {
    return "landscape";
  }
}

function localRenderArgs(dir: string, output: string, options: ExportOptions | null): string[] {
  const args = ["render", dir, "--output", output];
  if (!options) return args;
  const shape = compositionShape(dir);
  if (options.quality === "1080p") args.push(`--resolution=${shape}`);
  if (options.quality === "4k") args.push(`--resolution=${shape}-4k`);
  args.push(`--format=${options.format}`, `--fps=${options.fps}`);
  return args;
}

function cloudRenderArgs(dir: string, output: string, options: ExportOptions): string[] {
  const shape = compositionShape(dir);
  const aspect = shape === "portrait" ? "9:16" : shape === "square" ? "1:1" : "16:9";
  return [
    "cloud",
    "render",
    dir,
    "--output",
    output,
    `--resolution=${options.quality === "4k" ? "4k" : "1080p"}`,
    `--aspect-ratio=${aspect}`,
    `--format=${options.format}`,
    `--fps=${options.fps}`,
  ];
}

async function runRender(job: Job, update: (patch: Partial<Job>) => void, signal: AbortSignal) {
  const dir = job.dir;
  if (!dir || !existsSync(join(dir, "index.html"))) throw new Error("Can't find this project.");
  const folder = job.exportDir ?? join(dir, "renders");
  try {
    mkdirSync(folder, { recursive: true });
  } catch {
    throw new Error(`Can't save to ${folder}. If it's on an external drive, plug it in and retry.`);
  }
  const name = projectDisplayName(dir);
  const extension = job.options?.format ?? "mp4";
  const output = job.outputPath ?? join(folder, `${name} ${stamp()}.${extension}`);
  update({ title: name, outputPath: output, stage: "Starting" });
  const onCloud = job.options?.on === "cloud";
  const args =
    onCloud && job.options
      ? cloudRenderArgs(dir, output, job.options)
      : localRenderArgs(dir, output, job.options);
  await runTool(args, {
    cwd: dir,
    // The queue already runs one at a time, so this render gets the whole machine's workers.
    env: await toolEnv({ HYPERFRAMES_MAX_PARALLEL_RENDERS: "1" }),
    signal,
    onLine: (line) => {
      if (!line.startsWith("@hf-progress ")) {
        if (onCloud && line.length < 90) update({ stage: line });
        return;
      }
      try {
        const progress = JSON.parse(line.slice(13)) as {
          pct?: unknown;
          code?: unknown;
          done?: unknown;
          total?: unknown;
        };
        const counted =
          typeof progress.done === "number" && typeof progress.total === "number"
            ? ` ${progress.done} of ${progress.total}`
            : "";
        update({
          progress: typeof progress.pct === "number" ? progress.pct : job.progress,
          stage: `${stageName(progress.code)}${counted}`,
        });
      } catch {
        /* not a whole progress line */
      }
    },
  });
  onLibraryChange();
}

const STAGES: Record<string, string> = {
  compile: "Preparing",
  extract_video: "Reading the footage",
  process_audio: "Mixing the sound",
  start_browsers: "Preparing",
  capture: "Drawing frames",
  encode: "Encoding the video",
  assemble: "Assembling",
};

const stageName = (code: unknown): string =>
  (typeof code === "string" ? STAGES[code] : undefined) ?? "Exporting";

const LIMIT_PATTERN =
  /usage limit|rate limit|hit your limit|credit balance|please run \/login|invalid api key|not logged in/i;

export const queue = new JobQueue({
  run: (job, update, signal) => {
    if (job.kind === "import") return runImport(job, update, signal);
    if (job.kind === "edit") return runEdit(job, update, signal);
    return runRender(job, update, signal);
  },
  canStart: async () => {
    memory = await readMemory();
    return memory.pressure !== "critical";
  },
  stopsQueue: (error) =>
    LIMIT_PATTERN.test(error)
      ? `Paused: Claude can't continue right now. ${error.slice(0, 160)}`
      : null,
  onChange: () => {
    broadcast();
    persist();
    reflectInDock();
  },
  onIdle: ({ done, failed }) => {
    reflectInDock();
    if (Notification.isSupported()) {
      const body = failed > 0 ? `${done} finished, ${failed} didn't.` : `${done} finished.`;
      new Notification({ title: `${brand.name}: the queue is done`, body }).show();
    }
  },
});

/** The small command Claude uses to add a render to the queue, without running it itself. */
function installRenderCommand(): void {
  const data = app.getPath("userData");
  const inbox = join(data, "inbox");
  const bin = join(data, "bin");
  mkdirSync(inbox, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "bf-render"),
    `#!/bin/sh
# Adds project folders to ${brand.name}'s render queue.
for dir in "$@"; do
  case "$dir" in /*) path="$dir" ;; *) path="$PWD/$dir" ;; esac
  file=$(/usr/bin/mktemp "${inbox}/render.XXXXXX")
  printf '%s' "$path" > "$file"
  echo "Added to the queue: $path"
done
`,
    { mode: 0o755 },
  );
}

async function readInbox(enqueue: (dir: string) => void): Promise<void> {
  const inbox = join(app.getPath("userData"), "inbox");
  for (const name of await fs.readdir(inbox).catch(() => [] as string[])) {
    const path = join(inbox, name);
    const dir = await fs.readFile(path, "utf8").catch(() => "");
    await fs.rm(path, { force: true });
    if (dir && isKnownProject(dir)) enqueue(dir);
  }
}

export function startQueue(options: {
  enqueueRender: (dir: string) => void;
  libraryChanged: () => void;
}): void {
  onLibraryChange = options.libraryChanged;
  installRenderCommand();
  try {
    const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { jobs: Job[]; paused: boolean };
    queue.restore(saved.jobs, saved.paused);
  } catch {
    /* an empty queue */
  }
  void readInbox(options.enqueueRender);
  watch(join(app.getPath("userData"), "inbox"), () => void readInbox(options.enqueueRender));
  const refresh = async () => {
    memory = await readMemory();
    broadcast();
  };
  void refresh();
  setInterval(() => void refresh(), 5_000).unref();
  queue.start();
}
