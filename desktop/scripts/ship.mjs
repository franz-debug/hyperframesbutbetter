// `bun run ship`: rebuild the engine if its source changed, package the app, install it in
// /Applications and restart it. Pass --no-open to install without relaunching.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build as packageApp } from "electron-builder";
import sharp from "sharp";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const brand = JSON.parse(readFileSync(join(root, "brand.json"), "utf8"));
const relaunch = !process.argv.includes("--no-open");
const target = `/Applications/${brand.name}.app`;
const lastInstallFile = join(root, "release", "last-install.json");

const step = (message) => console.log(`\n▸ ${message}`);

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(path));
    else if (!/\.test\.tsx?$/.test(entry.name)) newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}

function rebuildEngineIfChanged() {
  const builtAt = statSync(join(repo, "packages/cli/dist/cli.js")).mtimeMs;
  const packages = readdirSync(join(repo, "packages"));
  const changed = packages.some((name) => {
    const src = join(repo, "packages", name, "src");
    return existsSync(src) && newestMtime(src) > builtAt;
  });
  if (!changed) return console.log("Engine unchanged, skipping its rebuild.");
  step("Engine source changed, rebuilding it");
  execFileSync("bun", ["run", "build"], { cwd: repo, stdio: "inherit" });
}

async function makeIcon() {
  const buildDir = join(root, "build");
  const iconset = join(buildDir, "icon.iconset");
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  const svg = readFileSync(join(root, brand.logo));
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const suffix = scale === 2 ? "@2x" : "";
      const px = size * scale;
      await sharp(svg, { density: 300 })
        .resize(px, px)
        .png()
        .toFile(join(iconset, `icon_${size}x${size}${suffix}.png`));
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(buildDir, "icon.icns")]);
}

function signingIdentity() {
  const found = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
  }).stdout;
  return found?.includes("Developer ID Application") ? undefined : "-";
}

function bundleId(appPath) {
  const plist = join(appPath, "Contents/Info.plist");
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist], {
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Only ever replaces an app this project installed: anything else at that path stops the ship. */
function assertReplaceable(appPath, appIds) {
  if (!existsSync(appPath)) return;
  const id = bundleId(appPath);
  if (!appIds.includes(id)) {
    throw new Error(`${appPath} is a different app (${id}). Not replacing it.`);
  }
}

function installAndRestart(built) {
  const last = existsSync(lastInstallFile)
    ? JSON.parse(readFileSync(lastInstallFile, "utf8"))
    : null;
  const appIds = [brand.appId, ...(last?.appId ? [last.appId] : [])];
  assertReplaceable(target, appIds);
  const previous = last?.target && last.target !== target ? last.target : "";
  if (previous) assertReplaceable(previous, appIds);
  writeFileSync(lastInstallFile, JSON.stringify({ target, appId: brand.appId }));

  // Runs on its own so it survives the app quitting, even when the app's own chat started this.
  const script = join(root, "release", "swap.sh");
  writeFileSync(
    script,
    `#!/bin/sh
NEW="$1"; TARGET="$2"; PREVIOUS="$3"; RELAUNCH="$4"
running() { /usr/bin/pgrep -f "$1/Contents/MacOS/" >/dev/null 2>&1; }
for APP in "$TARGET" "$PREVIOUS"; do
  [ -n "$APP" ] && /usr/bin/pkill -TERM -f "$APP/Contents/MacOS/" 2>/dev/null
done
while running "$TARGET" || { [ -n "$PREVIOUS" ] && running "$PREVIOUS"; }; do /bin/sleep 1; done
[ -n "$PREVIOUS" ] && /bin/rm -rf "$PREVIOUS"
/bin/rm -rf "$TARGET"
/usr/bin/ditto "$NEW" "$TARGET"
[ "$RELAUNCH" = "yes" ] && /usr/bin/open "$TARGET"
echo "installed $TARGET"
`,
    { mode: 0o755 },
  );
  const log = openSync(join(root, "release", "swap.log"), "w");
  spawn("/bin/sh", [script, built, target, previous, relaunch ? "yes" : "no"], {
    detached: true,
    stdio: ["ignore", log, log],
  }).unref();
}

rebuildEngineIfChanged();

step("Building the app");
execFileSync("node", [join(root, "scripts/build.mjs")], { stdio: "inherit" });
await makeIcon();

step("Packaging");
await packageApp({
  targets: Platform.MAC.createTarget("dir", Arch.arm64),
  projectDir: root,
  config: {
    appId: brand.appId,
    productName: brand.name,
    directories: { output: "release", buildResources: "build" },
    files: ["dist/**", "package.json"],
    asar: true,
    npmRebuild: false,
    mac: {
      icon: "build/icon.icns",
      category: "public.app-category.video",
      identity: signingIdentity(),
      hardenedRuntime: false,
      gatekeeperAssess: false,
    },
  },
});

const built = join(root, "release", "mac-arm64", `${brand.name}.app`);
if (!existsSync(built)) throw new Error(`Packaging finished but ${built} is missing.`);

step(relaunch ? `Installing to ${target} and restarting` : `Installing to ${target}`);
installAndRestart(built);
console.log(`Done. ${brand.name} restarts by itself once it has quit.`);
