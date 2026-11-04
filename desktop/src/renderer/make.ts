import brand from "../../brand.json";
import { h, icon } from "./dom";
import type { MakeRequest, MakeResult, Orientation } from "../shared/types";

const VIDEO = /\.(mp4|mov|m4v|mkv|webm|avi|mxf)$/i;
type Tab = "make" | "reference" | "script";
type CutName = "Hook" | "Proof" | "Turn" | "CTA";
const CUTS: CutName[] = ["Hook", "Proof", "Turn", "CTA"];

const STORYBOARD =
  "Start with a storyboard: before building, plan every shot using the hyperframes skill's storyboard reference, show each shot as a still with its timing (as markdown images with absolute paths), ask about anything that matters and I didn't say, then wait for my approval.";

const PLACEHOLDERS: Record<Tab, string> = {
  make: "Describe the video. Add a folder of footage and every clip becomes its own project, edited with these instructions.",
  reference: "What should this copy from the reference video? The edit, the motion, the captions?",
  script: "Paste the script.",
};

/** The Make box. Its contents survive leaving Home, so a half-written brief isn't lost. */
const state = {
  tab: "make" as Tab,
  text: "",
  attachments: [] as string[],
  orientation: "portrait" as Orientation,
  folderName: "",
  /** How many of the clips to use. Null means all of them. */
  howMany: null as number | null,
  renderWhenEdited: false,
  exportDir: null as string | null,
  brandKitId: null as string | null,
  storyboard: true,
  /** Clips for the four story beats. */
  cuts: { Hook: null, Proof: null, Turn: null, CTA: null } as Record<CutName, string | null>,
  referenceUrl: "",
  referenceMode: "style" as "style" | "brief",
};

const fileName = (path: string): string => path.split("/").pop() ?? path;

function referencePrompt(names: string[]): string {
  const source = state.referenceUrl.trim()
    ? `The reference video is at ${state.referenceUrl.trim()}. If you can't download it, say so and ask me to upload the file.`
    : `The reference video is assets/${names[0] ?? ""}.`;
  const how =
    state.referenceMode === "style"
      ? "Copy its editing style: its cuts, captions and effects, with my own people, words and footage."
      : "Treat it as a video brief: recreate its motion with my topic and files.";
  return `Use the reverse-any-video skill. ${source} ${how} When it's built, compare it with the original using \`hyperframes diff\` and tell me how close it is.\n\nWhat it's about: ${state.text.trim()}`;
}

function buildPrompt(names: string[]): string {
  const text = state.text.trim();
  if (state.tab === "reference") return referencePrompt(names);
  const parts = [state.tab === "script" ? `Make a video from this script:\n\n${text}` : text];
  const cuts = CUTS.filter((name) => state.cuts[name]);
  if (cuts.length > 0) {
    const list = cuts.map(
      (name, index) => `${index + 1}. ${name}: assets/${fileName(state.cuts[name] ?? "")}`,
    );
    parts.push(`Use my cuts, in this order:\n${list.join("\n")}`);
  }
  if (state.storyboard) parts.push(STORYBOARD);
  return parts.filter(Boolean).join("\n\n");
}

function buildRequest(): MakeRequest {
  const all = state.attachments.filter((path) => VIDEO.test(path));
  const others = state.attachments.filter((path) => !VIDEO.test(path));
  const isReference = state.tab === "reference";
  const usesCuts = !isReference && CUTS.some((name) => state.cuts[name]);
  const cutFiles = CUTS.flatMap((name) => state.cuts[name] ?? []);
  // Clips in the cut slots build one video together, so they don't become their own projects.
  const videos = isReference || usesCuts ? [] : all.slice(0, state.howMany ?? all.length);
  const files = [
    ...(isReference || usesCuts ? state.attachments : others),
    ...(isReference ? [] : cutFiles),
  ];
  return {
    prompt: buildPrompt(files.map(fileName)),
    videos,
    files,
    orientation: state.orientation,
    brandKitId: state.brandKitId,
    folderName: state.folderName.trim() || null,
    renderWhenEdited: state.renderWhenEdited,
    exportDir: state.exportDir,
  };
}

function brandPicker(paint: () => void): HTMLElement {
  const picker = document.createElement("select");
  picker.className = "chat-select";
  picker.setAttribute("aria-label", "Brand kit");
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No brand kit";
  picker.append(none);
  void window.app.brandKits().then((kits) => {
    for (const kit of kits) {
      const option = document.createElement("option");
      option.value = kit.id;
      option.textContent = kit.name;
      picker.append(option);
    }
    picker.value = state.brandKitId ?? "";
  });
  picker.addEventListener("change", () => {
    state.brandKitId = picker.value || null;
    paint();
  });
  return picker;
}

function cutsSection(paint: () => void): HTMLElement {
  const filled = CUTS.filter((name) => state.cuts[name]).length;
  return h(
    "div",
    { class: "cuts" },
    h(
      "div",
      { class: "cuts-head" },
      h("span", {}, h("strong", {}, "Your cuts"), " (optional)"),
      h("span", { class: "count" }, `${filled} of 4 cuts`),
    ),
    h(
      "div",
      { class: "cut-slots" },
      ...CUTS.map((name, index) => {
        const path = state.cuts[name];
        return h(
          "button",
          {
            class: path ? "cut-slot filled" : "cut-slot",
            title: path ?? `Add your ${name} clip`,
            onClick: () => {
              if (path) {
                state.cuts[name] = null;
                paint();
                return;
              }
              void window.app.pickFile().then((chosen) => {
                if (chosen) state.cuts[name] = chosen;
                paint();
              });
            },
          },
          path ? fileName(path) : `${index + 1} ${name}`,
        );
      }),
    ),
  );
}

function referenceSection(paint: () => void): HTMLElement {
  const url = document.createElement("input");
  url.placeholder = "Paste a video link";
  url.value = state.referenceUrl;
  url.setAttribute("aria-label", "Reference video link");
  url.addEventListener("input", () => {
    state.referenceUrl = url.value;
  });
  return h(
    "div",
    { class: "batch" },
    h("div", { class: "batch-row" }, h("span", {}, "Link"), url),
    h(
      "div",
      { class: "batch-row" },
      h("span", {}, "How to remake it"),
      h("span", { class: "spacer" }),
      h(
        "div",
        { class: "pills" },
        ...(
          [
            ["style", "Copy editing style"],
            ["brief", "Video brief"],
          ] as const
        ).map(([value, label]) =>
          h(
            "button",
            {
              class: state.referenceMode === value ? "pill on" : "pill",
              onClick: () => {
                state.referenceMode = value;
                paint();
              },
            },
            label,
          ),
        ),
      ),
    ),
    h(
      "p",
      { class: "batch-note" },
      "Or add the video file below. A file is the sure way: Claude may not be able to download every link.",
    ),
  );
}

export function renderMakeBox(
  defaults: { lastExportDir: string | null },
  onMade: (result: MakeResult) => void,
): HTMLElement {
  state.exportDir ??= defaults.lastExportDir;
  const root = h("div", { class: "make-card" });

  const paint = () => {
    const videos = state.attachments.filter((path) => VIDEO.test(path));
    const batch = state.tab !== "reference" && videos.length > 0;

    const tabs = h(
      "div",
      { class: "tabs", label: "What to start from" },
      ...(["make", "reference", "script"] as const).map((tab) =>
        h(
          "button",
          {
            class: tab === state.tab ? "tab on" : "tab",
            onClick: () => {
              state.tab = tab;
              paint();
            },
          },
          tab === "make" ? "Make" : tab === "reference" ? "Reference" : "Script",
        ),
      ),
    );

    const input = document.createElement("textarea");
    input.value = state.text;
    input.placeholder = PLACEHOLDERS[state.tab];
    input.addEventListener("input", () => {
      state.text = input.value;
      submit.disabled = !canGo();
    });

    const chips = state.attachments.map((path) =>
      h(
        "span",
        { class: "attachment", title: path },
        fileName(path),
        h(
          "button",
          {
            class: "attachment-remove",
            label: `Remove ${fileName(path)}`,
            onClick: () => {
              state.attachments = state.attachments.filter((item) => item !== path);
              paint();
            },
          },
          icon("close", 12),
        ),
      ),
    );

    const add = h(
      "button",
      {
        class: "pill-button",
        onClick: () => {
          void window.app.pickFiles().then((paths) => {
            state.attachments = [...new Set([...state.attachments, ...paths])];
            paint();
          });
        },
      },
      icon("plus", 14),
      "Add",
    );

    const addFolder = h(
      "button",
      {
        class: "pill-button",
        title: "Choose a folder on a card or drive. Every clip in it becomes a project.",
        onClick: () => {
          void window.app.pickVideoFolder().then((folder) => {
            if (!folder) return;
            state.attachments = [...new Set([...state.attachments, ...folder.videos])];
            state.folderName ||= folder.name;
            state.howMany = null;
            paint();
          });
        },
      },
      icon("folder", 14),
      "Add folder",
    );

    const shape = !batch
      ? h(
          "div",
          { class: "pills" },
          ...(["portrait", "landscape"] as const).map((orientation) =>
            h(
              "button",
              {
                class: orientation === state.orientation ? "pill on" : "pill",
                onClick: () => {
                  state.orientation = orientation;
                  paint();
                },
              },
              orientation === "portrait" ? "Vertical" : "Landscape",
            ),
          ),
        )
      : null;

    const editor = h(
      "div",
      { class: "make-input" },
      input,
      chips.length > 0 ? h("div", { class: "attachments" }, ...chips) : null,
      h(
        "div",
        { class: "make-row" },
        add,
        addFolder,
        brandPicker(paint),
        h("span", { class: "spacer" }),
        shape,
      ),
    );
    editor.addEventListener("dragover", (event) => {
      event.preventDefault();
      editor.classList.add("dropping");
    });
    editor.addEventListener("dragleave", () => editor.classList.remove("dropping"));
    editor.addEventListener("drop", (event) => {
      event.preventDefault();
      const dropped = [...(event.dataTransfer?.files ?? [])]
        .map((file) => window.app.pathForFile(file))
        .filter(Boolean);
      void Promise.all(
        dropped.map(async (path) => {
          if (/\.[a-z0-9]{2,5}$/i.test(path)) return [path];
          const folder = await window.app.scanVideoFolder(path).catch(() => null);
          if (folder) state.folderName ||= folder.name;
          return folder?.videos ?? [];
        }),
      ).then((groups) => {
        state.attachments = [...new Set([...state.attachments, ...groups.flat()])];
        paint();
      });
    });

    const canGo = () => state.text.trim().length > 0 || (batch && videos.length > 0);
    const error = h("p", { class: "make-error" });
    error.setAttribute("role", "alert");
    const using = Math.min(state.howMany ?? videos.length, videos.length);
    const submit = h("button", { class: "go" }, batchLabel(batch, using));
    submit.disabled = !canGo();
    submit.addEventListener("click", () => {
      submit.disabled = true;
      submit.textContent = "Setting up";
      error.textContent = "";
      window.app
        .make(buildRequest())
        .then((result) => {
          state.text = "";
          state.attachments = [];
          state.folderName = "";
          state.howMany = null;
          onMade(result);
        })
        .catch((failure: unknown) => {
          error.textContent = failure instanceof Error ? failure.message : String(failure);
          submit.disabled = false;
          submit.textContent = batchLabel(batch, using);
        });
    });

    root.replaceChildren(
      ...[
        tabs,
        state.tab === "reference" ? referenceSection(paint) : null,
        editor,
        batch ? batchOptions(videos.length, paint) : null,
        !batch && state.tab !== "reference" ? cutsSection(paint) : null,
        !batch ? storyboardToggle(paint) : null,
        submit,
        error,
      ].filter((part): part is HTMLElement => part !== null),
    );
    input.focus();
  };

  paint();
  return root;
}

function storyboardToggle(paint: () => void): HTMLElement {
  const box = document.createElement("input");
  box.type = "checkbox";
  box.checked = state.storyboard;
  box.addEventListener("change", () => {
    state.storyboard = box.checked;
    paint();
  });
  return h("label", { class: "batch-row toggle" }, box, h("span", {}, "Start with a storyboard"));
}

function batchLabel(batch: boolean, count: number): string {
  if (!batch) return "Let's go";
  return count === 1 ? "Start 1 project" : `Start ${count} projects`;
}

function batchOptions(count: number, paint: () => void): HTMLElement {
  const folder = document.createElement("input");
  folder.placeholder = count === 1 ? "No folder" : `${count} videos`;
  folder.value = state.folderName;
  folder.setAttribute("aria-label", "Folder name");
  folder.addEventListener("input", () => {
    state.folderName = folder.value;
  });

  const howMany = document.createElement("input");
  howMany.type = "number";
  howMany.min = "1";
  howMany.max = String(count);
  howMany.value = String(Math.min(state.howMany ?? count, count));
  howMany.className = "how-many";
  howMany.setAttribute("aria-label", "How many videos");
  howMany.addEventListener("change", () => {
    const value = Math.round(Number(howMany.value));
    state.howMany = value >= 1 && value < count ? value : null;
    paint();
  });

  const render = document.createElement("input");
  render.type = "checkbox";
  render.checked = state.renderWhenEdited;
  render.addEventListener("change", () => {
    state.renderWhenEdited = render.checked;
    paint();
  });

  const choose = h(
    "button",
    {
      class: "ghost path",
      title: state.exportDir ?? "",
      onClick: () => {
        void window.app.pickFolder().then((dir) => {
          if (dir) state.exportDir = dir;
          paint();
        });
      },
    },
    state.exportDir
      ? (state.exportDir.split("/").pop() ?? state.exportDir)
      : "Each project's folder",
  );

  return h(
    "div",
    { class: "batch" },
    h(
      "div",
      { class: "batch-row" },
      h("span", {}, "How many videos"),
      h("span", { class: "spacer" }),
      howMany,
      h("span", { class: "count" }, `of ${count}`),
    ),
    h("div", { class: "batch-row" }, h("span", {}, "Folder"), folder),
    h(
      "label",
      { class: "batch-row" },
      h("span", {}, "Also export each one as soon as it's edited"),
      h("span", { class: "spacer" }),
      render,
    ),
    state.renderWhenEdited
      ? h(
          "div",
          { class: "batch-row" },
          h("span", {}, "Save to"),
          h("span", { class: "spacer" }),
          choose,
        )
      : null,
    h(
      "p",
      { class: "batch-note" },
      state.renderWhenEdited
        ? `${brand.name} imports them all, then edits and exports one at a time.`
        : `${brand.name} imports them all, then edits one at a time. They wait for you after that. Add the good ones to the export queue when you're ready.`,
    ),
  );
}
