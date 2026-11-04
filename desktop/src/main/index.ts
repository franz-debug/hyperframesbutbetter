import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  net,
  protocol,
  session,
  shell,
  WebContentsView,
} from "electron";
import { brand, editorCss } from "./brand";
import buildInfo from "./buildInfo";
import {
  addKitFiles,
  applyKitToProject,
  brandKitDir,
  brandKitsChanged,
  deleteKit,
  listKits,
  newKit,
  readKit,
  saveKit,
} from "./brandKits";
import {
  brandChatKey,
  chatClear,
  chatNote,
  chatRunToEnd,
  chatSend,
  chatSnapshot,
  chatStop,
  stopAllChats,
} from "./chat";
import {
  addProjectDir,
  createFolder,
  findFolder,
  foldersList,
  isArchived,
  isPinned,
  lastExportDir,
  librarySnapshot,
  mediaUrl,
  moveToFolder,
  projectDisplayName,
  projectKitId,
  rememberExportDir,
  rememberShareLink,
  removeFolder,
  renameFolder,
  resolveMediaPath,
  setArchived,
  setFolderExportDir,
  setFolderOpen,
  setPinned,
  setProjectKitId,
  shareLinkFor,
} from "./library";
import { pendingAdd, pendingList, pendingRemove, pendingSend, pendingUpdate } from "./pending";
import {
  anyRendering,
  ensureServer,
  noteRenderJob,
  releaseServer,
  stopAllServers,
  stopLeftoverServers,
} from "./preview";
import { copyIntoAssets, createBlankProject, isVideoFile, projectNameFromFile } from "./projects";
import { captionStyles, menuData, readScript, runCli, saveScriptCut, undoRun } from "./projectData";
import { queue, queueSnapshot, startQueue } from "./queue";
import { currentSettings, updateSettings } from "./settings";
import type {
  Bounds,
  BrandKit,
  ExportOptions,
  ExportRequest,
  HeygenStatus,
  MakeRequest,
  MakeResult,
  PendingEdit,
  Settings,
  UiCommand,
  VideoFolder,
} from "../shared/types";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "bf-media",
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

app.setName(brand.name);
// Lets a test run keep its folders, chats and queue away from the real ones.
if (process.env.BETTER_FRAMES_USER_DATA)
  app.setPath("userData", process.env.BETTER_FRAMES_USER_DATA);

const EDITOR_IDLE_MS = 60_000;
const windowFile = (): string => join(app.getPath("userData"), "window.json");

let main: BrowserWindow | null = null;
let quitPending = false;
let editorRequest = 0;

/** Only one project is open in the editor at a time, which is what keeps memory use flat. */
let editor: { dir: string; view: WebContentsView; idle: NodeJS.Timeout | null } | null = null;

const send = (command: UiCommand): void => {
  if (main && !main.isDestroyed()) main.webContents.send("ui:command", command);
};

function libraryChanged(): void {
  if (main && !main.isDestroyed()) main.webContents.send("library:changed");
}

function openExternal(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

function showMain(): void {
  if (main && !main.isDestroyed()) {
    main.show();
    main.focus();
    return;
  }
  let saved: Partial<Bounds> = {};
  try {
    saved = JSON.parse(readFileSync(windowFile(), "utf8")) as Partial<Bounds>;
  } catch {
    /* first launch */
  }
  main = new BrowserWindow({
    width: saved.width ?? 1480,
    height: saved.height ?? 940,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 1100,
    minHeight: 640,
    title: brand.name,
    backgroundColor: brand.colors.background,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  main.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  main.on("page-title-updated", (event) => event.preventDefault());
  main.on("close", () => {
    if (main) writeFileSync(windowFile(), JSON.stringify(main.getBounds()));
  });
  main.on("closed", () => {
    closeEditor();
    main = null;
  });
  void main.loadFile(join(__dirname, "renderer", "app.html"));
}

function closeEditor(): void {
  if (!editor) return;
  const { dir, view, idle } = editor;
  if (idle) clearTimeout(idle);
  editor = null;
  if (main && !main.isDestroyed()) main.contentView.removeChildView(view);
  view.webContents.close();
  void releaseServer(dir);
}

async function openEditor(dir: string): Promise<void> {
  if (!main) return;
  const request = ++editorRequest;
  if (editor?.dir === dir) {
    if (editor.idle) clearTimeout(editor.idle);
    editor.idle = null;
    editor.view.setVisible(true);
    return;
  }
  closeEditor();
  const server = await ensureServer(dir);
  // The person moved on while it started: free it instead of showing a stale project.
  if (request !== editorRequest || !main || main.isDestroyed()) {
    if (editor?.dir !== dir) void releaseServer(dir);
    return;
  }
  const view = new WebContentsView({
    webPreferences: {
      partition: "persist:editor",
      preload: join(__dirname, "editor-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
    },
  });
  view.setBackgroundColor(brand.colors.background);
  const contents = view.webContents;
  contents.on("dom-ready", () => void contents.insertCSS(editorCss()));
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).port !== String(server.port)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  main.contentView.addChildView(view);
  editor = { dir, view, idle: null };
  await contents.loadURL(server.url);
}

/** Leaving a project hides its editor, then frees its memory if you don't come straight back. */
function hideEditor(): void {
  editorRequest++;
  if (!editor) return;
  editor.view.setVisible(false);
  if (editor.idle) clearTimeout(editor.idle);
  editor.idle = setTimeout(closeEditor, EDITOR_IDLE_MS);
}

/** Runs on the editor's own requests: hides HeyGen's app button and follows renders. */
function watchEditorRequests(): void {
  session
    .fromPartition("persist:editor")
    .webRequest.onBeforeRequest({ urls: ["http://localhost:*/*"] }, (details, respond) => {
      const url = new URL(details.url);
      if (url.pathname === "/api/open-in-desktop") {
        respond({ redirectURL: `${url.origin}/api/not-available` });
        return;
      }
      const job = /^\/api\/render\/([^/]+)\/progress$/.exec(url.pathname);
      if (job?.[1]) noteRenderJob(Number(url.port), job[1]);
      respond({});
    });
}

function serveMedia(): void {
  protocol.handle("bf-media", (request) => {
    const path = resolveMediaPath(request.url);
    if (!path) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(path).toString());
  });
}

async function chooseFolder(title: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title,
    properties: ["openDirectory", "createDirectory"],
    ...(lastExportDir() ? { defaultPath: lastExportDir() ?? undefined } : {}),
  };
  const result = main
    ? await dialog.showOpenDialog(main, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function enqueueRender(
  dir: string,
  target: { exportDir?: string | null; options?: ExportOptions } = {},
): void {
  if (queue.hasRender(dir)) return;
  const folder = foldersList().find((item) => item.paths.includes(dir));
  queue.add({
    kind: "render",
    title: projectDisplayName(dir),
    dir,
    exportDir: target.exportDir ?? folder?.exportDir ?? null,
    options: target.options ?? currentSettings().exportOptions,
  });
  queue.start();
}

/** Adds videos to the export queue from the Export panel's choices. */
async function startExport(request: ExportRequest): Promise<void> {
  const { dirs, options } = request;
  if (dirs.length === 0) return;
  updateSettings({ exportOptions: options });
  const folders = foldersList();
  const owner = (dir: string) => folders.find((item) => item.paths.includes(dir));
  const first = owner(dirs[0] ?? "");
  const sameFolder = first && dirs.every((dir) => owner(dir)?.id === first.id) ? first : null;
  const exportDir =
    request.exportDir ??
    sameFolder?.exportDir ??
    (await chooseFolder(
      sameFolder ? `Save the videos from ${sameFolder.name} to` : "Save the video to",
    ));
  if (!exportDir) return;
  rememberExportDir(exportDir);
  if (sameFolder) setFolderExportDir(sameFolder.id, exportDir);
  libraryChanged();
  for (const dir of dirs) {
    if (existsSync(join(dir, "index.html"))) enqueueRender(dir, { exportDir, options });
  }
}

/** The video files directly in a folder. Subfolders such as old exports are left out. */
async function scanVideoFolder(path: string): Promise<VideoFolder> {
  const names = await fs.readdir(path);
  const videos = names
    .filter((name) => isVideoFile(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => join(path, name));
  return { name: basename(path), videos };
}

/** Starts at a plugged-in card or drive if there is one. */
async function firstExternalVolume(): Promise<string | undefined> {
  const volumes = await fs.readdir("/Volumes").catch(() => [] as string[]);
  const external = volumes.find((name) => name !== "Macintosh HD" && !name.startsWith("."));
  return external ? join("/Volumes", external) : undefined;
}

async function pickVideoFolder(): Promise<VideoFolder | null> {
  const defaultPath = await firstExternalVolume();
  const options: Electron.OpenDialogOptions = {
    title: "Choose the folder of videos",
    properties: ["openDirectory"],
    ...(defaultPath ? { defaultPath } : {}),
  };
  const result = main
    ? await dialog.showOpenDialog(main, options)
    : await dialog.showOpenDialog(options);
  const path = result.filePaths[0];
  return result.canceled || !path ? null : scanVideoFolder(path);
}

/**
 * A new project from scratch opens straight away. Videos go through the queue instead: every
 * video is imported first, then each is edited in turn, then each is rendered in turn.
 */
async function make(request: MakeRequest): Promise<MakeResult> {
  if (request.videos.length === 0) {
    const dir = await createBlankProject(request.prompt, request.orientation, request.files);
    if (request.brandKitId) {
      setProjectKitId(dir, request.brandKitId);
      applyKitToProject(request.brandKitId, dir);
    }
    libraryChanged();
    void chatSend(dir, request.prompt);
    return { kind: "project", dir };
  }
  const size = request.videos.length;
  const folder =
    size > 1 || request.folderName
      ? createFolder(request.folderName ?? `${size} videos`, [], request.exportDir)
      : null;
  if (request.exportDir) rememberExportDir(request.exportDir);
  const folderId = folder?.id ?? null;
  const imports = request.videos.map((video) =>
    queue.add({
      kind: "import",
      title: projectNameFromFile(video),
      sourcePath: video,
      folderId,
      batchSize: size,
      brandKitId: request.brandKitId,
    }),
  );
  const prompt = request.prompt.trim();
  const edits = prompt
    ? imports.map((item) =>
        queue.add({
          kind: "edit",
          title: item.title,
          after: item.id,
          instruction: prompt,
          folderId,
          batchSize: size,
        }),
      )
    : imports;
  if (request.renderWhenEdited) {
    for (const item of edits) {
      queue.add({
        kind: "render",
        title: item.title,
        after: item.id,
        exportDir: request.exportDir,
        folderId,
        batchSize: size,
        options: currentSettings().exportOptions,
      });
    }
  }
  libraryChanged();
  queue.start();
  return { kind: "batch", folderId };
}

function projectMenu(dir: string): void {
  const pinned = isPinned(dir);
  const archived = isArchived(dir);
  const update = (change: () => void) => () => {
    change();
    libraryChanged();
  };
  const folders = foldersList();
  const current = folders.find((folder) => folder.paths.includes(dir));
  Menu.buildFromTemplate([
    { label: "Open", click: () => send({ kind: "open-project", dir }) },
    { label: "Export…", click: () => send({ kind: "export-panel", dirs: [dir] }) },
    { type: "separator" },
    { label: pinned ? "Unpin" : "Pin", click: update(() => setPinned(dir, !pinned)) },
    {
      label: "Move to Folder",
      submenu: [
        ...folders.map((folder) => ({
          label: folder.name,
          type: "checkbox" as const,
          checked: folder.id === current?.id,
          click: update(() => moveToFolder(dir, folder.id)),
        })),
        { type: "separator" as const },
        { label: "New Folder…", click: () => send({ kind: "new-folder", dirs: [dir] }) },
        ...(current
          ? [{ label: "Remove from Folder", click: update(() => moveToFolder(dir, null)) }]
          : []),
      ],
    },
    { label: archived ? "Unarchive" : "Archive", click: update(() => setArchived(dir, !archived)) },
    { type: "separator" },
    { label: "Show in Finder", click: () => shell.showItemInFolder(dir) },
  ]).popup();
}

function folderMenu(id: string): void {
  const folder = findFolder(id);
  if (!folder) return;
  Menu.buildFromTemplate([
    { label: "Export All…", click: () => send({ kind: "export-panel", dirs: folder.paths }) },
    {
      label: "Rename…",
      click: () => send({ kind: "rename-folder", id, name: folder.name }),
    },
    { type: "separator" },
    {
      label: "Remove Folder (keeps the videos)",
      click: () => {
        removeFolder(id);
        libraryChanged();
      },
    },
  ]).popup();
}

async function importProjects(): Promise<void> {
  const options: Electron.OpenDialogOptions = {
    title: "Import project folders",
    properties: ["openDirectory", "multiSelections"],
  };
  const result = main
    ? await dialog.showOpenDialog(main, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled) return;
  const skipped: string[] = [];
  for (const dir of result.filePaths) {
    if (existsSync(join(dir, "index.html"))) addProjectDir(dir);
    else skipped.push(basename(dir));
  }
  libraryChanged();
  if (skipped.length > 0) {
    await dialog.showMessageBox({
      type: "warning",
      message: "Some folders aren't video projects",
      detail: `A project folder has an index.html file in it. Skipped: ${skipped.join(", ")}`,
    });
  }
}

interface EditorMark {
  kind: "draw" | "comment";
  note: string;
  time: string;
  /** In words, for a comment: how far across and down the frame it's pinned. */
  where: string;
  rect: Bounds;
}

async function heygenStatus(): Promise<HeygenStatus> {
  const result = await runCli(["auth", "status"]);
  const signedIn = result.ok && !/not signed in/i.test(result.output);
  const detail = result.output.trim().split("\n")[0] ?? "";
  return { signedIn, detail: signedIn ? detail : "Not connected" };
}

function registerIpc(): void {
  ipcMain.handle("app:name", () => brand.name);
  ipcMain.handle("library:get", () => librarySnapshot());
  ipcMain.handle("library:import", () => importProjects());
  ipcMain.handle("make", (_e, request: MakeRequest) => make(request));
  ipcMain.handle("pick:files", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Add files",
      properties: ["openFile", "multiSelections"],
    };
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    // Macs leave hidden "._" companion files on cards and drives. They aren't videos.
    return result.canceled
      ? []
      : result.filePaths.filter((path) => !basename(path).startsWith("._"));
  });
  ipcMain.handle("pick:videoFolder", () => pickVideoFolder());
  ipcMain.handle("scan:videoFolder", (_e, path: string) => scanVideoFolder(path));
  ipcMain.handle("pick:folder", () => chooseFolder("Save the videos to"));
  ipcMain.handle("menu:project", (_e, dir: string) => projectMenu(dir));
  ipcMain.handle("menu:folder", (_e, id: string) => folderMenu(id));
  ipcMain.handle("folder:new", (_e, name: string, dirs: string[]) => {
    const folder = createFolder(name, dirs);
    libraryChanged();
    return folder.id;
  });
  ipcMain.handle("folder:rename", (_e, id: string, name: string) => {
    renameFolder(id, name);
    libraryChanged();
  });
  ipcMain.handle("folder:open", (_e, id: string, open: boolean) => setFolderOpen(id, open));
  ipcMain.handle("folder:exportDir", async (_e, id: string) => {
    const chosen = await chooseFolder("Save this folder's videos to");
    if (chosen) {
      setFolderExportDir(id, chosen);
      libraryChanged();
    }
  });
  ipcMain.handle("folder:move", (_e, dir: string, folderId: string | null) => {
    moveToFolder(dir, folderId);
    libraryChanged();
  });
  ipcMain.handle("finder", (_e, path: string) => shell.showItemInFolder(path));
  ipcMain.handle("editor:open", (_e, dir: string) => openEditor(dir));
  ipcMain.handle("editor:hide", () => hideEditor());
  ipcMain.handle("editor:bounds", (_e, bounds: Bounds) => editor?.view.setBounds(bounds));
  ipcMain.on("editor:ask-agent", (_e, prompt: string, instruction: string) => {
    if (!editor) return;
    send({ kind: "show-chat" });
    pendingAdd(editor.dir, { kind: "select", note: instruction, detail: prompt });
  });
  ipcMain.on("editor:export", () => {
    if (editor) send({ kind: "export-panel", dirs: [editor.dir] });
  });
  ipcMain.handle("editor:annotate", async (_e, mark: EditorMark) => {
    if (!editor) return;
    const { dir, view } = editor;
    const image = await view.webContents.capturePage(mark.rect);
    const folder = join(dir, ".hyperframes", "annotations");
    await fs.mkdir(folder, { recursive: true });
    const path = join(folder, `${Date.now()}.png`);
    await fs.writeFile(path, image.toPNG());
    send({ kind: "show-chat" });
    const what =
      mark.kind === "draw"
        ? "A red drawing on the picture"
        : `A comment pinned ${mark.where} (a red dot)`;
    pendingAdd(dir, {
      kind: mark.kind,
      note: mark.note,
      detail: `${what} at ${mark.time} in the video. The marked-up frame is saved at ${path}: read that image to see exactly where.`,
    });
  });
  ipcMain.handle("export:start", (_e, request: ExportRequest) => startExport(request));
  ipcMain.handle("open:file", (_e, path: string) => shell.openPath(path));
  ipcMain.handle("pick:file", async () => {
    const options: Electron.OpenDialogOptions = {
      title: "Choose a file",
      properties: ["openFile"],
    };
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("settings:get", () => currentSettings());
  ipcMain.handle("settings:update", (_e, patch: Partial<Settings>) => updateSettings(patch));
  ipcMain.handle("pending:list", (_e, key: string) => pendingList(key));
  ipcMain.handle("pending:add", (_e, key: string, edit: Omit<PendingEdit, "id">) =>
    pendingAdd(key, edit),
  );
  ipcMain.handle("pending:update", (_e, key: string, id: string, note: string) =>
    pendingUpdate(key, id, note),
  );
  ipcMain.handle("pending:remove", (_e, key: string, id: string) => pendingRemove(key, id));
  ipcMain.handle("pending:send", (_e, key: string, note: string) => pendingSend(key, note));
  ipcMain.handle("menu:data", (_e, key: string) => menuData(key));
  ipcMain.handle("project:addFiles", async (_e, dir: string) => {
    const options: Electron.OpenDialogOptions = {
      title: "Add files to this project",
      properties: ["openFile", "multiSelections"],
    };
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    await copyIntoAssets(dir, result.filePaths);
    return result.filePaths.map((path) => ({
      label: basename(path),
      path: join("assets", basename(path)),
    }));
  });
  ipcMain.handle("captions:list", () => captionStyles());
  ipcMain.handle("script:get", (_e, dir: string) => readScript(dir));
  ipcMain.handle("script:setCut", (_e, dir: string, cut: number[]) => saveScriptCut(dir, cut));
  ipcMain.handle("chat:clear", (_e, key: string) => chatClear(key));
  ipcMain.handle("chat:undo", async (_e, key: string, at: string) => {
    const result = await undoRun(key, at);
    const message = result.ok
      ? "Put the project back to how it was before that run."
      : `Couldn't undo that run. ${result.message}`;
    chatNote(key, message);
    return message;
  });
  ipcMain.handle("brand:list", () => listKits());
  ipcMain.handle("brand:new", (_e, name: string, site: string) => newKit(name, site));
  ipcMain.handle("brand:save", (_e, kit: BrandKit) => saveKit(kit));
  ipcMain.handle("brand:delete", (_e, id: string) => deleteKit(id));
  ipcMain.handle("brand:addFiles", async (_e, id: string, kind: "logos" | "fonts" | "files") => {
    const options: Electron.OpenDialogOptions = {
      title: "Add to this brand kit",
      properties: ["openFile", "multiSelections"],
    };
    const result = main
      ? await dialog.showOpenDialog(main, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? readKit(id) : addKitFiles(id, kind, result.filePaths);
  });
  ipcMain.handle("brand:scan", async (_e, id: string) => {
    const kit = readKit(id);
    if (!kit?.site) return;
    await chatRunToEnd(
      brandChatKey(id),
      `Build this brand kit from ${kit.site}.`,
      `Scan ${kit.site}`,
      new AbortController().signal,
    ).finally(brandKitsChanged);
  });
  ipcMain.handle("brand:fileUrl", (_e, id: string, name: string) =>
    mediaUrl(join(brandKitDir(id), name)),
  );
  ipcMain.handle("brand:forProject", (_e, dir: string) => projectKitId(dir));
  ipcMain.handle("brand:setForProject", (_e, dir: string, id: string | null) => {
    setProjectKitId(dir, id);
    if (id) applyKitToProject(id, dir);
  });
  ipcMain.handle("share:link", (_e, dir: string) => shareLinkFor(dir));
  ipcMain.handle("share:publish", async (_e, dir: string) => {
    const existing = shareLinkFor(dir);
    const args = ["publish", dir, "--yes", ...(existing ? ["--update", existing] : [])];
    const result = await runCli(args, 600_000);
    const url = /https?:\/\/\S+/.exec(result.output)?.[0]?.replace(/[)"',.]+$/, "");
    if (!result.ok || !url)
      throw new Error(result.output.slice(-400) || "Publishing didn't finish.");
    rememberShareLink(dir, url);
    return url;
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle("heygen:status", () => heygenStatus());
  ipcMain.handle("heygen:signIn", async () => {
    await runCli(["auth", "login"], 300_000);
    return heygenStatus();
  });
  ipcMain.handle("heygen:useKey", async (_e, key: string) => {
    await runCli(["auth", "login", "--api-key"], 60_000, key);
    return heygenStatus();
  });
  ipcMain.handle("heygen:signOut", async () => {
    await runCli(["auth", "logout"]);
    return heygenStatus();
  });
  ipcMain.handle("queue:get", () => queueSnapshot());
  ipcMain.handle("queue:cancel", (_e, id: string) => queue.cancel(id));
  ipcMain.handle("queue:retry", (_e, id: string) => queue.retry(id));
  ipcMain.handle("queue:clear", () => queue.clearFinished());
  ipcMain.handle("queue:paused", (_e, paused: boolean) => queue.setPaused(paused));
  ipcMain.handle("chat:load", (_e, key: string) => chatSnapshot(key));
  ipcMain.handle("chat:send", (_e, key: string, text: string) => chatSend(key, text));
  ipcMain.handle("chat:stop", (_e, key: string) => chatStop(key));
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: brand.name,
      submenu: [
        { role: "about" },
        { label: `Change ${brand.name}…`, click: () => send({ kind: "go-change" }) },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+Shift+H", click: () => send({ kind: "go-home" }) },
        {
          label: "Queue",
          accelerator: "CmdOrCtrl+Shift+Q",
          click: () => send({ kind: "go-queue" }),
        },
        { label: "Import Projects…", click: () => void importProjects() },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Chat",
          accelerator: "CmdOrCtrl+J",
          click: () => send({ kind: "toggle-chat" }),
        },
        {
          label: "Reload Editor",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => editor?.view.webContents.reload(),
        },
        {
          label: "Editor Developer Tools",
          accelerator: "Alt+CmdOrCtrl+I",
          click: () => editor?.view.webContents.openDevTools({ mode: "detach" }),
        },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function confirmQuit(): Promise<boolean> {
  if (!queue.isRunning && !(await anyRendering())) return true;
  const { response } = await dialog.showMessageBox({
    type: "warning",
    buttons: ["Keep Working", "Quit Anyway"],
    defaultId: 0,
    cancelId: 0,
    message: "The queue is still working",
    detail: "Quitting stops the current video. It starts over the next time you open the app.",
  });
  return response === 1;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMain());
  app.on("activate", () => showMain());
  app.on("window-all-closed", () => {
    /* A Mac app stays open with no windows, and the queue keeps working. */
  });
  app.on("before-quit", (event) => {
    event.preventDefault();
    if (quitPending) return;
    quitPending = true;
    void confirmQuit().then((ok) => {
      quitPending = false;
      if (!ok) return;
      stopAllChats();
      stopAllServers();
      app.exit(0);
    });
  });
  // `bun run ship` asks a running copy to quit this way.
  process.on("SIGTERM", () => app.quit());

  void app.whenReady().then(() => {
    const info = buildInfo();
    app.setAboutPanelOptions({
      applicationName: brand.name,
      applicationVersion: `build ${info.commit}`,
      version: info.builtAt.slice(0, 10),
      credits: "Built on the open-source HyperFrames framework (Apache-2.0).",
    });
    stopLeftoverServers();
    serveMedia();
    watchEditorRequests();
    registerIpc();
    buildMenu();
    showMain();
    startQueue({ enqueueRender, libraryChanged });
  });
}
