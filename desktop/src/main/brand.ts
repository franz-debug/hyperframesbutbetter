import { homedir } from "node:os";
import { join, resolve } from "node:path";
import brandJson from "../../brand.json";
import logoSvg from "../../assets/logo.svg";
import buildInfoPlaceholder from "./buildInfo";

export const brand = brandJson;

/** The repo this app was built from; its CLI build and skills are what the app runs. */
export const repoDir = buildInfoPlaceholder().repoDir;

export function projectsRoot(): string {
  const configured = process.env.BETTER_FRAMES_PROJECTS_DIR || brand.projectsDir;
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : resolve(configured);
}

/** Puts the brand on the open-source editor without editing its source, so upstream merges stay clean. */
export function editorCss(): string {
  const c = brand.colors;
  const logo = Buffer.from(logoSvg).toString("base64");
  return `
html:root {
  --color-accent: ${c.accent};
  --color-accent-hover: ${c.accentHover};
  --color-on-accent: ${c.onAccent};
  --color-accent-ink: ${c.accent};
  --color-brand-gradient-from: ${c.gradientFrom};
  --color-brand-gradient-to: ${c.gradientTo};
}
svg[aria-label="Hyperframes"] { display: none !important; }
div:has(> svg[aria-label="Hyperframes"])::before {
  content: "";
  display: block;
  width: 24px;
  height: 24px;
  background: url("data:image/svg+xml;base64,${logo}") center / contain no-repeat;
}
`;
}
