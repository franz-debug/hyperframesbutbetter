// Marks made on the picture or the script wait here until the person sends them together.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { chatSend } from "./chat";
import type { PendingEdit } from "../shared/types";

const file = (): string => join(app.getPath("userData"), "pending.json");
let store: Record<string, PendingEdit[]> | null = null;

function load(): Record<string, PendingEdit[]> {
  if (store) return store;
  try {
    store = JSON.parse(readFileSync(file(), "utf8")) as Record<string, PendingEdit[]>;
  } catch {
    store = {};
  }
  return store;
}

function changed(key: string): void {
  writeFileSync(file(), JSON.stringify(load()));
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send("pending:changed", key, load()[key] ?? []);
  }
}

export const pendingList = (key: string): PendingEdit[] => load()[key] ?? [];

export function pendingAdd(key: string, edit: Omit<PendingEdit, "id">): void {
  const id = `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  load()[key] = [...pendingList(key), { ...edit, id }];
  changed(key);
}

export function pendingUpdate(key: string, id: string, note: string): void {
  load()[key] = pendingList(key).map((edit) => (edit.id === id ? { ...edit, note } : edit));
  changed(key);
}

export function pendingRemove(key: string, id: string): void {
  load()[key] = pendingList(key).filter((edit) => edit.id !== id);
  changed(key);
}

/** One request for everything waiting, with a note that applies to all of it. */
export function pendingSend(key: string, note: string): void {
  const edits = pendingList(key);
  if (edits.length === 0) return;
  const lines = edits.map((edit, index) => `${index + 1}. ${edit.note}\n${edit.detail}`.trim());
  const intro =
    edits.length === 1 ? "Make this edit:" : `Make these ${edits.length} edits together:`;
  const text = [intro, ...lines, note ? `For all of them: ${note}` : ""]
    .filter(Boolean)
    .join("\n\n");
  const display = [
    edits.length === 1 ? (edits[0]?.note ?? "") : edits.map((edit) => `• ${edit.note}`).join("\n"),
    note,
  ]
    .filter(Boolean)
    .join("\n\n");
  load()[key] = [];
  changed(key);
  void chatSend(key, text, display, "queue");
}
