import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asS3Client, FakeS3 } from "./__fixtures__/fakeS3.js";
import { downloadRenderOutput } from "./downloadRenderOutput.js";

describe("downloadRenderOutput", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hf-download-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the output object to the destination, creating parent folders", async () => {
    const s3 = new FakeS3();
    s3.existing.add("bucket/renders/abc/output.mp4");
    s3.bodies.set("bucket/renders/abc/output.mp4", Buffer.from("video-bytes"));
    const dest = join(dir, "nested", "ad-01.mp4");

    const written = await downloadRenderOutput({
      s3Uri: "s3://bucket/renders/abc/output.mp4",
      destPath: dest,
      region: "us-east-1",
      s3: asS3Client(s3),
    });

    expect(written).toBe(dest);
    expect(readFileSync(dest, "utf8")).toBe("video-bytes");
    expect(readdirSync(join(dir, "nested"))).toEqual(["ad-01.mp4"]);
  });

  it("leaves nothing behind when the object is missing", async () => {
    const dest = join(dir, "ad-02.mp4");
    await expect(
      downloadRenderOutput({
        s3Uri: "s3://bucket/renders/missing/output.mp4",
        destPath: dest,
        region: "us-east-1",
        s3: asS3Client(new FakeS3()),
      }),
    ).rejects.toThrow("NoSuchKey");
    expect(readdirSync(dir)).toEqual([]);
  });
});
