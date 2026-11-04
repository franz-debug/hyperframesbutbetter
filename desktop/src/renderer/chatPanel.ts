import { h, icon } from "./dom";
import { renderMarkdown } from "./markdown";
import type { ChatEvent, ChatItem, MenuData, PendingEdit, Settings } from "../shared/types";

const MODELS = [
  { value: "default", label: "Default model" },
  { value: "opus", label: "Opus" },
  { value: "fable", label: "Fable" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

const TOOLS: { label: string; text: string }[] = [
  {
    label: "Storyboard",
    text: "Start with a storyboard: before building, plan every shot using the hyperframes skill's storyboard reference, show each shot as a still with its timing (as markdown images with absolute paths), then wait for my approval.",
  },
  {
    label: "Brand kit",
    text: "Use this project's brand kit: read assets/brand-kit/brand.md and use its files.",
  },
  { label: "Remove background", text: "Use `hyperframes remove-background` for this." },
  {
    label: "Reference video",
    text: "Use the reverse-any-video skill to follow the reference, then compare the result with `hyperframes diff`.",
  },
  { label: "Create assets", text: "Use the media-use skill to make the assets this needs." },
  {
    label: "HeyGen Voice 1",
    text: "Use the media-use skill to make this voiceover with a HeyGen voice.",
  },
  {
    label: "HeyGen Video 1",
    text: "Use the media-use skill to generate this clip with HeyGen Video.",
  },
];

interface Chip {
  label: string;
  text: string;
}

interface MenuEntry {
  group?: string;
  label: string;
  hint?: string;
  run: () => void;
}

interface ChatOptions {
  placeholder: string;
  intro?: string;
  /** The folder relative paths in replies and pictures are read from. */
  baseDir?: string | null;
  /** Whether marks on the picture and script line up above the message box. */
  pendingEdits?: boolean;
}

/** A chat bound to one key: a project, a folder's Director, or the app itself. */
export class ChatPanel {
  readonly element: HTMLElement;
  private readonly messages = h("div", { class: "messages" });
  private readonly input = document.createElement("textarea");
  private readonly status = h("span", { class: "status" });
  private readonly stop = h("button", { class: "ghost", hidden: true }, "Stop");
  private readonly sendButton = h("button", { class: "primary" }, "Send");
  private readonly chipRow = h("div", { class: "chips", hidden: true });
  private readonly menu = h("div", { class: "composer-menu", hidden: true });
  private readonly pendingBox = h("div", { class: "pending", hidden: true });
  private readonly model = document.createElement("select");
  private readonly effort = document.createElement("select");
  private running = false;
  private chips: Chip[] = [];
  private settings: Settings | null = null;
  private menuData: MenuData | null = null;
  private menuEntries: MenuEntry[] = [];
  private menuIndex = 0;
  /** The reply still streaming in, and its text so far. */
  private live: { element: HTMLElement; text: string } | null = null;
  private readonly toolRows = new Map<string, HTMLElement>();
  private pendingNote = "";

  constructor(
    private readonly key: string,
    private readonly options: ChatOptions,
  ) {
    this.input.rows = 2;
    this.input.placeholder = options.placeholder;
    this.messages.setAttribute("aria-live", "polite");
    const header = h("div", { class: "chat-head" }, this.model, this.effort);
    const form = h(
      "form",
      { class: "composer" },
      this.menu,
      this.chipRow,
      this.input,
      h(
        "div",
        { class: "composer-row" },
        h(
          "button",
          {
            class: "icon-button",
            label: "Add files or tools",
            title: "Add files or tools (@, #, /)",
            onClick: (event) => {
              event.preventDefault();
              this.input.value += this.input.value && !this.input.value.endsWith(" ") ? " @" : "@";
              this.input.focus();
              void this.updateMenu();
            },
          },
          icon("plus", 15),
        ),
        this.status,
        h("span", { class: "spacer" }),
        this.stop,
        this.sendButton,
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.send();
    });
    this.input.addEventListener("input", () => void this.updateMenu());
    this.input.addEventListener("keydown", (event) => this.onKey(event));
    this.stop.type = "button";
    this.stop.addEventListener("click", () => void window.app.chatStop(this.key));
    for (const [select, values, setting] of [
      [this.model, MODELS, "model"],
      [
        this.effort,
        EFFORTS.map((value) => ({ value, label: value === "default" ? "Default effort" : value })),
        "effort",
      ],
    ] as const) {
      select.className = "chat-select";
      select.setAttribute("aria-label", setting);
      for (const item of values) {
        const option = document.createElement("option");
        option.value = item.value;
        option.textContent = item.label;
        select.append(option);
      }
      select.addEventListener("change", () => {
        void window.app.updateSettings({ [setting]: select.value });
      });
    }
    this.element = h("aside", { class: "chat" }, header, this.messages, this.pendingBox, form);
    void this.load();
  }

  focus(): void {
    this.input.focus();
  }

  /** Adds something to the next message from outside the box, such as a caption style. */
  addChip(chip: Chip): void {
    this.chips.push(chip);
    this.paintChips();
    this.input.focus();
  }

  handle(key: string, event: ChatEvent): void {
    if (key !== this.key) return;
    if (event.kind === "state") this.setRunning(event.running);
    else if (event.kind === "append") this.addItem(event.item);
    else if (event.kind === "tool-result") {
      this.toolRows.get(event.id)?.classList.toggle("failed", event.failed);
    } else if (this.live) {
      this.live.text += event.text;
      renderMarkdown(this.live.element, this.live.text, this.options.baseDir ?? null);
      this.scrollToEnd();
    }
  }

  handlePending(key: string, edits: PendingEdit[]): void {
    if (key === this.key) this.paintPending(edits);
  }

  private async load(): Promise<void> {
    const [snapshot, settings] = await Promise.all([
      window.app.chatLoad(this.key),
      window.app.settings(),
    ]);
    this.settings = settings;
    this.model.value = settings.model;
    this.effort.value = settings.effort;
    if (snapshot.items.length === 0 && this.options.intro) {
      this.addItem({ kind: "note", text: this.options.intro });
    }
    snapshot.items.forEach((item) => this.addItem(item));
    this.live = null;
    this.setRunning(snapshot.running);
    if (this.options.pendingEdits) this.paintPending(await window.app.pendingList(this.key));
  }

  private onKey(event: KeyboardEvent): void {
    if (!this.menu.hidden) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        const count = this.menuEntries.length;
        this.menuIndex = (this.menuIndex + step + count) % count;
        this.paintMenu();
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        this.menuEntries[this.menuIndex]?.run();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        this.menu.hidden = true;
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const queueIt = event.ctrlKey || event.metaKey;
      const steer = (this.settings?.whileBusy ?? "steer") === "steer";
      this.send(queueIt === steer ? "queue" : "steer");
    }
  }

  private send(mode: "steer" | "queue" = "queue"): void {
    const text = this.input.value.trim();
    if (!text && this.chips.length === 0) return;
    const extra = this.chips.map((chip) => chip.text);
    const full = [text, ...extra].filter(Boolean).join("\n\n");
    const labels = this.chips.map((chip) => chip.label);
    const display = [text, labels.length > 0 ? `[${labels.join(", ")}]` : ""]
      .filter(Boolean)
      .join("\n");
    this.input.value = "";
    this.chips = [];
    this.paintChips();
    this.menu.hidden = true;
    void window.app.chatSend(this.key, full, display, mode);
  }

  private scrollToEnd(): void {
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  private setRunning(running: boolean): void {
    this.running = running;
    this.stop.hidden = !running;
    this.status.textContent = running ? "Claude is working" : "";
    this.status.classList.toggle("busy", running);
    this.sendButton.textContent = running ? "Send now" : "Send";
    this.sendButton.title = running
      ? "Stops the current work and starts on this. ⌃↵ queues it instead."
      : "";
  }

  // ── The @, # and / menus ──

  /** The token being typed, if it starts a menu: "@ca", "#st", "/cl". */
  private menuToken(): { trigger: string; query: string; start: number } | null {
    const end = this.input.selectionStart;
    const before = this.input.value.slice(0, end);
    const match = /(^|\s)([@#/])([^\s]*)$/.exec(before);
    if (!match) return null;
    const trigger = match[2] ?? "";
    const query = match[3] ?? "";
    return { trigger, query: query.toLowerCase(), start: end - query.length - 1 };
  }

  private removeToken(): void {
    const token = this.menuToken();
    if (!token) return;
    const end = this.input.selectionStart;
    this.input.value = this.input.value.slice(0, token.start) + this.input.value.slice(end);
    this.input.selectionStart = this.input.selectionEnd = token.start;
  }

  private pick(chip: Chip): void {
    this.removeToken();
    this.menu.hidden = true;
    this.addChip(chip);
  }

  private entriesFor(trigger: string, query: string, data: MenuData): MenuEntry[] {
    const matches = (label: string) => label.toLowerCase().includes(query);
    if (trigger === "#") {
      return TOOLS.filter((tool) => matches(tool.label)).map((tool) => ({
        label: tool.label,
        run: () => this.pick({ label: `#${tool.label}`, text: tool.text }),
      }));
    }
    if (trigger === "/") {
      const commands: MenuEntry[] = [
        {
          label: "/clear",
          hint: "Start a fresh conversation",
          run: () => {
            this.removeToken();
            this.menu.hidden = true;
            void window.app.chatClear(this.key);
          },
        },
        {
          label: "/compact",
          hint: "Shorten a long conversation",
          run: () => {
            this.removeToken();
            this.menu.hidden = true;
            void window.app.chatSend(this.key, "/compact");
          },
        },
        ...data.skills.map((skill) => ({
          label: `/${skill}`,
          hint: "Use this skill",
          run: () => this.pick({ label: `/${skill}`, text: `Use the ${skill} skill for this.` }),
        })),
      ];
      return commands.filter((entry) => matches(entry.label));
    }
    return [
      ...data.files
        .filter((file) => matches(file.label))
        .map((file) => ({
          group: "Media and files",
          label: file.label,
          run: () =>
            this.pick({
              label: `@${file.label.split("/").pop()}`,
              text: `Use the file ${file.path}.`,
            }),
        })),
      ...data.captions
        .filter((style) => matches(style.title))
        .map((style) => ({
          group: "Captions",
          label: style.title,
          run: () =>
            this.pick({
              label: `@${style.title}`,
              text: `Use the ${style.name} caption style: \`hyperframes add ${style.name}\`.`,
            }),
        })),
      ...data.projects
        .filter((project) => matches(project.label))
        .slice(0, 12)
        .map((project) => ({
          group: "Projects",
          label: project.label,
          run: () =>
            this.pick({
              label: `@${project.label}`,
              text: `Refer to the project at ${project.path} (read it, but don't change it).`,
            }),
        })),
      {
        group: "From your Mac",
        label: "Add files from your Mac",
        run: () => {
          this.removeToken();
          this.menu.hidden = true;
          void window.app.addFilesToProject(this.key).then((files) => {
            for (const file of files) {
              this.addChip({ label: `@${file.label}`, text: `Use the file ${file.path}.` });
            }
          });
        },
      },
    ];
  }

  private async updateMenu(): Promise<void> {
    const token = this.menuToken();
    if (!token) {
      this.menu.hidden = true;
      return;
    }
    this.menuData ??= await window.app.menuData(this.key);
    this.menuEntries = this.entriesFor(token.trigger, token.query, this.menuData);
    this.menuIndex = 0;
    this.menu.hidden = this.menuEntries.length === 0;
    this.paintMenu();
  }

  private paintMenu(): void {
    let lastGroup: string | undefined;
    const rows: HTMLElement[] = [];
    this.menuEntries.forEach((entry, index) => {
      if (entry.group && entry.group !== lastGroup) {
        rows.push(h("div", { class: "menu-group" }, entry.group));
        lastGroup = entry.group;
      }
      rows.push(
        h(
          "button",
          {
            class: index === this.menuIndex ? "menu-row on" : "menu-row",
            onClick: (event) => {
              event.preventDefault();
              entry.run();
            },
          },
          h("span", { class: "row-name" }, entry.label),
          entry.hint ? h("span", { class: "row-age" }, entry.hint) : null,
        ),
      );
    });
    this.menu.replaceChildren(...rows);
    this.menu.querySelector(".menu-row.on")?.scrollIntoView({ block: "nearest" });
  }

  private paintChips(): void {
    this.chipRow.hidden = this.chips.length === 0;
    this.chipRow.replaceChildren(
      ...this.chips.map((chip, index) =>
        h(
          "span",
          { class: "attachment", title: chip.text },
          chip.label,
          h(
            "button",
            {
              class: "attachment-remove",
              label: `Remove ${chip.label}`,
              onClick: (event) => {
                event.preventDefault();
                this.chips.splice(index, 1);
                this.paintChips();
              },
            },
            icon("close", 12),
          ),
        ),
      ),
    );
  }

  // ── Pending video edits ──

  private paintPending(edits: PendingEdit[]): void {
    this.pendingBox.hidden = edits.length === 0;
    if (edits.length === 0) {
      this.pendingBox.replaceChildren();
      this.pendingNote = "";
      return;
    }
    const note = document.createElement("input");
    note.placeholder = "A note for all of them (optional)";
    note.value = this.pendingNote;
    note.addEventListener("input", () => {
      this.pendingNote = note.value;
    });
    const count = edits.length === 1 ? "1 edit" : `${edits.length} edits`;
    this.pendingBox.replaceChildren(
      h("h4", { class: "pending-title" }, "Pending video edits"),
      ...edits.map((edit) => {
        const text = document.createElement("input");
        text.value = edit.note;
        text.setAttribute("aria-label", "Edit note");
        text.addEventListener("change", () => {
          void window.app.pendingUpdate(this.key, edit.id, text.value.trim() || edit.note);
        });
        return h(
          "div",
          { class: "pending-row" },
          h("span", { class: "pending-kind" }, edit.kind),
          text,
          h(
            "button",
            {
              class: "attachment-remove",
              label: "Delete this edit",
              onClick: () => void window.app.pendingRemove(this.key, edit.id),
            },
            icon("close", 12),
          ),
        );
      }),
      note,
      h(
        "button",
        {
          class: "primary pending-send",
          onClick: () => void window.app.pendingSend(this.key, this.pendingNote.trim()),
        },
        this.running ? `Queue ${count}` : `Send ${count} to Claude`,
      ),
    );
  }

  // ── Messages ──

  /** Runs of steps fold into one line that shows the latest step, opening to show them all. */
  private addTool(item: Extract<ChatItem, { kind: "tool" }>): void {
    let group = this.messages.lastElementChild;
    if (!(group instanceof HTMLDetailsElement)) {
      group = h("details", { class: "steps" }, document.createElement("summary"));
      this.messages.append(group);
    }
    const row = h("div", { class: "message tool" }, item.summary);
    row.classList.toggle("failed", item.failed === true);
    this.toolRows.set(item.id, row);
    group.append(row);
    const count = group.querySelectorAll(".tool").length;
    const summary = group.querySelector("summary");
    if (summary) {
      summary.textContent = count === 1 ? item.summary : `${item.summary} · ${count} steps`;
    }
  }

  private addItem(item: ChatItem): void {
    this.live = null;
    if (item.kind === "tool") {
      this.addTool(item);
    } else if (item.kind === "run-end") {
      const undo = h(
        "button",
        {
          class: "undo-run",
          title: "Put the project back to how it was before this run",
          onClick: () => {
            undo.disabled = true;
            void window.app.chatUndo(this.key, item.at);
          },
        },
        "Undo this run",
      );
      this.messages.append(undo);
    } else {
      const row = h("div", { class: `message ${item.kind}` });
      if (item.kind === "assistant") {
        renderMarkdown(row, item.text, this.options.baseDir ?? null);
        this.live = { element: row, text: item.text };
      } else {
        row.textContent = item.text;
      }
      this.messages.append(row);
    }
    this.scrollToEnd();
  }
}
