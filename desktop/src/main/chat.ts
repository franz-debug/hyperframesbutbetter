import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { brand, repoDir } from "./brand";
import { toolEnv } from "./env";
import { brandKitDir, brandKitPrompt } from "./brandKits";
import { findFolder } from "./library";
import { currentSettings } from "./settings";
import type { ChatEvent, ChatItem, ChatSnapshot } from "../shared/types";

/** The key of the chat that changes this app itself. */
export const APP_CHAT_KEY = "__app__";
/** A folder's Director chat is keyed by this plus the folder's id; every other key is a project. */
export const DIRECTOR_PREFIX = "director:";
const BRAND_PREFIX = "brand:";

export const brandChatKey = (id: string): string => `${BRAND_PREFIX}${id}`;

const PROJECT_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "TodoWrite",
  "Skill",
  "Task",
  "WebFetch",
  "WebSearch",
  "Bash(hyperframes:*)",
  "Bash(bf-render:*)",
  "Bash(ffmpeg:*)",
  "Bash(ffprobe:*)",
  "Bash(ls:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(grep:*)",
  "Bash(wc:*)",
  "Bash(cut:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(jq:*)",
  "Bash(yt-dlp:*)",
  "Bash(mkdir:*)",
  "Bash(cp:*)",
  "Bash(mv:*)",
];

const APP_TOOLS = [
  ...PROJECT_TOOLS,
  "Bash(bun:*)",
  "Bash(node:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git push:*)",
];

const RENDER_RULE =
  "- Never run `hyperframes render` or more than one heavy command at once: this machine works through one job at a time. To export, run `bf-render <project folder>`, which adds it to the app's export queue, and only when asked.";

const PROJECT_PROMPT = `You are working inside ${brand.name}, a desktop video editor. The person sees this chat beside a live preview of the project in your working directory.
- The preview reloads by itself when you change a file. Never start a preview server.
- Run the local CLI as \`hyperframes <command>\`, never \`npx hyperframes\` or a project's npm scripts.
- Before writing a composition, use the hyperframes skills.
- After changing a composition, run \`hyperframes check\` and fix what it reports.
${RENDER_RULE}
- The person is not a developer: say what changed in the video, in plain words.`;

const APP_PROMPT = `You are changing ${brand.name}, the desktop app this chat is running inside. The person is not a developer and tells you what they want different. Your working directory is the app's source; the engine it runs is in ../packages.
- Follow CLAUDE.md in this folder. Name, colors and logo are in brand.json.
- Run \`bun run typecheck\` before shipping.
- To put a change in the app, run \`bun run ship\` as your LAST step, on its own. It restarts the app, which ends this reply, so first say in plain words what you changed.
- Only commit or push when the person asks you to.`;

function directorPrompt(name: string, paths: string[]): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return `You are the director of "${name}", a folder of ${paths.length} video projects in ${brand.name}. The person tells you about the whole set, usually something every video has wrong, and you see it through across all of them.

The projects:
${list}

How you work:
- Run the local CLI as \`hyperframes <command> <project folder>\`, never \`npx hyperframes\`. Never start a preview server.
- Before writing a composition, use the hyperframes skills.
- For a change across the set, read one project first and work out the fix, then apply it to each project in turn, adapting to what each one actually contains.
- Work through the projects strictly one at a time. Finish a project, including \`hyperframes check <project folder>\`, before starting the next. Never use helpers or parallel commands for this: these are large 4K projects on one machine.
- If one project can't take the change, note why and move on. Don't stop the rest.
- Only change what was asked. If the request is about a subset, only touch those.
${RENDER_RULE} You can pass several folders; they render one after another.
- End with a plain list of every project and what happened to it. The person is not a developer.`;
}

interface StoredChat {
  sessionId: string | null;
  items: ChatItem[];
}

interface Chat extends StoredChat {
  key: string;
  child: ChildProcess | null;
  /** Prompts sent while Claude was still busy. */
  queue: string[];
  stopped: boolean;
  /** Called when the current turn ends, with its error if it had one. */
  onTurnEnd: ((error: string | null) => void) | null;
}

const SHIP_SUMMARY = "Installed the update";
const chats = new Map<string, Chat>();

const chatFile = (key: string): string => {
  const folder = join(app.getPath("userData"), "chats");
  mkdirSync(folder, { recursive: true });
  return join(folder, `${createHash("sha1").update(key).digest("hex")}.json`);
};

function chatFor(key: string): Chat {
  const existing = chats.get(key);
  if (existing) return existing;
  let stored: StoredChat = { sessionId: null, items: [] };
  try {
    stored = JSON.parse(readFileSync(chatFile(key), "utf8")) as StoredChat;
  } catch {
    /* a first chat */
  }
  // A ship restarts the app, which ends the chat that ran it.
  const last = stored.items[stored.items.length - 1];
  if (last?.kind === "tool" && last.summary === SHIP_SUMMARY) {
    stored.items.push({ kind: "note", text: "The app restarted with the change." });
  }
  const chat: Chat = {
    key,
    child: null,
    queue: [],
    stopped: false,
    onTurnEnd: null,
    sessionId: stored.sessionId,
    items: stored.items,
  };
  chats.set(key, chat);
  return chat;
}

function save(chat: Chat): void {
  const stored: StoredChat = { sessionId: chat.sessionId, items: chat.items };
  writeFileSync(chatFile(chat.key), JSON.stringify(stored));
}

function emit(chat: Chat, event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("chat:event", chat.key, event);
  }
}

function append(chat: Chat, item: ChatItem): void {
  chat.items.push(item);
  emit(chat, { kind: "append", item });
  save(chat);
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === "string" ? basename(input.file_path) : null;
  switch (name) {
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `Edited ${file ?? "a file"}`;
    case "Read":
      return `Read ${file ?? "a file"}`;
    case "Glob":
    case "Grep":
    case "LS":
      return "Looked through the files";
    case "Bash": {
      const command = typeof input.command === "string" ? input.command : "";
      if (command.includes("bun run ship")) return SHIP_SUMMARY;
      if (command.includes("bun run typecheck")) return "Checked the code";
      if (command.includes("bf-render")) return "Added to the render queue";
      if (command.includes("hyperframes check")) return "Checked the video for problems";
      if (command.includes("hyperframes snapshot")) return "Looked at frames from the video";
      return `Ran ${(command.split("\n")[0] ?? "").slice(0, 90)}`;
    }
    case "Skill":
      return `Used the ${String(input.skill ?? input.command ?? "")} skill`;
    case "TodoWrite":
      return "Updated its plan";
    case "WebSearch":
      return "Searched the web";
    case "WebFetch":
      return "Read a web page";
    case "Task":
      return "Started a helper";
    default:
      return name;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const blocksOf = (message: unknown): Record<string, unknown>[] => {
  const content = isRecord(message) ? message.content : null;
  return Array.isArray(content) ? content.filter(isRecord) : [];
};

interface TurnState {
  sawDelta: boolean;
  gotResult: boolean;
  resumeFailed: boolean;
  error: string | null;
  assistant: { kind: "assistant"; text: string } | null;
}

function handleDelta(chat: Chat, turn: TurnState, text: string): void {
  turn.sawDelta = true;
  if (!turn.assistant) {
    turn.assistant = { kind: "assistant", text: "" };
    append(chat, turn.assistant);
  }
  turn.assistant.text += text;
  emit(chat, { kind: "delta", text });
}

function handleAssistantMessage(chat: Chat, turn: TurnState, message: unknown): void {
  for (const block of blocksOf(message)) {
    if (block.type === "text" && typeof block.text === "string" && !turn.sawDelta) {
      append(chat, { kind: "assistant", text: block.text });
    }
    if (block.type === "tool_use") {
      turn.assistant = null;
      turn.sawDelta = false;
      const input = isRecord(block.input) ? block.input : {};
      append(chat, {
        kind: "tool",
        id: String(block.id ?? ""),
        summary: toolSummary(String(block.name ?? "Tool"), input),
      });
    }
  }
}

function handleToolResults(chat: Chat, message: unknown): void {
  for (const block of blocksOf(message)) {
    if (block.type !== "tool_result" || block.is_error !== true) continue;
    const id = String(block.tool_use_id ?? "");
    const tool = chat.items.find((item) => item.kind === "tool" && item.id === id);
    if (tool?.kind === "tool") tool.failed = true;
    emit(chat, { kind: "tool-result", id, failed: true });
  }
}

function handleResult(chat: Chat, turn: TurnState, event: Record<string, unknown>): void {
  turn.gotResult = true;
  if (typeof event.session_id === "string") chat.sessionId = event.session_id;
  if (event.is_error === true) {
    const text = typeof event.result === "string" ? event.result : "Claude stopped with an error.";
    if (/no conversation found/i.test(text)) {
      turn.resumeFailed = true;
    } else {
      turn.error = text;
      append(chat, { kind: "error", text });
    }
  }
}

function handleLine(chat: Chat, turn: TurnState, line: string): void {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(event)) return;
  if (event.type === "system" && typeof event.session_id === "string") {
    chat.sessionId = event.session_id;
  } else if (event.type === "stream_event" && isRecord(event.event)) {
    const delta = event.event.delta;
    if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string") {
      handleDelta(chat, turn, delta.text);
    }
  } else if (event.type === "assistant") {
    handleAssistantMessage(chat, turn, event.message);
  } else if (event.type === "user") {
    handleToolResults(chat, event.message);
  } else if (event.type === "result") {
    handleResult(chat, turn, event);
  }
}

interface ChatProfile {
  cwd: string;
  tools: string[];
  prompt: string;
  extraArgs: string[];
  env: Record<string, string>;
}

function profileFor(key: string): ChatProfile {
  if (key.startsWith(BRAND_PREFIX)) {
    const id = key.slice(BRAND_PREFIX.length);
    return {
      cwd: brandKitDir(id),
      tools: [
        "Read",
        "Write",
        "Edit",
        "Glob",
        "Grep",
        "WebFetch",
        "WebSearch",
        "Bash(curl:*)",
        "Bash(ls:*)",
      ],
      prompt: `You build a brand kit in your working directory for ${brand.name}. Read the site the person names and fill in kit.json, keeping its existing fields. "colors" is a list of {"role","value"} where role is Main, Secondary, Accent, Text, Background or Neutral and value is a hex color. Download the logos into this folder with curl and list their file names in "logos", main logo first; SVG or PNG. Put the type styles you see in "textStyles" as a short description, and how the brand talks in "rules". Don't invent anything you can't see. End by saying in one line what you found.`,
      extraArgs: [],
      env: {},
    };
  }
  if (key === APP_CHAT_KEY) {
    return {
      cwd: join(repoDir, "desktop"),
      tools: APP_TOOLS,
      prompt: APP_PROMPT,
      // Skips the skills plugin here: Claude won't edit a loaded plugin's own files.
      extraArgs: ["--add-dir", repoDir],
      env: {},
    };
  }
  const pluginArgs = ["--plugin-dir", repoDir];
  // Marks the CLI as running inside a host app, so the agent can't start a second preview.
  if (key.startsWith(DIRECTOR_PREFIX)) {
    const folder = findFolder(key.slice(DIRECTOR_PREFIX.length));
    const paths = (folder?.paths ?? []).filter((path) => existsSync(path));
    const cwd = join(app.getPath("userData"), "directors", folder?.id ?? "unknown");
    mkdirSync(cwd, { recursive: true });
    return {
      cwd,
      tools: PROJECT_TOOLS.filter((tool) => tool !== "Task"),
      prompt: directorPrompt(folder?.name ?? "this folder", paths),
      extraArgs: [...pluginArgs, ...paths.flatMap((path) => ["--add-dir", path])],
      env: { HYPERFRAMES_DESKTOP_PROJECT: cwd },
    };
  }
  return {
    cwd: key,
    tools: PROJECT_TOOLS,
    prompt: `${PROJECT_PROMPT}${brandKitPrompt(key)}`,
    extraArgs: pluginArgs,
    env: { HYPERFRAMES_DESKTOP_PROJECT: key },
  };
}

const isProjectKey = (key: string): boolean =>
  key !== APP_CHAT_KEY && !key.startsWith(DIRECTOR_PREFIX) && !key.startsWith(BRAND_PREFIX);

async function run(chat: Chat, text: string): Promise<void> {
  const profile = profileFor(chat.key);
  const settings = currentSettings();
  const startedAt = new Date().toISOString();
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    ...(settings.access === "full" && !chat.key.startsWith(BRAND_PREFIX)
      ? ["--dangerously-skip-permissions"]
      : [
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          profile.tools.join(","),
          "--disallowedTools",
          "Bash(hyperframes render:*),Bash(hyperframes preview:*)",
        ]),
    ...(settings.model !== "default" ? ["--model", settings.model] : []),
    ...(settings.effort !== "default" ? ["--effort", settings.effort] : []),
    "--append-system-prompt",
    profile.prompt,
    ...profile.extraArgs,
    ...(chat.sessionId ? ["--resume", chat.sessionId] : []),
  ];
  const child = spawn("claude", args, {
    cwd: profile.cwd,
    env: await toolEnv(profile.env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  chat.child = child;
  chat.stopped = false;
  emit(chat, { kind: "state", running: true });

  const turn: TurnState = {
    sawDelta: false,
    gotResult: false,
    resumeFailed: false,
    error: null,
    assistant: null,
  };
  let buffer = "";
  let errors = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) handleLine(chat, turn, line);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-2000);
  });
  child.stdin.end(text);

  const finish = () => {
    chat.child = null;
    if (isProjectKey(chat.key) && !chat.stopped) append(chat, { kind: "run-end", at: startedAt });
    save(chat);
    const done = chat.onTurnEnd;
    chat.onTurnEnd = null;
    const next = chat.queue.shift();
    if (next) void run(chat, next);
    else emit(chat, { kind: "state", running: false });
    done?.(turn.error ?? (chat.stopped ? "Stopped from the chat." : null));
  };
  child.once("error", (error) => {
    turn.error = `Could not start Claude Code: ${error.message}`;
    append(chat, { kind: "error", text: turn.error });
    finish();
  });
  child.once("close", (code, signal) => {
    if (turn.resumeFailed) {
      // The saved conversation is gone: start fresh instead of leaving the chat stuck.
      chat.sessionId = null;
      chat.child = null;
      void run(chat, text);
      return;
    }
    if (!turn.gotResult && !signal && code !== 0 && !turn.error && !chat.stopped) {
      turn.error = errors.trim() || `Claude Code stopped (code ${code}).`;
      append(chat, { kind: "error", text: turn.error });
    }
    finish();
  });
}

export function chatSnapshot(key: string): ChatSnapshot {
  const chat = chatFor(key);
  return { items: chat.items, running: chat.child !== null };
}

/**
 * Shows `display` in the chat and sends `text` to Claude. While it's busy, "queue" waits for the
 * current reply and "steer" stops it and starts again with these words.
 */
export async function chatSend(
  key: string,
  text: string,
  display = text,
  mode: "steer" | "queue" = "queue",
): Promise<void> {
  const chat = chatFor(key);
  append(chat, { kind: "user", text: display });
  if (chat.child) {
    if (mode === "steer") {
      chat.queue.unshift(text);
      chat.child.kill("SIGINT");
    } else {
      chat.queue.push(text);
    }
    return;
  }
  await run(chat, text);
}

/** Starts a fresh conversation. Earlier messages stay on screen. */
export function chatClear(key: string): void {
  const chat = chatFor(key);
  chat.sessionId = null;
  append(chat, { kind: "note", text: "New conversation. Claude won't remember what's above." });
}

export function chatNote(key: string, text: string): void {
  append(chatFor(key), { kind: "note", text });
}

/** For the queue: runs one request to the end and throws if it failed or was stopped early. */
export async function chatRunToEnd(
  key: string,
  text: string,
  display: string,
  signal: AbortSignal,
): Promise<void> {
  const chat = chatFor(key);
  while (chat.child) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    if (signal.aborted) return;
  }
  const stop = () => chat.child?.kill("SIGINT");
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      chat.onTurnEnd = (error) => (error ? reject(new Error(error)) : resolve());
      chatSend(key, text, display).catch(reject);
    });
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

export function chatStop(key: string): void {
  const chat = chatFor(key);
  chat.queue = [];
  chat.stopped = true;
  chat.child?.kill("SIGINT");
}

export function stopAllChats(): void {
  for (const chat of chats.values()) {
    chat.child?.kill("SIGTERM");
    save(chat);
  }
}
