import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";

const FALLBACK_DIRS = [
  join(homedir(), ".local/bin"),
  join(homedir(), ".bun/bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function readLoginPath(): Promise<string> {
  // An app opened from Finder gets a bare PATH, so ask the login shell the way Terminal would.
  const shell = process.env.SHELL || "/bin/zsh";
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-ilc", 'printf "__BF_PATH__%s__BF_END__" "$PATH"'],
      { timeout: 10_000, env: { HOME: homedir(), SHELL: shell } },
      (_error, stdout) => {
        resolve(/__BF_PATH__(.*)__BF_END__/s.exec(stdout ?? "")?.[1] ?? "");
      },
    );
  });
}

let cached: Promise<string> | null = null;

function fullPath(): Promise<string> {
  cached ??= readLoginPath().then((path) => {
    const dirs = [...path.split(":"), ...FALLBACK_DIRS].filter(Boolean);
    return [...new Set(dirs)].join(":");
  });
  return cached;
}

/** The environment for every tool the app runs, without anything inherited from a parent agent. */
export async function toolEnv(extra: Record<string, string> = {}): Promise<NodeJS.ProcessEnv> {
  // userData/bin holds bf-render, which lets Claude add a video to the render queue.
  const path = `${join(app.getPath("userData"), "bin")}:${await fullPath()}`;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, ...extra };
  for (const name of Object.keys(env)) {
    if (name === "CLAUDECODE" || name.startsWith("CLAUDE_CODE_")) delete env[name];
  }
  return env;
}
