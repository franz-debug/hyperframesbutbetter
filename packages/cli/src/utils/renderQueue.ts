/**
 * Machine-wide render queue.
 *
 * Every local render sizes its own Chrome worker pool to fill the machine
 * (see `computeWorkerSizing` in the engine), so N renders started at once by
 * N agents ask for N machines' worth of Chrome and the computer runs out of
 * memory. This queue caps how many renders run at once across every
 * `hyperframes` process on the machine, and splits the worker budget between
 * them so the total Chrome count stays near what one render would use.
 *
 * A held slot is one file in `~/.hyperframes/render-slots/`, named
 * `<pid>.<suffix>` and touched on a heartbeat. A slot whose process has exited,
 * or whose heartbeat stopped (a reused pid), is free. Claims are made under a
 * short exclusive lock so two processes cannot both take the last slot.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { configDir } from "../auth/paths.js";

export const MAX_PARALLEL_RENDERS_ENV = "HYPERFRAMES_MAX_PARALLEL_RENDERS";

const GIB = 1024 ** 3;
const HEARTBEAT_MS = 30_000;
const STALE_MS = 10 * 60_000;
const LOCK_FILE = ".lock";
/** The claim lock is held for a directory scan and one write; older than this means its holder died. */
const LOCK_STALE_MS = 10_000;

export interface RenderSlot {
  /** Renders allowed at once on this machine; 0 means the queue is off. */
  limit: number;
  release(): void;
}

export interface AcquireRenderSlotOptions {
  limit: number;
  dir?: string;
  signal?: AbortSignal;
  pollMs?: number;
  /** Called once, when the first claim finds every slot taken. */
  onWait?: (running: number, limit: number) => void;
}

/**
 * How many renders may run at once. `HYPERFRAMES_MAX_PARALLEL_RENDERS` wins
 * (0 turns the queue off); otherwise 2 on a machine with 8+ cores and 16+ GB
 * of RAM, else 1. One render already parallelizes across most cores, so a
 * second only helps by overlapping the single-threaded phases (compile,
 * audio, encode) of one render with the capture of another.
 */
export function renderSlotLimit(
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
  memoryBytes: number = totalmem(),
): number {
  const raw = env[MAX_PARALLEL_RENDERS_ENV]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  }
  return cores >= 8 && memoryBytes >= 16 * GIB ? 2 : 1;
}

/**
 * The worker cap each render gets when several may run at once, so their
 * combined Chrome pool stays near one render's auto size (cores - 2).
 * Undefined when one render owns the machine.
 */
export function workersPerRender(
  limit: number,
  cores: number = availableParallelism(),
): number | undefined {
  if (limit <= 1) return undefined;
  return Math.max(1, Math.floor((cores - 2) / limit));
}

function defaultRenderSlotDir(): string {
  return join(configDir(), "render-slots");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isHeld(dir: string, name: string, now: number): boolean {
  const pid = Number(name.split(".")[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return isAlive(pid) && now - statSync(join(dir, name)).mtimeMs <= STALE_MS;
  } catch {
    return false;
  }
}

/** Live holders in `dir`, removing the files of holders that are gone. */
export function liveRenderSlots(dir: string, now = Date.now()): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (isHeld(dir, name, now)) return true;
    rmSync(join(dir, name), { force: true });
    return false;
  });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withClaimLock<T>(dir: string, task: () => T): T {
  const lockPath = join(dir, LOCK_FILE);
  for (;;) {
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS)
          rmSync(lockPath, { force: true });
      } catch {
        /* released between the open and the stat */
      }
      sleepSync(20);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    try {
      return task();
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
}

function tryClaim(dir: string, limit: number, name: string): number | null {
  return withClaimLock(dir, () => {
    const running = liveRenderSlots(dir).length;
    if (running >= limit) return running;
    writeFileSync(join(dir, name), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      mode: 0o600,
    });
    return null;
  });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for a free render slot on this machine and hold it until `release()`. */
export async function acquireRenderSlot(options: AcquireRenderSlotOptions): Promise<RenderSlot> {
  const { limit } = options;
  if (limit <= 0) return { limit: 0, release: () => {} };
  const dir = options.dir ?? defaultRenderSlotDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const file = join(dir, name);

  let announced = false;
  for (;;) {
    const running = tryClaim(dir, limit, name);
    if (running === null) break;
    if (!announced) {
      announced = true;
      options.onWait?.(running, limit);
    }
    await wait(options.pollMs ?? 2_000, options.signal);
  }

  const heartbeat = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      /* best-effort: a missing beat only frees the slot sooner */
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const release = () => {
    clearInterval(heartbeat);
    process.off("exit", release);
    rmSync(file, { force: true });
  };
  process.on("exit", release);
  return { limit, release };
}
