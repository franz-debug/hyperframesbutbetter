// Compiles the app into dist/. `bun run ship` calls this, then packages and installs the result.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const brand = JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "renderer"), { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  logLevel: "warning",
  loader: { ".svg": "text" },
};

await build({
  ...common,
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: ["src/editor-preload.ts"],
  outfile: "dist/editor-preload.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await build({
  ...common,
  entryPoints: { app: "src/renderer/app.ts" },
  outdir: "dist/renderer",
  platform: "browser",
  format: "iife",
  target: "chrome130",
});

for (const file of ["app.html", "styles.css"]) {
  copyFileSync(join(root, "src/renderer", file), join(dist, "renderer", file));
}
copyFileSync(join(root, brand.logo), join(dist, "renderer", "logo.svg"));

const c = brand.colors;
writeFileSync(
  join(dist, "renderer", "brand.css"),
  `:root {
  --accent: ${c.accent};
  --accent-hover: ${c.accentHover};
  --on-accent: ${c.onAccent};
  --gradient-from: ${c.gradientFrom};
  --gradient-to: ${c.gradientTo};
  --bg: ${c.background};
  --surface: ${c.surface};
  --raised: ${c.surfaceRaised};
  --border: ${c.border};
  --text: ${c.text};
  --muted: ${c.textMuted};
}
`,
);

const repoDir = resolve(root, "..");
let commit = "unknown";
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir })
    .toString()
    .trim();
} catch {
  /* a build outside git still works */
}
writeFileSync(
  join(dist, "build-info.json"),
  JSON.stringify({ repoDir, commit, builtAt: new Date().toISOString() }, null, 2),
);
