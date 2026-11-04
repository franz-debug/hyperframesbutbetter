// The job queue's rules, kept free of Electron so they can be tested on their own:
// one job at a time, in order, and a failure never stops the jobs that don't depend on it.
import type { Job, JobInput } from "../shared/types";

export interface QueueHooks {
  run(job: Job, update: (patch: Partial<Job>) => void, signal: AbortSignal): Promise<void>;
  /** False while the machine has no room for another job. */
  canStart(): Promise<boolean>;
  /** A message when this failure means every later job would fail too, such as a usage limit. */
  stopsQueue(error: string): string | null;
  onChange(): void;
  onIdle(summary: { done: number; failed: number }): void;
}

const newId = (): string =>
  `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class JobQueue {
  jobs: Job[] = [];
  paused = false;
  pauseReason: string | null = null;
  waitingForMemory = false;
  private pumping = false;
  private running: { id: string; abort: AbortController } | null = null;
  private summary = { done: 0, failed: 0 };

  constructor(
    private readonly hooks: QueueHooks,
    private readonly retryMs = 5_000,
  ) {}

  /** Picks up saved jobs. Anything that was mid-run starts over. */
  restore(jobs: Job[], paused: boolean): void {
    this.jobs = jobs.map((job) =>
      job.status === "running" ? { ...job, status: "waiting", progress: 0, stage: "" } : job,
    );
    this.paused = paused;
  }

  add(input: JobInput): Job {
    const job: Job = {
      dir: null,
      after: null,
      sourcePath: null,
      instruction: null,
      exportDir: null,
      outputPath: null,
      folderId: null,
      batchSize: 1,
      options: null,
      brandKitId: null,
      ...input,
      id: newId(),
      status: "waiting",
      progress: 0,
      stage: "",
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
    };
    this.jobs.push(job);
    this.hooks.onChange();
    return job;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  hasRender(dir: string): boolean {
    return this.jobs.some(
      (job) =>
        job.kind === "render" &&
        job.dir === dir &&
        (job.status === "waiting" || job.status === "running"),
    );
  }

  start(): void {
    void this.pump();
  }

  setPaused(paused: boolean, reason: string | null = null): void {
    this.paused = paused;
    this.pauseReason = paused ? reason : null;
    this.hooks.onChange();
    if (!paused) this.start();
  }

  cancel(id: string): void {
    const job = this.jobs.find((item) => item.id === id);
    if (!job) return;
    if (this.running?.id === id) {
      this.running.abort.abort();
    } else if (job.status === "waiting") {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      this.hooks.onChange();
    }
  }

  /** Tries a job again, along with the jobs that were skipped because of it. */
  retry(id: string): void {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || (job.status !== "failed" && job.status !== "cancelled")) return;
    this.reset(job);
    this.hooks.onChange();
    this.start();
  }

  clearFinished(): void {
    const kept = this.jobs.filter((job) => job.status === "waiting" || job.status === "running");
    this.jobs = kept;
    this.hooks.onChange();
  }

  private reset(job: Job): void {
    Object.assign(job, {
      status: "waiting",
      progress: 0,
      stage: "",
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    for (const later of this.jobs) {
      if (later.after === job.id && later.status === "failed") this.reset(later);
    }
  }

  /**
   * The first job that can go. Exports go ahead of edits still waiting, because the person asked
   * for them by hand. Jobs whose prerequisite failed are skipped along the way.
   */
  private next(): Job | null {
    const inOrder = [
      ...this.jobs.filter((job) => job.kind === "render"),
      ...this.jobs.filter((job) => job.kind !== "render"),
    ];
    for (const job of inOrder) {
      if (job.status !== "waiting") continue;
      const before = job.after ? this.jobs.find((item) => item.id === job.after) : null;
      if (job.after && !before) return job;
      if (!before || before.status === "done") {
        if (before?.dir) job.dir = before.dir;
        if (before) job.title = before.title;
        return job;
      }
      if (before.status === "failed" || before.status === "cancelled") {
        job.status = "failed";
        job.error = `Skipped because the step before it for ${before.title} didn't finish.`;
        job.finishedAt = Date.now();
        this.summary.failed++;
        this.hooks.onChange();
      }
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.paused) return;
        const job = this.next();
        if (!job) break;
        if (!(await this.hooks.canStart())) {
          if (!this.waitingForMemory) {
            this.waitingForMemory = true;
            this.hooks.onChange();
          }
          await new Promise((resolve) => setTimeout(resolve, this.retryMs));
          continue;
        }
        this.waitingForMemory = false;
        await this.execute(job);
      }
      if (this.summary.done + this.summary.failed > 0) {
        this.hooks.onIdle(this.summary);
        this.summary = { done: 0, failed: 0 };
      }
    } finally {
      this.pumping = false;
    }
  }

  private async execute(job: Job): Promise<void> {
    const abort = new AbortController();
    this.running = { id: job.id, abort };
    job.status = "running";
    job.startedAt = Date.now();
    this.hooks.onChange();
    const update = (patch: Partial<Job>) => {
      Object.assign(job, patch);
      this.hooks.onChange();
    };
    try {
      await this.hooks.run(job, update, abort.signal);
      job.status = abort.signal.aborted ? "cancelled" : "done";
      if (job.status === "done") {
        job.progress = 100;
        this.summary.done++;
      }
    } catch (error) {
      if (abort.signal.aborted) {
        job.status = "cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        this.summary.failed++;
        const reason = this.hooks.stopsQueue(job.error);
        if (reason) {
          this.paused = true;
          this.pauseReason = reason;
        }
      }
    }
    job.finishedAt = Date.now();
    this.running = null;
    this.hooks.onChange();
  }
}
