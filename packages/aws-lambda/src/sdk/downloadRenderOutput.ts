/**
 * Copy a finished render's output from S3 to a local file.
 *
 * The object lands at a temporary sibling path first and is renamed into
 * place only once the whole body has arrived, so a dropped connection never
 * leaves a truncated video where the caller expects a finished one.
 */

import { renameSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { downloadS3ObjectToFile } from "../s3Transport.js";

export interface DownloadRenderOutputOptions {
  /** `s3://bucket/key` of the finished output (`RenderProgress.outputFile.s3Uri`). */
  s3Uri: string;
  /** Local file path to write. Parent directories are created. */
  destPath: string;
  region: string;
  /** Injected for tests; defaults to a client for `region`. */
  s3?: S3Client;
}

export async function downloadRenderOutput(opts: DownloadRenderOutputOptions): Promise<string> {
  const client = opts.s3 ?? new S3Client({ region: opts.region });
  const partial = join(
    dirname(opts.destPath),
    `.${basename(opts.destPath)}.${process.pid}.${Date.now()}.part`,
  );
  try {
    await downloadS3ObjectToFile(client, opts.s3Uri, partial);
    renameSync(partial, opts.destPath);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return opts.destPath;
}
