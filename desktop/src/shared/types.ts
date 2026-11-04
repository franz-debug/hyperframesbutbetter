export interface ProjectSummary {
  dir: string;
  name: string;
  createdAt: number;
  modifiedAt: number;
  thumbUrl: string | null;
  renderCount: number;
  pinned: boolean;
  archived: boolean;
  folderId: string | null;
}

export interface Folder {
  id: string;
  name: string;
  paths: string[];
  exportDir: string | null;
  open: boolean;
  createdAt: number;
}

export interface LibrarySnapshot {
  projects: ProjectSummary[];
  folders: Folder[];
  lastExportDir: string | null;
}

export type Orientation = "portrait" | "landscape";

export type JobKind = "import" | "edit" | "render";
export type JobStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** The project's name, or the source file's until it has been imported. */
  title: string;
  dir: string | null;
  /** Runs only once this job is done; it is skipped if that one fails. */
  after: string | null;
  sourcePath: string | null;
  instruction: string | null;
  /** The folder a render's video is saved in, under a dated name. */
  exportDir: string | null;
  /** The exact file a render is saved as. */
  outputPath: string | null;
  folderId: string | null;
  batchSize: number;
  /** How a render is made. Null uses the project's own size and frame rate. */
  options: ExportOptions | null;
  /** The brand kit a project gets once it has been imported. */
  brandKitId: string | null;
  progress: number;
  stage: string;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type JobInput = Pick<Job, "kind" | "title"> &
  Partial<
    Pick<
      Job,
      | "dir"
      | "after"
      | "sourcePath"
      | "instruction"
      | "exportDir"
      | "outputPath"
      | "folderId"
      | "batchSize"
      | "options"
      | "brandKitId"
    >
  >;

export interface ExportOptions {
  quality: "1080p" | "project" | "4k";
  format: "mp4" | "webm" | "mov";
  fps: number;
  on: "mac" | "cloud";
}

export interface ExportRequest {
  dirs: string[];
  options: ExportOptions;
  /** Where the videos are saved. Null asks. */
  exportDir: string | null;
}

export interface Settings {
  model: string;
  effort: string;
  access: "auto" | "full";
  /** What Enter does while Claude is working. */
  whileBusy: "steer" | "queue";
  exportOptions: ExportOptions;
}

export interface PendingEdit {
  id: string;
  kind: "select" | "draw" | "comment" | "script";
  /** The person's words, shown in the list. */
  note: string;
  /** What Claude also needs: where, when, and which frame. */
  detail: string;
}

export interface BrandKit {
  id: string;
  name: string;
  site: string;
  colors: { role: string; value: string }[];
  /** File names inside the kit's folder. The first logo is the main one. */
  logos: string[];
  fonts: string[];
  files: string[];
  textStyles: string;
  rules: string;
}

export interface MenuData {
  files: { label: string; path: string }[];
  projects: { label: string; path: string }[];
  captions: CaptionStyle[];
  skills: string[];
}

export interface CaptionStyle {
  name: string;
  title: string;
  description: string;
  preview: string | null;
}

export interface ScriptWord {
  text: string;
  start: number;
  end: number;
}

export interface ScriptData {
  words: ScriptWord[];
  /** Indexes of words already sent to be cut. */
  cut: number[];
}

export interface HeygenStatus {
  signedIn: boolean;
  detail: string;
}

export type MemoryPressure = "normal" | "warning" | "critical";

export interface QueueSnapshot {
  jobs: Job[];
  paused: boolean;
  pauseReason: string | null;
  waitingForMemory: boolean;
  memory: { pressure: MemoryPressure; usedPercent: number };
}

export type ChatItem =
  | { kind: "user" | "assistant" | "note" | "error"; text: string }
  /** Where a finished run can be undone back to. */
  | { kind: "run-end"; at: string }
  | { kind: "tool"; id: string; summary: string; failed?: boolean };

export type ChatEvent =
  | { kind: "state"; running: boolean }
  | { kind: "append"; item: ChatItem }
  | { kind: "delta"; text: string }
  | { kind: "tool-result"; id: string; failed: boolean };

export interface ChatSnapshot {
  items: ChatItem[];
  running: boolean;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MakeRequest {
  prompt: string;
  /** Video files: each becomes its own project. */
  videos: string[];
  /** Any other files: copied into a new project's assets folder. */
  files: string[];
  orientation: Orientation;
  brandKitId: string | null;
  folderName: string | null;
  renderWhenEdited: boolean;
  exportDir: string | null;
}

/** A folder of footage on a card or drive: its video files, in name order. */
export interface VideoFolder {
  name: string;
  videos: string[];
}

export type MakeResult =
  | { kind: "project"; dir: string }
  | { kind: "batch"; folderId: string | null };

export type UiCommand =
  | { kind: "go-home" }
  | { kind: "go-queue" }
  | { kind: "go-change" }
  | { kind: "toggle-chat" }
  | { kind: "show-chat" }
  | { kind: "export-panel"; dirs: string[] }
  | { kind: "open-project"; dir: string }
  | { kind: "new-folder"; dirs: string[] }
  | { kind: "rename-folder"; id: string; name: string };

export interface AppApi {
  appName(): Promise<string>;
  library(): Promise<LibrarySnapshot>;
  make(request: MakeRequest): Promise<MakeResult>;
  pickFiles(): Promise<string[]>;
  pickFolder(): Promise<string | null>;
  pickVideoFolder(): Promise<VideoFolder | null>;
  scanVideoFolder(path: string): Promise<VideoFolder>;
  pathForFile(file: File): string;
  importProjects(): Promise<void>;
  projectMenu(dir: string): Promise<void>;
  folderMenu(id: string): Promise<void>;
  newFolder(name: string, dirs: string[]): Promise<string>;
  renameFolder(id: string, name: string): Promise<void>;
  setFolderOpen(id: string, open: boolean): Promise<void>;
  setFolderExportDir(id: string): Promise<void>;
  moveToFolder(dir: string, folderId: string | null): Promise<void>;
  showInFinder(path: string): Promise<void>;
  openEditor(dir: string): Promise<void>;
  hideEditor(): Promise<void>;
  setEditorBounds(bounds: Bounds): Promise<void>;
  startExport(request: ExportRequest): Promise<void>;
  openFile(path: string): Promise<void>;
  pickFile(): Promise<string | null>;
  settings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  pendingList(key: string): Promise<PendingEdit[]>;
  pendingAdd(key: string, edit: Omit<PendingEdit, "id">): Promise<void>;
  pendingUpdate(key: string, id: string, note: string): Promise<void>;
  pendingRemove(key: string, id: string): Promise<void>;
  pendingSend(key: string, note: string): Promise<void>;
  menuData(key: string): Promise<MenuData>;
  addFilesToProject(dir: string): Promise<{ label: string; path: string }[]>;
  captionStyles(): Promise<CaptionStyle[]>;
  scriptData(dir: string): Promise<ScriptData>;
  setScriptCut(dir: string, cut: number[]): Promise<void>;
  chatClear(key: string): Promise<void>;
  chatUndo(key: string, at: string): Promise<string>;
  brandKits(): Promise<BrandKit[]>;
  brandKitNew(name: string, site: string): Promise<BrandKit>;
  brandKitSave(kit: BrandKit): Promise<void>;
  brandKitDelete(id: string): Promise<void>;
  brandKitAddFiles(id: string, kind: "logos" | "fonts" | "files"): Promise<BrandKit | null>;
  brandKitScan(id: string): Promise<void>;
  brandKitFileUrl(id: string, name: string): Promise<string>;
  projectBrandKit(dir: string): Promise<string | null>;
  setProjectBrandKit(dir: string, id: string | null): Promise<void>;
  shareProject(dir: string): Promise<string>;
  shareLink(dir: string): Promise<string | null>;
  copyText(text: string): Promise<void>;
  heygenStatus(): Promise<HeygenStatus>;
  heygenSignIn(): Promise<HeygenStatus>;
  heygenUseKey(key: string): Promise<HeygenStatus>;
  heygenSignOut(): Promise<HeygenStatus>;
  queue(): Promise<QueueSnapshot>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<void>;
  clearFinished(): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  chatLoad(key: string): Promise<ChatSnapshot>;
  chatSend(key: string, text: string, display?: string, mode?: "steer" | "queue"): Promise<void>;
  chatStop(key: string): Promise<void>;
  onChatEvent(handler: (key: string, event: ChatEvent) => void): void;
  onLibraryChanged(handler: () => void): void;
  onQueueChanged(handler: (snapshot: QueueSnapshot) => void): void;
  onCommand(handler: (command: UiCommand) => void): void;
  onPendingChanged(handler: (key: string, edits: PendingEdit[]) => void): void;
  onBrandKitsChanged(handler: () => void): void;
}

declare global {
  interface Window {
    app: AppApi;
  }
}
