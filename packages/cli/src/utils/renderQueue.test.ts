import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireRenderSlot,
  acquireRenderSlotForStudio,
  liveRenderSlots,
  MAX_PARALLEL_RENDERS_ENV,
  renderSlotLimit,
  workersPerRender,
} from "./renderQueue.js";

const GIB = 1024 ** 3;

describe("renderSlotLimit", () => {
  it("allows two renders on a machine with 8+ cores and 16+ GB, else one", () => {
    expect(renderSlotLimit({}, 10, 24 * GIB)).toBe(2);
    expect(renderSlotLimit({}, 8, 16 * GIB)).toBe(2);
    expect(renderSlotLimit({}, 8, 8 * GIB)).toBe(1);
    expect(renderSlotLimit({}, 4, 64 * GIB)).toBe(1);
  });

  it("takes the env override, where 0 turns the queue off, and ignores junk", () => {
    expect(renderSlotLimit({ [MAX_PARALLEL_RENDERS_ENV]: "4" }, 10, 24 * GIB)).toBe(4);
    expect(renderSlotLimit({ [MAX_PARALLEL_RENDERS_ENV]: "0" }, 10, 24 * GIB)).toBe(0);
    expect(renderSlotLimit({ [MAX_PARALLEL_RENDERS_ENV]: "lots" }, 10, 24 * GIB)).toBe(2);
    expect(renderSlotLimit({ [MAX_PARALLEL_RENDERS_ENV]: "1.5" }, 10, 24 * GIB)).toBe(2);
  });
});

describe("workersPerRender", () => {
  it("leaves a lone render to size itself and splits cores - 2 between shared renders", () => {
    expect(workersPerRender(1, 10)).toBeUndefined();
    expect(workersPerRender(2, 10)).toBe(4);
    expect(workersPerRender(4, 10)).toBe(2);
    expect(workersPerRender(8, 4)).toBe(1);
  });
});

describe("acquireRenderSlot", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-render-slots-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("holds a slot file until release", async () => {
    const slot = await acquireRenderSlot({ limit: 2, dir });
    expect(liveRenderSlots(dir)).toHaveLength(1);
    slot.release();
    expect(liveRenderSlots(dir)).toHaveLength(0);
  });

  it("makes the next render wait for a free slot and announces the wait once", async () => {
    const first = await acquireRenderSlot({ limit: 1, dir });
    const waits: Array<[number, number]> = [];
    let acquired = false;
    const second = acquireRenderSlot({
      limit: 1,
      dir,
      pollMs: 10,
      onWait: (running, limit) => waits.push([running, limit]),
    }).then((slot) => {
      acquired = true;
      return slot;
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(false);
    expect(waits).toEqual([[1, 1]]);

    first.release();
    const slot = await second;
    expect(acquired).toBe(true);
    expect(liveRenderSlots(dir)).toHaveLength(1);
    slot.release();
  });

  it("frees slots whose process exited or whose heartbeat stopped", async () => {
    const exited = spawn(process.execPath, ["-e", ""]);
    const deadPid = await new Promise<number>((resolve) =>
      exited.on("exit", () => resolve(exited.pid ?? 0)),
    );
    writeFileSync(join(dir, `${deadPid}.gone`), "{}");
    const stale = join(dir, `${process.pid}.stale`);
    writeFileSync(stale, "{}");
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);

    const slot = await acquireRenderSlot({ limit: 1, dir, pollMs: 10 });
    expect(readdirSync(dir).filter((name) => !name.startsWith("."))).toHaveLength(1);
    slot.release();
  });

  it("stops waiting when the render is cancelled", async () => {
    const first = await acquireRenderSlot({ limit: 1, dir });
    const controller = new AbortController();
    const second = acquireRenderSlot({ limit: 1, dir, pollMs: 10, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(second).rejects.toThrow("cancelled");
    expect(liveRenderSlots(dir)).toHaveLength(1);
    first.release();
  });

  it("is a no-op when the queue is off", async () => {
    const slot = await acquireRenderSlot({ limit: 0, dir });
    expect(readdirSync(dir)).toEqual([]);
    slot.release();
  });
});

describe("acquireRenderSlotForStudio", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-studio-render-queue-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("says it is waiting while the machine is full, then takes the slot that frees up", async () => {
    const first = await acquireRenderSlot({ limit: 1, dir });
    const state: { stage?: string } = {};
    const waiting = acquireRenderSlotForStudio(state, new AbortController().signal, {
      limit: 1,
      dir,
      pollMs: 5,
    });
    await expect.poll(() => state.stage).toContain("Waiting for a free render slot");
    first.release();
    const second = await waiting;
    expect(liveRenderSlots(dir)).toHaveLength(1);
    second.release();
    expect(liveRenderSlots(dir)).toHaveLength(0);
  });

  it("rejects when the render is cancelled in the queue, holding no slot", async () => {
    const first = await acquireRenderSlot({ limit: 1, dir });
    const controller = new AbortController();
    const waiting = acquireRenderSlotForStudio({}, controller.signal, { limit: 1, dir, pollMs: 5 });
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(liveRenderSlots(dir)).toHaveLength(1);
    first.release();
  });
});
