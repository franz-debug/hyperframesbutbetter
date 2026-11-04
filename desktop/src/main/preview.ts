import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { app } from "electron";
import { toolEnv } from "./env";

const START_TIMEOUT_MS = 90_000;
const STOP_GRACE_MS = 5_000;

export interface PreviewServer {
  dir: string;
  port: number;
  url: string;
  child: ChildProcess;
  renderJobs: Set<string>;
  projectId: string;
}

const servers = new Map<string, PreviewServer>();
const starting = new Map<string, Promise<PreviewServer>>();

const pidFile = (): string => join(app.getPath("userData"), "previews.json");

function recordPids(): void {
  const pids = [...servers.values()].map((server) => server.child.pid).filter(Boolean);
  writeFileSync(pidFile(), JSON.stringify(pids));
}

/** A crash can leave editors running: stop those from last time, and only those. */
export function stopLeftoverServers(): void {
  if (!existsSync(pidFile())) return;
  try {
    for (const pid of JSON.parse(readFileSync(pidFile(), "utf8")) as number[]) {
      const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)]).toString();
      if (command.includes("hyperframes") && command.includes("preview")) process.kill(pid);
    }
  } catch {
    /* already gone */
  }
}

const isFree = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });

/** The same project gets the same port, so the editor's saved layout follows it between launches. */
async function portFor(dir: string): Promise<number> {
  const hash = createHash("sha1").update(dir).digest().readUInt16BE(0);
  const preferred = 41000 + (hash % 8000);
  for (let port = preferred; port < preferred + 50; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error("No free port for the editor.");
}

async function launch(dir: string): Promise<PreviewServer> {
  const port = await portFor(dir);
  const child = spawn(
    "hyperframes",
    ["preview", dir, "--foreground", "--no-open", "--port", String(port)],
    { cwd: dir, env: await toolEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-4000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const url = `http://localhost:${port}`;
  const exited = new Promise<never>((_ok, fail) => {
    child.once("error", (error) => fail(new Error(`Could not run hyperframes: ${error.message}`)));
    child.once("exit", () => fail(new Error(`The editor stopped while starting.\n${log}`)));
  });
  const projectId = pollUntilReady(url);
  const id = await Promise.race([projectId, exited]);

  const server: PreviewServer = {
    dir,
    port,
    url: `${url}/#project/${encodeURIComponent(id)}`,
    child,
    renderJobs: new Set(),
    projectId: id,
  };
  servers.set(dir, server);
  recordPids();
  child.once("exit", () => {
    if (servers.get(dir) === server) servers.delete(dir);
    recordPids();
  });
  return server;
}

async function pollUntilReady(base: string): Promise<string> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/projects`);
      if (res.ok) {
        const body = (await res.json()) as { projects?: { id?: unknown }[] };
        const id = body.projects?.[0]?.id;
        if (typeof id === "string") return id;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("The editor took too long to start.");
}

export const runningServer = (dir: string): PreviewServer | undefined => servers.get(dir);

export function ensureServer(dir: string): Promise<PreviewServer> {
  const running = servers.get(dir);
  if (running) return Promise.resolve(running);
  const pending = starting.get(dir);
  if (pending) return pending;
  const started = launch(dir).finally(() => starting.delete(dir));
  starting.set(dir, started);
  return started;
}

/** Notes a render the editor is following, so closing its window can leave that render running. */
export function noteRenderJob(port: number, jobId: string): void {
  for (const server of servers.values()) {
    if (server.port === port) server.renderJobs.add(jobId);
  }
}

async function jobIsRendering(server: PreviewServer, jobId: string): Promise<boolean> {
  const abort = new AbortController();
  try {
    const res = await fetch(`http://localhost:${server.port}/api/render/${jobId}/progress`, {
      signal: abort.signal,
    });
    if (!res.ok || !res.body) return false;
    const { value } = await res.body.getReader().read();
    return new TextDecoder().decode(value).includes('"status":"rendering"');
  } catch {
    return false;
  } finally {
    abort.abort();
  }
}

async function isRendering(server: PreviewServer): Promise<boolean> {
  for (const jobId of [...server.renderJobs]) {
    if (await jobIsRendering(server, jobId)) return true;
    server.renderJobs.delete(jobId);
  }
  return false;
}

export async function anyRendering(): Promise<boolean> {
  for (const server of servers.values()) {
    if (await isRendering(server)) return true;
  }
  return false;
}

function stop(server: PreviewServer): void {
  server.child.kill("SIGTERM");
  const force = setTimeout(() => server.child.kill("SIGKILL"), STOP_GRACE_MS);
  server.child.once("exit", () => clearTimeout(force));
}

/** Stops a closed project's editor, once any render it is running has finished. */
export async function releaseServer(dir: string): Promise<void> {
  const server = servers.get(dir);
  if (!server) return;
  while (await isRendering(server)) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    if (servers.get(dir) !== server) return;
  }
  stop(server);
}

export function stopAllServers(): void {
  for (const server of servers.values()) server.child.kill("SIGTERM");
}
