// The app's own organization: folders, pins and archive, kept apart from the project files.
// Removing or archiving here only changes this list. It never deletes a video.
import { existsSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve, sep } from "node:path";
import { app } from "electron";
import { projectsRoot } from "./brand";
import type { Folder, LibrarySnapshot, ProjectSummary } from "../shared/types";

interface LibraryFile {
  folders: Folder[];
  pinned: string[];
  archived: string[];
  extraDirs: string[];
  lastExportDir: string | null;
  projectKits: Record<string, string>;
  defaultKit: string | null;
  shares: Record<string, string>;
}

const MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".mp4", ".webm", ".mov"]);
const file = (): string => join(app.getPath("userData"), "library.json");

let data: LibraryFile | null = null;

function load(): LibraryFile {
  if (data) return data;
  const empty: LibraryFile = {
    folders: [],
    pinned: [],
    archived: [],
    extraDirs: [],
    lastExportDir: null,
    projectKits: {},
    defaultKit: null,
    shares: {},
  };
  try {
    const stored = JSON.parse(readFileSync(file(), "utf8")) as Partial<LibraryFile>;
    data = { ...empty, ...stored };
  } catch {
    data = empty;
  }
  return data;
}

function save(): void {
  writeFileSync(file(), JSON.stringify(load(), null, 2));
}

export function mediaUrl(path: string): string {
  return `bf-media://file/${encodeURIComponent(path)}`;
}

/** A media request may only read picture and video files inside a known project. */
export function resolveMediaPath(url: string): string | null {
  const path = resolve(decodeURIComponent(new URL(url).pathname.slice(1)));
  if (!MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return null;
  const roots = [projectsRoot(), ...load().extraDirs, join(app.getPath("userData"), "brand-kits")];
  return roots.some((root) => path.startsWith(root + sep)) ? path : null;
}

async function pickThumbnail(dir: string): Promise<string | null> {
  const folder = join(dir, ".thumbnails");
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  const pictures = names.filter((name) => /\.(jpe?g|png|webp)$/i.test(name));
  if (pictures.length === 0) return null;
  // Prefer a frame of the main composition from a few seconds in, past any fade from black.
  const main = pictures.filter((name) => name.includes("_source_index.html_"));
  const pool = main.length > 0 ? main : pictures;
  const best = pool.find((name) => /_3\.00\.[a-z]+$/i.test(name)) ?? pool[pool.length - 1];
  return best ? join(folder, best) : null;
}

async function readMeta(dir: string): Promise<{ name: string; createdAt: number | null }> {
  try {
    const meta = JSON.parse(await fs.readFile(join(dir, "meta.json"), "utf8")) as {
      name?: unknown;
      createdAt?: unknown;
    };
    return {
      // A project the app never named says "Untitled"; its folder name says more.
      name:
        typeof meta.name === "string" && meta.name && meta.name !== "Untitled"
          ? meta.name
          : basename(dir),
      createdAt: typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : null,
    };
  } catch {
    return { name: basename(dir), createdAt: null };
  }
}

async function countRenders(dir: string): Promise<number> {
  const names = await fs.readdir(join(dir, "renders")).catch(() => [] as string[]);
  return names.filter((name) => /\.(mp4|webm|mov)$/i.test(name)).length;
}

async function summarize(dir: string): Promise<ProjectSummary | null> {
  const entry = await fs.stat(join(dir, "index.html")).catch(() => null);
  if (!entry) return null;
  const lib = load();
  const [{ name, createdAt }, thumb, renderCount, folder] = await Promise.all([
    readMeta(dir),
    pickThumbnail(dir),
    countRenders(dir),
    fs.stat(dir),
  ]);
  return {
    dir,
    name,
    createdAt: createdAt ?? folder.birthtimeMs,
    modifiedAt: Math.max(entry.mtimeMs, folder.mtimeMs),
    thumbUrl: thumb ? mediaUrl(thumb) : null,
    renderCount,
    pinned: lib.pinned.includes(dir),
    archived: lib.archived.includes(dir),
    folderId: lib.folders.find((item) => item.paths.includes(dir))?.id ?? null,
  };
}

export async function librarySnapshot(): Promise<LibrarySnapshot> {
  const lib = load();
  const root = projectsRoot();
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(root, entry.name));
  const all = [...new Set([...dirs, ...lib.extraDirs])];
  const projects = (await Promise.all(all.map(summarize)))
    .filter((item): item is ProjectSummary => item !== null)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
  return { projects, folders: lib.folders, lastExportDir: lib.lastExportDir };
}

/** The name to show and to save a video under: the project's own name, safe for a file. */
export function projectDisplayName(dir: string): string {
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { name?: unknown };
    if (typeof meta.name === "string" && meta.name && meta.name !== "Untitled") {
      return meta.name.replace(/[/\\:]/g, "-");
    }
  } catch {
    /* falls back to the folder */
  }
  return basename(dir);
}

export const findFolder = (id: string): Folder | undefined =>
  load().folders.find((folder) => folder.id === id);

export const foldersList = (): Folder[] => load().folders;
export const isPinned = (dir: string): boolean => load().pinned.includes(dir);
export const isArchived = (dir: string): boolean => load().archived.includes(dir);
export const lastExportDir = (): string | null => load().lastExportDir;

export function isKnownProject(dir: string): boolean {
  if (!existsSync(join(dir, "index.html"))) return false;
  return dir.startsWith(projectsRoot() + sep) || load().extraDirs.includes(dir);
}

export function rememberExportDir(dir: string): void {
  load().lastExportDir = dir;
  save();
}

export function addProjectDir(dir: string): void {
  const lib = load();
  if (!dir.startsWith(projectsRoot() + sep) && !lib.extraDirs.includes(dir)) {
    lib.extraDirs.push(dir);
    save();
  }
}

export function setPinned(dir: string, pinned: boolean): void {
  const lib = load();
  lib.pinned = lib.pinned.filter((item) => item !== dir);
  if (pinned) lib.pinned.push(dir);
  save();
}

export function setArchived(dir: string, archived: boolean): void {
  const lib = load();
  lib.archived = lib.archived.filter((item) => item !== dir);
  if (archived) lib.archived.push(dir);
  save();
}

export function createFolder(
  name: string,
  dirs: string[] = [],
  exportDir: string | null = null,
): Folder {
  const lib = load();
  const folder: Folder = {
    id: `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "New folder",
    paths: [],
    exportDir,
    open: true,
    createdAt: Date.now(),
  };
  lib.folders.push(folder);
  for (const dir of dirs) moveToFolder(dir, folder.id);
  save();
  return folder;
}

export function renameFolder(id: string, name: string): void {
  const folder = findFolder(id);
  if (folder && name.trim()) {
    folder.name = name.trim();
    save();
  }
}

export function setFolderOpen(id: string, open: boolean): void {
  const folder = findFolder(id);
  if (folder) {
    folder.open = open;
    save();
  }
}

export function setFolderExportDir(id: string, exportDir: string): void {
  const folder = findFolder(id);
  if (folder) {
    folder.exportDir = exportDir;
    load().lastExportDir = exportDir;
    save();
  }
}

/** A project lives in one folder at most. A null folder takes it out of whichever it's in. */
export function moveToFolder(dir: string, folderId: string | null): void {
  const lib = load();
  for (const folder of lib.folders) folder.paths = folder.paths.filter((item) => item !== dir);
  const target = folderId ? lib.folders.find((folder) => folder.id === folderId) : null;
  target?.paths.push(dir);
  save();
}

export function removeFolder(id: string): void {
  const lib = load();
  lib.folders = lib.folders.filter((folder) => folder.id !== id);
  save();
}

export const projectKitId = (dir: string): string | null =>
  load().projectKits[dir] ?? load().defaultKit;

export function setProjectKitId(dir: string, id: string | null): void {
  const lib = load();
  if (id) lib.projectKits[dir] = id;
  else delete lib.projectKits[dir];
  save();
}

export const shareLinkFor = (dir: string): string | null => load().shares[dir] ?? null;

export function rememberShareLink(dir: string, url: string): void {
  load().shares[dir] = url;
  save();
}
