import { h } from "./dom";
import type { ExportOptions } from "../shared/types";

const FRAME_RATES = [24, 25, 30, 50, 60];

function choice<T extends string | number>(
  label: string,
  options: { value: T; label: string }[],
  current: T,
  onChange: (value: T) => void,
): HTMLElement {
  const row = h("div", { class: "pills", label });
  const paint = (selected: T) => {
    row.replaceChildren(
      ...options.map((option) =>
        h(
          "button",
          {
            class: option.value === selected ? "pill on" : "pill",
            onClick: (event) => {
              event.preventDefault();
              onChange(option.value);
              paint(option.value);
            },
          },
          option.label,
        ),
      ),
    );
  };
  paint(current);
  return h(
    "div",
    { class: "export-row" },
    h("span", {}, label),
    h("span", { class: "spacer" }),
    row,
  );
}

const buttonLabel = (options: ExportOptions, count: number): string => {
  const size = options.quality === "project" ? "project size" : options.quality;
  const what = `${size} ${options.format.toUpperCase()}`;
  const verb = options.on === "cloud" ? "Render in the cloud:" : "Export";
  return count > 1 ? `${verb} ${count} videos, ${what}` : `${verb} ${what}`;
};

/** Export's choices. Everything it starts goes through the queue, one video at a time. */
export async function openExportPanel(dirs: string[]): Promise<void> {
  if (dirs.length === 0) return;
  const [settings, library, heygen] = await Promise.all([
    window.app.settings(),
    window.app.library(),
    window.app.heygenStatus(),
  ]);
  const options: ExportOptions = { ...settings.exportOptions };
  const folder = library.folders.find((item) => dirs.every((dir) => item.paths.includes(dir)));
  let exportDir = folder?.exportDir ?? library.lastExportDir;

  const dialog = document.createElement("dialog");
  dialog.className = "ask export-panel";
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const go = h("button", { class: "primary" }, buttonLabel(options, dirs.length));
  const refresh = () => {
    go.textContent = buttonLabel(options, dirs.length);
  };
  const saveTo = h("button", { class: "ghost path", title: exportDir ?? "" });
  const paintSave = () => {
    saveTo.textContent = exportDir ? (exportDir.split("/").pop() ?? exportDir) : "Choose a folder";
    saveTo.title = exportDir ?? "";
  };
  paintSave();
  saveTo.addEventListener("click", (event) => {
    event.preventDefault();
    void window.app.pickFolder().then((chosen) => {
      if (chosen) exportDir = chosen;
      paintSave();
    });
  });
  go.addEventListener("click", (event) => {
    event.preventDefault();
    close();
    void window.app.startExport({ dirs, options, exportDir });
  });
  const cancel = h(
    "button",
    {
      class: "ghost",
      onClick: (event) => {
        event.preventDefault();
        close();
      },
    },
    "Cancel",
  );

  dialog.append(
    h("h3", { class: "export-title" }, dirs.length > 1 ? `Export ${dirs.length} videos` : "Export"),
    choice(
      "Quality",
      [
        { value: "1080p", label: "1080p" },
        { value: "project", label: "Project size" },
        { value: "4k", label: "4K" },
      ],
      options.quality,
      (value) => {
        options.quality = value;
        refresh();
      },
    ),
    choice(
      "Format",
      [
        { value: "mp4", label: "MP4" },
        { value: "webm", label: "WebM" },
        { value: "mov", label: "MOV" },
      ],
      options.format,
      (value) => {
        options.format = value;
        refresh();
      },
    ),
    choice(
      "Frame rate",
      FRAME_RATES.map((value) => ({ value, label: String(value) })),
      options.fps,
      (value) => {
        options.fps = value;
      },
    ),
    choice(
      "Render on",
      [
        { value: "mac", label: "This Mac" },
        { value: "cloud", label: "Cloud" },
      ],
      options.on,
      (value) => {
        options.on = value;
        refresh();
      },
    ),
    h(
      "p",
      { class: "export-note" },
      heygen.signedIn
        ? "The cloud is paid from your HeyGen balance and uploads the project. This Mac is free."
        : "The cloud needs a HeyGen account: connect it in Settings. This Mac is free.",
    ),
    h(
      "div",
      { class: "export-row" },
      h("span", {}, "Save to"),
      h("span", { class: "spacer" }),
      saveTo,
    ),
    h("div", { class: "ask-row" }, cancel, go),
  );
  document.body.append(dialog);
  dialog.showModal();
}
