import brand from "../../brand.json";
import { brandView } from "./brandView";
import { captionsPanel } from "./captionsPanel";
import { ChatPanel } from "./chatPanel";
import { age, askText, byId, h, icon } from "./dom";
import {
  activeJobFor,
  jobLabel,
  latestJobFor,
  memoryBadge,
  queueSummary,
  renderQueueList,
  statusChip,
} from "./jobs";
import { openExportPanel } from "./exportPanel";
import { renderMakeBox } from "./make";
import { scriptPanel } from "./scriptPanel";
import { settingsView } from "./settingsView";
import { openShareDialog } from "./sharePanel";
import type {
  Folder,
  LibrarySnapshot,
  ProjectSummary,
  QueueSnapshot,
  UiCommand,
} from "../shared/types";

type Route =
  | { name: "home" }
  | { name: "queue" }
  | { name: "all" }
  | { name: "archived" }
  | { name: "change" }
  | { name: "brand" }
  | { name: "settings" }
  | { name: "folder"; id: string }
  | { name: "project"; dir: string };

const ROUTE_KEY = "last-route";
const APP_CHAT_KEY = "__app__";

let library: LibrarySnapshot = { projects: [], folders: [], lastExportDir: null };
let queue: QueueSnapshot | null = null;
let route: Route = { name: "home" };
const history: Route[] = [];
const future: Route[] = [];
let search = "";
let searchOpen = false;
let chat: ChatPanel | null = null;
/** Repaints only the parts of the open view that follow the queue. */
let onQueueTick: (() => void) | null = null;

const projectFor = (dir: string): ProjectSummary | undefined =>
  library.projects.find((project) => project.dir === dir);

function saveRoute(): void {
  try {
    localStorage.setItem(ROUTE_KEY, JSON.stringify(route));
  } catch {
    /* only a convenience */
  }
}

function readRoute(): Route {
  try {
    const stored = localStorage.getItem(ROUTE_KEY);
    if (stored) return JSON.parse(stored) as Route;
  } catch {
    /* start at Home */
  }
  return { name: "home" };
}

function go(next: Route, remember = true): void {
  if (remember) {
    history.push(route);
    future.length = 0;
  }
  route = next;
  saveRoute();
  renderView();
  renderSidebar();
}

function back(): void {
  const previous = history.pop();
  if (!previous) return;
  future.push(route);
  go(previous, false);
}

function forward(): void {
  const next = future.pop();
  if (!next) return;
  history.push(route);
  go(next, false);
}

// ── Sidebar ──

function thumb(project: ProjectSummary, className: string): HTMLElement {
  if (project.thumbUrl) {
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = "";
    image.src = project.thumbUrl;
    return h("span", { class: className }, image);
  }
  return h("span", { class: `${className} empty-thumb` }, project.name.charAt(0).toUpperCase());
}

function projectRow(project: ProjectSummary, nested = false): HTMLElement {
  const active = activeJobFor(queue, project.dir);
  const row = h(
    "button",
    {
      class: `row project-row${nested ? " nested" : ""}${
        route.name === "project" && route.dir === project.dir ? " on" : ""
      }`,
      title: project.name,
      onClick: () => go({ name: "project", dir: project.dir }),
      onContextMenu: (event) => {
        event.preventDefault();
        void window.app.projectMenu(project.dir);
      },
    },
    thumb(project, "row-thumb"),
    h("span", { class: "row-name" }, project.name),
    active
      ? h(
          "span",
          { class: `row-status ${active.status}`, title: jobLabel(active) },
          shortStatus(active.status, active.progress),
        )
      : h("span", { class: "row-age" }, age(project.modifiedAt)),
  );
  row.draggable = true;
  row.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", project.dir);
  });
  return row;
}

function shortStatus(status: string, progress: number): string {
  if (status === "waiting") return "•••";
  return progress > 0 ? `${Math.round(progress)}%` : "Now";
}

function folderRow(folder: Folder): HTMLElement[] {
  const projects = folder.paths
    .map(projectFor)
    .filter((project): project is ProjectSummary => project !== undefined);
  const chevron = h(
    "span",
    {
      class: folder.open ? "chevron open" : "chevron",
      label: folder.open ? "Collapse" : "Expand",
      onClick: (event) => {
        event.stopPropagation();
        folder.open = !folder.open;
        void window.app.setFolderOpen(folder.id, folder.open);
        renderSidebar();
      },
    },
    icon("chevron", 12),
  );
  const row = h(
    "button",
    {
      class: `row folder-row${route.name === "folder" && route.id === folder.id ? " on" : ""}`,
      title: folder.name,
      onClick: () => go({ name: "folder", id: folder.id }),
      onContextMenu: (event) => {
        event.preventDefault();
        void window.app.folderMenu(folder.id);
      },
    },
    chevron,
    icon("folder"),
    h("span", { class: "row-name" }, folder.name),
    h("span", { class: "row-age" }, projects.length),
  );
  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    row.classList.add("dropping");
  });
  row.addEventListener("dragleave", () => row.classList.remove("dropping"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("dropping");
    const dir = event.dataTransfer?.getData("text/plain");
    if (dir) void window.app.moveToFolder(dir, folder.id);
  });
  return [row, ...(folder.open ? projects.map((project) => projectRow(project, true)) : [])];
}

function navRow(
  label: string,
  iconName: Parameters<typeof icon>[0],
  target: Route,
  extra?: string | number,
): HTMLElement {
  return h(
    "button",
    {
      class: `row nav-row${route.name === target.name ? " on" : ""}`,
      onClick: () => go(target),
    },
    icon(iconName),
    h("span", { class: "row-name" }, label),
    extra !== undefined && extra !== 0 ? h("span", { class: "badge" }, extra) : null,
  );
}

async function newFolder(dirs: string[] = []): Promise<void> {
  const name = await askText("Folder name");
  if (!name) return;
  const id = await window.app.newFolder(name, dirs);
  library = await window.app.library();
  go({ name: "folder", id });
}

function renderSidebar(): void {
  const list = byId("sidebar");
  const previous = list.querySelector(".side-scroll");
  const scrollTop = previous?.scrollTop ?? 0;
  // The queue repaints this every half second, so typing a search has to survive that.
  const searching = document.activeElement?.matches("#sidebar input[type=search]") === true;
  const live = library.projects.filter((project) => !project.archived);
  const archived = library.projects.length - live.length;
  const left =
    queue?.jobs.filter((job) => job.status === "running" || job.status === "waiting").length ?? 0;

  const searchInput = document.createElement("input");
  searchInput.type = "search";
  searchInput.placeholder = "Search projects";
  searchInput.value = search;
  searchInput.addEventListener("input", () => {
    search = searchInput.value;
    renderSidebar();
  });

  const pinned = live.filter((project) => project.pinned);
  const query = search.trim().toLowerCase();
  const scroll = h(
    "div",
    { class: "side-scroll" },
    ...(query
      ? live
          .filter((project) => project.name.toLowerCase().includes(query))
          .map((project) => projectRow(project))
      : [
          pinned.length > 0 ? h("h4", {}, "Pinned Projects") : null,
          ...pinned.map((project) => projectRow(project)),
          h(
            "h4",
            {},
            "Projects",
            h(
              "button",
              {
                class: "h4-button",
                label: "New folder",
                title: "New folder",
                onClick: () => void newFolder(),
              },
              icon("plus", 13),
            ),
          ),
          ...library.folders.flatMap(folderRow),
          library.folders.length === 0
            ? h("p", { class: "side-empty" }, "Folders show up here.")
            : null,
        ]),
  );

  list.replaceChildren(
    h(
      "div",
      { class: "brand-row" },
      Object.assign(document.createElement("img"), { src: "logo.svg", alt: "", className: "logo" }),
      h("span", { class: "brand-name" }, brand.name),
    ),
    h(
      "div",
      { class: "side-card" },
      h(
        "div",
        { class: "side-tools" },
        h(
          "button",
          {
            class: "icon-button",
            label: "Search projects",
            onClick: () => {
              searchOpen = !searchOpen;
              if (!searchOpen) search = "";
              renderSidebar();
              byId("sidebar").querySelector<HTMLInputElement>("input[type=search]")?.focus();
            },
          },
          icon("search"),
        ),
        h(
          "button",
          {
            class: "icon-button",
            label: "New video",
            title: "New video",
            onClick: () => go({ name: "home" }),
          },
          icon("plus"),
        ),
      ),
      searchOpen ? searchInput : null,
      navRow("Home", "home", { name: "home" }),
      navRow("Brand kits", "palette", { name: "brand" }),
      navRow("Queue", "queue", { name: "queue" }, left),
      scroll,
      h(
        "div",
        { class: "side-foot" },
        navRow("All projects", "grid", { name: "all" }, live.length),
        h(
          "button",
          { class: "row nav-row accent-row", onClick: () => void window.app.importProjects() },
          icon("download"),
          h("span", { class: "row-name" }, "Import projects"),
        ),
        navRow("Archived", "archive", { name: "archived" }, archived),
        h("div", { class: "side-rule" }),
        navRow("Settings", "gear", { name: "settings" }),
        navRow("Change this app", "wand", { name: "change" }),
        queue ? h("div", { class: "side-memory" }, memoryBadge(queue)) : null,
      ),
    ),
  );
  const next = list.querySelector(".side-scroll");
  if (next) next.scrollTop = scrollTop;
  if (searching) {
    searchInput.focus();
    searchInput.setSelectionRange(search.length, search.length);
  }
}

// ── Views ──

function tile(project: ProjectSummary): HTMLElement {
  const button = h(
    "button",
    {
      class: "tile",
      onClick: () => go({ name: "project", dir: project.dir }),
      onContextMenu: (event) => {
        event.preventDefault();
        void window.app.projectMenu(project.dir);
      },
    },
    thumb(project, "tile-thumb"),
    h("span", { class: "tile-name" }, project.name),
    h(
      "span",
      { class: "tile-when" },
      `${age(project.modifiedAt)} ago`,
      " ",
      statusChip(activeJobFor(queue, project.dir) ?? null),
    ),
  );
  button.draggable = true;
  button.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", project.dir);
  });
  return button;
}

function homeView(): HTMLElement {
  const summary = h("button", { class: "queue-strip", onClick: () => go({ name: "queue" }) });
  const tick = () => {
    if (!queue) return;
    summary.replaceChildren(icon("queue"), h("span", {}, queueSummary(queue)));
    summary.hidden = !queue.jobs.some(
      (job) => job.status === "running" || job.status === "waiting",
    );
  };
  tick();
  onQueueTick = tick;
  const recent = library.projects.filter((project) => !project.archived).slice(0, 12);
  return h(
    "div",
    { class: "home" },
    h("h1", { class: "headline" }, brand.tagline),
    h(
      "div",
      { class: "home-columns" },
      renderMakeBox({ lastExportDir: library.lastExportDir }, (result) => {
        // The new project or folder has to be in the list before its screen can open.
        void window.app.library().then((fresh) => {
          library = fresh;
          if (result.kind === "project") go({ name: "project", dir: result.dir });
          else if (result.folderId) go({ name: "folder", id: result.folderId });
          else go({ name: "queue" });
        });
      }),
      h(
        "section",
        { class: "home-side" },
        summary,
        h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "panel-head" },
            h("h2", {}, "Your Projects"),
            h("span", { class: "spacer" }),
            h("button", { class: "ghost", onClick: () => go({ name: "all" }) }, "All projects"),
          ),
          h("div", { class: "grid" }, ...recent.map(tile)),
          recent.length === 0 ? h("p", { class: "empty" }, "Your videos will show up here.") : null,
        ),
      ),
    ),
  );
}

function listView(title: string, projects: ProjectSummary[], empty: string): HTMLElement {
  return h(
    "div",
    { class: "page" },
    h("h1", { class: "page-title" }, title, " ", h("span", { class: "count" }, projects.length)),
    h("div", { class: "grid" }, ...projects.map(tile)),
    projects.length === 0 ? h("p", { class: "empty" }, empty) : null,
  );
}

function queueView(): HTMLElement {
  const banner = h("div", {});
  const list = h("div", { class: "queue-body" });
  const head = h("div", { class: "page-tools" });
  const tick = () => {
    if (!queue) return;
    const finished = queue.jobs.some((job) => job.status !== "running" && job.status !== "waiting");
    head.replaceChildren(
      memoryBadge(queue),
      h("span", { class: "spacer" }),
      finished
        ? h(
            "button",
            { class: "ghost", onClick: () => void window.app.clearFinished() },
            "Clear finished",
          )
        : "",
      h(
        "button",
        { class: "ghost", onClick: () => void window.app.setPaused(!queue?.paused) },
        queue.paused ? "Resume" : "Pause",
      ),
    );
    banner.replaceChildren(
      queue.pauseReason ? h("div", { class: "banner" }, queue.pauseReason) : "",
      queue.paused && !queue.pauseReason
        ? h(
            "div",
            { class: "banner" },
            "Paused. The current video finishes, then nothing new starts.",
          )
        : "",
      queue.waitingForMemory
        ? h(
            "div",
            { class: "banner" },
            "This Mac is short on memory, so the next job is waiting for room.",
          )
        : "",
    );
    list.replaceChildren(renderQueueList(queue));
  };
  tick();
  onQueueTick = tick;
  return h("div", { class: "page" }, h("h1", { class: "page-title" }, "Queue"), head, banner, list);
}

function folderView(initial: Folder): HTMLElement {
  const folderNow = (): Folder => library.folders.find((item) => item.id === initial.id) ?? initial;
  const folder = initial;
  chat = new ChatPanel(`director:${folder.id}`, {
    placeholder: "Tell the Director what to change across these videos",
    intro: `This is the Director for ${folder.name}. Describe something that's wrong across the videos and it works through them one at a time, then reports back on each.`,
  });
  const rows = h("div", { class: "video-rows" });
  const selected = new Set<string>();
  const exportButton = h("button", { class: "primary" }, "Export all");
  const paintExport = () => {
    exportButton.textContent = selected.size > 0 ? `Export ${selected.size}` : "Export all";
  };
  exportButton.addEventListener("click", () => {
    const dirs = selected.size > 0 ? [...selected] : folderNow().paths;
    selected.clear();
    paintExport();
    void openExportPanel(dirs);
  });
  const pending = h("div", { class: "folder-status" });
  const pickBox = (dir: string): HTMLInputElement => {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = selected.has(dir);
    box.setAttribute("aria-label", "Choose for export");
    box.addEventListener("change", () => {
      if (box.checked) selected.add(dir);
      else selected.delete(dir);
      paintExport();
    });
    return box;
  };
  const countLabel = h("span", { class: "count" });
  const saveTo = h("button", {
    class: "ghost path",
    onClick: () => void window.app.setFolderExportDir(folder.id),
  });
  const tick = () => {
    const current = folderNow();
    countLabel.textContent = `${current.paths.length} videos`;
    saveTo.textContent = current.exportDir
      ? `Saves to ${current.exportDir.split("/").pop()}`
      : "Choose where to save";
    saveTo.title = current.exportDir ?? "Choose where this folder's videos are saved";
    const projects = current.paths
      .map(projectFor)
      .filter((project): project is ProjectSummary => project !== undefined);
    const waiting =
      queue?.jobs.filter(
        (job) =>
          job.folderId === folder.id &&
          job.kind === "import" &&
          (job.status === "waiting" || job.status === "running"),
      ) ?? [];
    pending.textContent = queue ? queueSummary(queue) : "";
    rows.replaceChildren(
      ...projects.map((project) => {
        const job = latestJobFor(queue, project.dir);
        const output = job?.status === "done" && job.kind === "render" ? job.outputPath : null;
        return h(
          "div",
          {
            class: "video-row",
            onContextMenu: (event) => {
              event.preventDefault();
              void window.app.projectMenu(project.dir);
            },
          },
          pickBox(project.dir),
          thumb(project, "row-thumb"),
          h(
            "button",
            {
              class: "video-name",
              title: project.name,
              onClick: () => go({ name: "project", dir: project.dir }),
            },
            project.name,
          ),
          statusChip(job),
          output
            ? h(
                "button",
                { class: "ghost", onClick: () => void window.app.showInFinder(output) },
                "Show file",
              )
            : null,
        );
      }),
      ...waiting.map((job) =>
        h(
          "div",
          { class: "video-row" },
          h("span", { class: "row-thumb empty-thumb" }, "…"),
          h("span", { class: "video-name" }, job.title),
          statusChip(job),
        ),
      ),
    );
  };
  tick();
  onQueueTick = tick;
  return h(
    "div",
    { class: "folder-page" },
    h(
      "header",
      { class: "folder-head" },
      h(
        "div",
        { class: "folder-title" },
        h("h1", { class: "page-title" }, folder.name),
        countLabel,
      ),
      h("span", { class: "spacer" }),
      saveTo,
      exportButton,
    ),
    h(
      "div",
      { class: "folder-body" },
      chat.element,
      h("div", { class: "folder-videos" }, pending, rows),
    ),
  );
}

function brandKitPicker(dir: string): HTMLSelectElement {
  const picker = document.createElement("select");
  picker.className = "chat-select";
  picker.setAttribute("aria-label", "Brand kit for this project");
  picker.title = "Brand kit for this project";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "No brand kit";
  picker.append(none);
  void Promise.all([window.app.brandKits(), window.app.projectBrandKit(dir)]).then(
    ([kits, current]) => {
      for (const kit of kits) {
        const option = document.createElement("option");
        option.value = kit.id;
        option.textContent = kit.name;
        picker.append(option);
      }
      picker.value = current ?? "";
    },
  );
  picker.addEventListener("change", () => {
    void window.app.setProjectBrandKit(dir, picker.value || null);
  });
  return picker;
}

function projectView(project: ProjectSummary): HTMLElement {
  const panel = new ChatPanel(project.dir, {
    placeholder: "Tell Claude what to change. Type @ for files, # for tools, / for commands",
    baseDir: project.dir,
    pendingEdits: true,
  });
  chat = panel;
  const stage = h(
    "div",
    { class: "stage" },
    h("div", { class: "spinner" }),
    h("p", { class: "stage-text" }, "Opening the editor"),
  );
  const chip = h("span", {});
  const tick = () => chip.replaceChildren(statusChip(activeJobFor(queue, project.dir)) ?? "");
  tick();
  onQueueTick = tick;
  const report = () => {
    if (route.name !== "project" || route.dir !== project.dir) return;
    const rect = stage.getBoundingClientRect();
    void window.app.setEditorBounds({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  };
  new ResizeObserver(report).observe(stage);
  window.app
    .openEditor(project.dir)
    .then(report)
    .catch((failure: unknown) => {
      stage.replaceChildren(
        h("p", { class: "stage-text" }, "The editor didn't open."),
        h(
          "pre",
          { class: "stage-log" },
          failure instanceof Error ? failure.message : String(failure),
        ),
        h("button", { class: "primary", onClick: () => renderView() }, "Try again"),
      );
    });

  const side = h("div", { class: "side-slot" });
  let open: "script" | "captions" | null = null;
  const scriptButton = h("button", { class: "ghost" }, "Script");
  const captionsButton = h("button", { class: "ghost" }, "Captions");
  const showSide = (which: "script" | "captions") => {
    open = open === which ? null : which;
    scriptButton.classList.toggle("on", open === "script");
    captionsButton.classList.toggle("on", open === "captions");
    if (open === "script") side.replaceChildren(scriptPanel(project.dir));
    else if (open === "captions") {
      side.replaceChildren(
        captionsPanel((style) => {
          panel.addChip({
            label: `@${style.title}`,
            text: `Use the ${style.name} caption style: \`hyperframes add ${style.name}\`.`,
          });
        }),
      );
    } else side.replaceChildren();
  };
  scriptButton.addEventListener("click", () => showSide("script"));
  captionsButton.addEventListener("click", () => showSide("captions"));

  return h(
    "div",
    { class: "project-page" },
    h(
      "header",
      { class: "project-head" },
      h("h2", { class: "project-title", title: project.name }, project.name),
      chip,
      h("span", { class: "spacer" }),
      brandKitPicker(project.dir),
      h("button", { class: "ghost", title: "Toggle chat (⌘J)", onClick: toggleChat }, "Chat"),
      scriptButton,
      captionsButton,
      h(
        "button",
        { class: "ghost", onClick: () => void window.app.showInFinder(project.dir) },
        "Show in Finder",
      ),
      h("button", { class: "ghost", onClick: () => void openShareDialog(project.dir) }, "Share"),
      h(
        "button",
        { class: "primary", onClick: () => void openExportPanel([project.dir]) },
        "Export",
      ),
    ),
    h("div", { class: "workspace" }, panel.element, side, stage),
  );
}

function changeView(): HTMLElement {
  chat = new ChatPanel(APP_CHAT_KEY, {
    placeholder: `What should change in ${brand.name}?`,
    intro: `Tell Claude what you'd like different in ${brand.name}. It changes the code, then the app restarts with the change.`,
  });
  return h(
    "div",
    { class: "change-page" },
    h("h1", { class: "page-title" }, "Change this app"),
    chat.element,
  );
}

function toggleChat(): void {
  document.body.classList.toggle("chat-hidden");
}

function renderView(): void {
  onQueueTick = null;
  chat = null;
  if (route.name !== "project") void window.app.hideEditor();
  const view = byId("view");
  let content: HTMLElement;
  switch (route.name) {
    case "queue":
      content = queueView();
      break;
    case "all":
      content = listView(
        "All projects",
        library.projects.filter((project) => !project.archived),
        "Your videos will show up here.",
      );
      break;
    case "archived":
      content = listView(
        "Archived",
        library.projects.filter((project) => project.archived),
        "Nothing archived.",
      );
      break;
    case "change":
      content = changeView();
      break;
    case "brand":
      content = brandView();
      break;
    case "settings":
      content = settingsView();
      break;
    case "folder": {
      const id = route.id;
      const folder = library.folders.find((item) => item.id === id);
      content = folder ? folderView(folder) : homeView();
      break;
    }
    case "project": {
      const dir = route.dir;
      const project = projectFor(dir);
      content = project ? projectView(project) : homeView();
      break;
    }
    default:
      content = homeView();
  }
  view.replaceChildren(content);
  focusChat();
}

function focusChat(): void {
  chat?.focus();
}

async function refreshLibrary(): Promise<void> {
  library = await window.app.library();
  renderSidebar();
  // Rebuilding the editor's page would restart it, so a project stays put; the rest repaint.
  if (route.name === "all" || route.name === "archived" || route.name === "home") {
    const active = document.activeElement;
    if (route.name !== "home" || !(active instanceof HTMLTextAreaElement)) renderView();
  } else if (route.name === "folder") {
    const id = route.id;
    if (!library.folders.some((folder) => folder.id === id)) go({ name: "home" });
    else onQueueTick?.();
  }
}

async function handleCommand(command: UiCommand): Promise<void> {
  switch (command.kind) {
    case "go-home":
      go({ name: "home" });
      break;
    case "go-queue":
      go({ name: "queue" });
      break;
    case "go-change":
      go({ name: "change" });
      break;
    case "toggle-chat":
      toggleChat();
      break;
    case "show-chat":
      document.body.classList.remove("chat-hidden");
      break;
    case "open-project":
      go({ name: "project", dir: command.dir });
      break;
    case "export-panel":
      await openExportPanel(command.dirs);
      break;
    case "new-folder":
      await newFolder(command.dirs);
      break;
    case "rename-folder": {
      const name = await askText("Rename folder", command.name);
      if (name) await window.app.renameFolder(command.id, name);
      break;
    }
  }
}

let sidebarPaintQueued = false;

async function start(): Promise<void> {
  document.title = brand.name;
  byId("go-back").append(icon("back"));
  byId("go-forward").append(icon("forward"));
  byId("toggle-sidebar").append(icon("sidebar"));
  byId("go-back").addEventListener("click", back);
  byId("go-forward").addEventListener("click", forward);
  byId("toggle-sidebar").addEventListener("click", () => {
    document.body.classList.toggle("sidebar-hidden");
  });
  window.app.onChatEvent((key, event) => chat?.handle(key, event));
  window.app.onPendingChanged((key, edits) => chat?.handlePending(key, edits));
  window.app.onLibraryChanged(() => void refreshLibrary());
  window.app.onCommand((command) => void handleCommand(command));
  window.app.onQueueChanged((snapshot) => {
    queue = snapshot;
    onQueueTick?.();
    if (!sidebarPaintQueued) {
      sidebarPaintQueued = true;
      setTimeout(() => {
        sidebarPaintQueued = false;
        renderSidebar();
      }, 500);
    }
  });
  [library, queue] = await Promise.all([window.app.library(), window.app.queue()]);
  route = readRoute();
  renderSidebar();
  renderView();
  window.addEventListener("focus", () => void refreshLibrary());
}

void start();
