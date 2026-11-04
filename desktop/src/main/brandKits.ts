// Brand kits live in the app's data folder. A project gets its own copy of the kit's files,
// so it still renders the same if the kit changes later.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { projectKitId } from "./library";
import type { BrandKit } from "../shared/types";

const root = (): string => join(app.getPath("userData"), "brand-kits");
export const brandKitDir = (id: string): string => join(root(), id);
const kitFile = (id: string): string => join(brandKitDir(id), "kit.json");

function changed(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("brand:changed");
  }
}

export const brandKitsChanged = changed;

export function readKit(id: string): BrandKit | null {
  try {
    const stored = JSON.parse(readFileSync(kitFile(id), "utf8")) as Partial<BrandKit>;
    return {
      id,
      name: stored.name ?? "Brand kit",
      site: stored.site ?? "",
      colors: stored.colors ?? [],
      logos: stored.logos ?? [],
      fonts: stored.fonts ?? [],
      files: stored.files ?? [],
      textStyles: stored.textStyles ?? "",
      rules: stored.rules ?? "",
    };
  } catch {
    return null;
  }
}

export function listKits(): BrandKit[] {
  if (!existsSync(root())) return [];
  return readdirSync(root())
    .map(readKit)
    .filter((kit): kit is BrandKit => kit !== null);
}

export function saveKit(kit: BrandKit): void {
  mkdirSync(brandKitDir(kit.id), { recursive: true });
  writeFileSync(kitFile(kit.id), JSON.stringify(kit, null, 2));
  changed();
}

export function newKit(name: string, site: string): BrandKit {
  const id = `kit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const kit: BrandKit = {
    id,
    name: name.trim() || "New brand kit",
    site: site.trim(),
    colors: [],
    logos: [],
    fonts: [],
    files: [],
    textStyles: "",
    rules: "",
  };
  saveKit(kit);
  return kit;
}

export function deleteKit(id: string): void {
  rmSync(brandKitDir(id), { recursive: true, force: true });
  changed();
}

export function addKitFiles(
  id: string,
  kind: "logos" | "fonts" | "files",
  paths: string[],
): BrandKit | null {
  const kit = readKit(id);
  if (!kit) return null;
  for (const path of paths) {
    const name = basename(path);
    copyFileSync(path, join(brandKitDir(id), name));
    if (!kit[kind].includes(name)) kit[kind].push(name);
  }
  saveKit(kit);
  return kit;
}

function kitMarkdown(kit: BrandKit): string {
  const list = (items: string[]) => items.map((item) => `- ${item}`).join("\n") || "- none";
  return `# ${kit.name}

The brand for this project. The main logo leads titles and end cards; the colors and text styles set the look.

## Colors
${kit.colors.map((color) => `- ${color.role}: ${color.value}`).join("\n") || "- none"}

## Logos (the first is the main logo)
${list(kit.logos)}

## Fonts
${list(kit.fonts)}

## Other files
${list(kit.files)}

## Text styles
${kit.textStyles || "None set."}

## Rules
${kit.rules || "None set."}
`;
}

/** Puts the kit's files in the project, where the render can always find them. */
export function applyKitToProject(id: string, dir: string): void {
  const kit = readKit(id);
  if (!kit) return;
  const target = join(dir, "assets", "brand-kit");
  mkdirSync(target, { recursive: true });
  for (const name of [...kit.logos, ...kit.fonts, ...kit.files]) {
    const source = join(brandKitDir(id), name);
    if (existsSync(source)) copyFileSync(source, join(target, name));
  }
  writeFileSync(join(target, "brand.md"), kitMarkdown(kit));
}

export function brandKitPrompt(dir: string): string {
  const id = projectKitId(dir);
  const kit = id ? readKit(id) : null;
  if (!kit) return "";
  applyKitToProject(kit.id, dir);
  return `\n- This project uses the "${kit.name}" brand kit. Read assets/brand-kit/brand.md before designing anything, and use its logos, colors and fonts from assets/brand-kit.`;
}
