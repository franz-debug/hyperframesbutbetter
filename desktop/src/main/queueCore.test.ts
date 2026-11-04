import { describe, expect, it } from "bun:test";
import type { Job } from "../shared/types";
import { JobQueue, type QueueHooks } from "./queueCore";

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

function makeQueue(overrides: Partial<QueueHooks> = {}) {
  const started: string[] = [];
  let active = 0;
  let peak = 0;
  const idle: { done: number; failed: number }[] = [];
  const queue = new JobQueue(
    {
      run: async (job: Job) => {
        started.push(job.title);
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (job.title.startsWith("bad")) throw new Error("it broke");
      },
      canStart: async () => true,
      stopsQueue: () => null,
      onChange: () => {},
      onIdle: (summary) => idle.push({ ...summary }),
      ...overrides,
    },
    5,
  );
  return { queue, started, idle, peak: () => peak };
}

describe("JobQueue", () => {
  it("runs jobs in order, one at a time", async () => {
    const { queue, started, idle, peak } = makeQueue();
    for (const title of ["a", "b", "c", "d"]) queue.add({ kind: "render", title });
    queue.start();
    await until(() => idle.length === 1);
    expect(started).toEqual(["a", "b", "c", "d"]);
    expect(peak()).toBe(1);
    expect(idle[0]).toEqual({ done: 4, failed: 0 });
  });

  it("keeps going after a failure and skips only what depends on it", async () => {
    const { queue, started, idle } = makeQueue();
    const bad = queue.add({ kind: "import", title: "bad" });
    const good = queue.add({ kind: "import", title: "good" });
    queue.add({ kind: "edit", title: "edit bad", after: bad.id });
    const edit = queue.add({ kind: "edit", title: "edit good", after: good.id });
    queue.start();
    await until(() => idle.length === 1);
    expect(started).toEqual(["bad", "good", "good"]);
    expect(queue.jobs.find((job) => job.id === edit.id)?.status).toBe("done");
    expect(idle[0]).toEqual({ done: 2, failed: 2 });
  });

  it("passes an imported project on to the jobs that follow it", async () => {
    const seen: (string | null)[] = [];
    const { queue, idle } = makeQueue({
      run: async (job, update) => {
        seen.push(job.dir);
        if (job.kind === "import") update({ dir: "/projects/one", title: "one" });
      },
    });
    const first = queue.add({ kind: "import", title: "one.mov" });
    const edit = queue.add({ kind: "edit", title: "one.mov", after: first.id });
    queue.add({ kind: "render", title: "one.mov", after: edit.id });
    queue.start();
    await until(() => idle.length === 1);
    expect(seen).toEqual([null, "/projects/one", "/projects/one"]);
    expect(queue.jobs[2]?.title).toBe("one");
  });

  it("lets an export go ahead of edits still waiting, but never interrupts one", async () => {
    let release = () => {};
    const seen: string[] = [];
    const { queue, idle } = makeQueue({
      run: async (job) => {
        seen.push(job.title);
        if (job.title === "edit 1") await new Promise<void>((r) => (release = r));
      },
    });
    queue.add({ kind: "edit", title: "edit 1" });
    queue.add({ kind: "edit", title: "edit 2" });
    queue.start();
    await until(() => seen.length === 1);
    queue.add({ kind: "render", title: "export" });
    release();
    await until(() => idle.length === 1);
    expect(seen).toEqual(["edit 1", "export", "edit 2"]);
  });

  it("waits while there is no memory, then carries on", async () => {
    let room = false;
    const { queue, started, idle } = makeQueue({ canStart: async () => room });
    queue.add({ kind: "render", title: "a" });
    queue.start();
    await until(() => queue.waitingForMemory);
    expect(started).toEqual([]);
    room = true;
    await until(() => idle.length === 1);
    expect(started).toEqual(["a"]);
    expect(queue.waitingForMemory).toBe(false);
  });

  it("pauses instead of failing everything when a failure would repeat", async () => {
    const { queue, started } = makeQueue({
      stopsQueue: (error) => (error.includes("broke") ? "Out of usage" : null),
    });
    queue.add({ kind: "edit", title: "bad" });
    queue.add({ kind: "edit", title: "next" });
    queue.start();
    await until(() => queue.paused);
    expect(started).toEqual(["bad"]);
    expect(queue.pauseReason).toBe("Out of usage");
    expect(queue.jobs[1]?.status).toBe("waiting");
  });

  it("cancels a waiting job, stops a running one, and can retry with what it blocked", async () => {
    const gate = { open: false };
    const { queue, idle } = makeQueue({
      run: async (_job, _update, signal) => {
        while (!signal.aborted && !gate.open) await new Promise((r) => setTimeout(r, 2));
      },
    });
    const first = queue.add({ kind: "render", title: "first" });
    const follow = queue.add({ kind: "render", title: "follow", after: first.id });
    const other = queue.add({ kind: "render", title: "other" });
    queue.start();
    await until(() => queue.isRunning);
    queue.cancel(other.id);
    expect(queue.jobs.find((job) => job.id === other.id)?.status).toBe("cancelled");
    queue.cancel(first.id);
    await until(() => first.status === "cancelled" && follow.status === "failed");
    await until(() => !queue.isRunning);
    gate.open = true;
    queue.retry(first.id);
    await until(() => first.status === "done" && follow.status === "done");
    expect(idle.length).toBeGreaterThan(0);
  });

  it("starts interrupted jobs over after a restart, and clears only finished ones", () => {
    const { queue } = makeQueue();
    const base = queue.add({ kind: "render", title: "a" });
    const interrupted: Job = { ...base, status: "running", progress: 40, stage: "Encoding" };
    const finished: Job = { ...base, id: "done-1", status: "done" };
    queue.restore([interrupted, finished], false);
    expect(queue.jobs[0]?.status).toBe("waiting");
    expect(queue.jobs[0]?.progress).toBe(0);
    queue.clearFinished();
    expect(queue.jobs.map((job) => job.status)).toEqual(["waiting"]);
  });
});
