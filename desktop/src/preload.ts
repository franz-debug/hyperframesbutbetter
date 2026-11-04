import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppApi, ChatEvent, PendingEdit, QueueSnapshot, UiCommand } from "./shared/types";

const api: AppApi = {
  appName: () => ipcRenderer.invoke("app:name"),
  library: () => ipcRenderer.invoke("library:get"),
  make: (request) => ipcRenderer.invoke("make", request),
  pickFiles: () => ipcRenderer.invoke("pick:files"),
  pickFolder: () => ipcRenderer.invoke("pick:folder"),
  pickVideoFolder: () => ipcRenderer.invoke("pick:videoFolder"),
  scanVideoFolder: (path) => ipcRenderer.invoke("scan:videoFolder", path),
  pathForFile: (file) => webUtils.getPathForFile(file),
  importProjects: () => ipcRenderer.invoke("library:import"),
  projectMenu: (dir) => ipcRenderer.invoke("menu:project", dir),
  folderMenu: (id) => ipcRenderer.invoke("menu:folder", id),
  newFolder: (name, dirs) => ipcRenderer.invoke("folder:new", name, dirs),
  renameFolder: (id, name) => ipcRenderer.invoke("folder:rename", id, name),
  setFolderOpen: (id, open) => ipcRenderer.invoke("folder:open", id, open),
  setFolderExportDir: (id) => ipcRenderer.invoke("folder:exportDir", id),
  moveToFolder: (dir, folderId) => ipcRenderer.invoke("folder:move", dir, folderId),
  showInFinder: (path) => ipcRenderer.invoke("finder", path),
  openEditor: (dir) => ipcRenderer.invoke("editor:open", dir),
  hideEditor: () => ipcRenderer.invoke("editor:hide"),
  setEditorBounds: (bounds) => ipcRenderer.invoke("editor:bounds", bounds),
  startExport: (request) => ipcRenderer.invoke("export:start", request),
  openFile: (path) => ipcRenderer.invoke("open:file", path),
  pickFile: () => ipcRenderer.invoke("pick:file"),
  settings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch) => ipcRenderer.invoke("settings:update", patch),
  pendingList: (key) => ipcRenderer.invoke("pending:list", key),
  pendingAdd: (key, edit) => ipcRenderer.invoke("pending:add", key, edit),
  pendingUpdate: (key, id, note) => ipcRenderer.invoke("pending:update", key, id, note),
  pendingRemove: (key, id) => ipcRenderer.invoke("pending:remove", key, id),
  pendingSend: (key, note) => ipcRenderer.invoke("pending:send", key, note),
  menuData: (key) => ipcRenderer.invoke("menu:data", key),
  addFilesToProject: (dir) => ipcRenderer.invoke("project:addFiles", dir),
  captionStyles: () => ipcRenderer.invoke("captions:list"),
  scriptData: (dir) => ipcRenderer.invoke("script:get", dir),
  setScriptCut: (dir, cut) => ipcRenderer.invoke("script:setCut", dir, cut),
  chatClear: (key) => ipcRenderer.invoke("chat:clear", key),
  chatUndo: (key, at) => ipcRenderer.invoke("chat:undo", key, at),
  brandKits: () => ipcRenderer.invoke("brand:list"),
  brandKitNew: (name, site) => ipcRenderer.invoke("brand:new", name, site),
  brandKitSave: (kit) => ipcRenderer.invoke("brand:save", kit),
  brandKitDelete: (id) => ipcRenderer.invoke("brand:delete", id),
  brandKitAddFiles: (id, kind) => ipcRenderer.invoke("brand:addFiles", id, kind),
  brandKitScan: (id) => ipcRenderer.invoke("brand:scan", id),
  brandKitFileUrl: (id, name) => ipcRenderer.invoke("brand:fileUrl", id, name),
  projectBrandKit: (dir) => ipcRenderer.invoke("brand:forProject", dir),
  setProjectBrandKit: (dir, id) => ipcRenderer.invoke("brand:setForProject", dir, id),
  shareProject: (dir) => ipcRenderer.invoke("share:publish", dir),
  shareLink: (dir) => ipcRenderer.invoke("share:link", dir),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  heygenStatus: () => ipcRenderer.invoke("heygen:status"),
  heygenSignIn: () => ipcRenderer.invoke("heygen:signIn"),
  heygenUseKey: (key) => ipcRenderer.invoke("heygen:useKey", key),
  heygenSignOut: () => ipcRenderer.invoke("heygen:signOut"),
  queue: () => ipcRenderer.invoke("queue:get"),
  cancelJob: (id) => ipcRenderer.invoke("queue:cancel", id),
  retryJob: (id) => ipcRenderer.invoke("queue:retry", id),
  clearFinished: () => ipcRenderer.invoke("queue:clear"),
  setPaused: (paused) => ipcRenderer.invoke("queue:paused", paused),
  chatLoad: (key) => ipcRenderer.invoke("chat:load", key),
  chatSend: (key, text, display, mode) => ipcRenderer.invoke("chat:send", key, text, display, mode),
  chatStop: (key) => ipcRenderer.invoke("chat:stop", key),
  onChatEvent: (handler) => {
    ipcRenderer.on("chat:event", (_e, key: string, event: ChatEvent) => handler(key, event));
  },
  onLibraryChanged: (handler) => {
    ipcRenderer.on("library:changed", () => handler());
  },
  onQueueChanged: (handler) => {
    ipcRenderer.on("queue:changed", (_e, snapshot: QueueSnapshot) => handler(snapshot));
  },
  onPendingChanged: (handler) => {
    ipcRenderer.on("pending:changed", (_e, key: string, edits: PendingEdit[]) =>
      handler(key, edits),
    );
  },
  onBrandKitsChanged: (handler) => {
    ipcRenderer.on("brand:changed", () => handler());
  },
  onCommand: (handler) => {
    ipcRenderer.on("ui:command", (_e, command: UiCommand) => handler(command));
  },
};

contextBridge.exposeInMainWorld("app", api);
