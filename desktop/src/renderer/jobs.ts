import { h, icon } from "./dom";
import type { Job, QueueSnapshot } from "../shared/types";

const ACTIVE = new Set(["running", "waiting"]);

export function jobLabel(job: Job): string {
  if (job.status === "running") {
    if (job.kind === "import") return "Importing";
    if (job.kind === "edit") return "Editing";
    return job.progress > 0 ? `Exporting ${Math.round(job.progress)}%` : "Exporting";
  }
  if (job.status === "waiting") {
    if (job.kind === "import") return "Waiting to import";
    if (job.kind === "edit") return "Waiting to edit";
    return "Waiting to export";
  }
  if (job.status === "failed") return "Didn't finish";
  if (job.status === "cancelled") return "Cancelled";
  if (job.kind === "import") return "Imported";
  if (job.kind === "edit") return "Edited";
  return "Exported";
}

/** What's happening to a project right now, if anything. */
export function activeJobFor(queue: QueueSnapshot | null, dir: string): Job | null {
  const jobs = queue?.jobs.filter((job) => job.dir === dir && ACTIVE.has(job.status)) ?? [];
  return jobs.find((job) => job.status === "running") ?? jobs[0] ?? null;
}

/** The latest thing that happened to a project, finished or not. */
export function latestJobFor(queue: QueueSnapshot | null, dir: string): Job | null {
  const active = activeJobFor(queue, dir);
  if (active) return active;
  const jobs = queue?.jobs.filter((job) => job.dir === dir) ?? [];
  return jobs[jobs.length - 1] ?? null;
}

export function statusChip(job: Job | null): HTMLElement | null {
  if (!job) return null;
  return h("span", { class: `chip ${job.status}`, title: job.error ?? job.stage }, jobLabel(job));
}

function jobRow(job: Job): HTMLElement {
  const detail =
    job.status === "failed" ? job.error : job.status === "running" ? job.stage : job.outputPath;
  const actions = h("div", { class: "job-actions" });
  if (job.status === "running" || job.status === "waiting") {
    actions.append(
      h(
        "button",
        { class: "ghost", onClick: () => void window.app.cancelJob(job.id) },
        job.status === "running" ? "Stop" : "Remove",
      ),
    );
  }
  if (job.status === "failed" || job.status === "cancelled") {
    actions.append(
      h("button", { class: "ghost", onClick: () => void window.app.retryJob(job.id) }, "Try again"),
    );
  }
  if (job.status === "done" && job.kind === "render" && job.outputPath) {
    const path = job.outputPath;
    actions.append(
      h("button", { class: "ghost", onClick: () => void window.app.openFile(path) }, "Open video"),
      h(
        "button",
        { class: "ghost", onClick: () => void window.app.showInFinder(path) },
        "Show in Finder",
      ),
    );
  }
  const bar =
    job.status === "running"
      ? h("div", { class: "bar" }, h("div", { class: job.progress > 0 ? "fill" : "fill unknown" }))
      : null;
  const fill = bar?.firstElementChild;
  if (fill instanceof HTMLElement && job.progress > 0) fill.style.width = `${job.progress}%`;
  return h(
    "div",
    { class: `job ${job.status}` },
    h(
      "div",
      { class: "job-main" },
      h("div", { class: "job-top" }, h("span", { class: "job-title" }, job.title), statusChip(job)),
      detail ? h("div", { class: "job-detail", title: detail }, detail) : null,
      bar,
    ),
    actions,
  );
}

export function renderQueueList(queue: QueueSnapshot): HTMLElement {
  const running = queue.jobs.filter((job) => job.status === "running");
  const waiting = queue.jobs.filter((job) => job.status === "waiting");
  const finished = queue.jobs
    .filter((job) => !ACTIVE.has(job.status))
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const section = (title: string, jobs: Job[]) =>
    jobs.length > 0
      ? h(
          "section",
          { class: "job-section" },
          h("h3", {}, `${title} `, h("span", { class: "count" }, jobs.length)),
          ...jobs.map(jobRow),
        )
      : null;
  return h(
    "div",
    { class: "job-list" },
    section("Working on", running),
    section(
      "Export queue",
      waiting.filter((job) => job.kind === "render"),
    ),
    section(
      "Starting projects",
      waiting.filter((job) => job.kind !== "render"),
    ),
    section("Finished", finished),
    queue.jobs.length === 0
      ? h(
          "p",
          { class: "empty" },
          "Nothing here yet. New projects and videos you export line up here and run one at a time.",
        )
      : null,
  );
}

export function memoryBadge(queue: QueueSnapshot): HTMLElement {
  const { pressure, usedPercent } = queue.memory;
  const word = pressure === "normal" ? "OK" : pressure === "warning" ? "Tight" : "Very tight";
  return h(
    "span",
    { class: `memory ${pressure}`, title: "How much of this Mac's memory is in use" },
    `Memory ${usedPercent}% · ${word}`,
  );
}

export function queueSummary(queue: QueueSnapshot): string {
  const running = queue.jobs.find((job) => job.status === "running");
  const left = queue.jobs.filter((job) => ACTIVE.has(job.status)).length;
  if (queue.paused && left > 0) return `Paused · ${left} left`;
  if (queue.waitingForMemory) return `Waiting for memory · ${left} left`;
  if (running) return `${jobLabel(running)}: ${running.title} · ${left} left`;
  return left > 0 ? `${left} waiting` : "Nothing running";
}

export const queueIcon = (): SVGSVGElement => icon("queue");
