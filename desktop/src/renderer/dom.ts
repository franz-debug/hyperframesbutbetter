type Child = Node | string | number | null | undefined | false;

interface Props {
  class?: string;
  title?: string;
  label?: string;
  hidden?: boolean;
  onClick?: (event: MouseEvent) => void;
  onContextMenu?: (event: MouseEvent) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.title) element.title = props.title;
  if (props.label) element.setAttribute("aria-label", props.label);
  if (props.hidden) element.hidden = true;
  const { onClick, onContextMenu } = props;
  if (onClick) element.addEventListener("click", (event) => onClick(event as MouseEvent));
  if (onContextMenu) {
    element.addEventListener("contextmenu", (event) => onContextMenu(event as MouseEvent));
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) {
      element.append(typeof child === "number" ? String(child) : child);
    }
  }
  return element;
}

export function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element ${id}`);
  return element;
}

const ICONS = {
  back: "M15 18l-6-6 6-6",
  forward: "M9 18l6-6-6-6",
  sidebar: "M3 5h18v14H3zM9 5v14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  plus: "M12 5v14M5 12h14",
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  queue: "M4 6h16M4 12h16M4 18h10",
  folder: "M3 6h6l2 3h10v10H3z",
  chevron: "M9 18l6-6-6-6",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  download: "M12 3v12M7 11l5 5 5-5M4 21h16",
  archive: "M3 5h18v4H3zM5 9v11h14V9M10 13h4",
  wand: "M4 20L16 8M15 4v3M18 6h3M19 11v2M13 3h2",
  close: "M6 6l12 12M18 6L6 18",
  palette:
    "M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-.5-1.5-.5-2.5S14.5 15 16 15h2a3 3 0 0 0 3-3c0-5-4-9-9-9zM7.5 11h.01M10.5 7.5h.01M15 7.5h.01",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6 8.5 4 8l-1 3 2 1v2l-2 1 1 3 2-.5L7.5 19l-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z",
} as const;

export function icon(name: keyof typeof ICONS, size = 16): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

/** "12d", "14h": how long ago, in the sidebar's short form. */
export function age(time: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

export function askText(label: string, initial = ""): Promise<string | null> {
  const dialog = byId("ask");
  const input = byId("ask-input");
  if (!(dialog instanceof HTMLDialogElement) || !(input instanceof HTMLInputElement)) {
    return Promise.resolve(null);
  }
  byId("ask-label").textContent = label;
  input.value = initial;
  dialog.returnValue = "cancel";
  dialog.showModal();
  input.select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        const text = input.value.trim();
        resolve(dialog.returnValue === "ok" && text ? text : null);
      },
      { once: true },
    );
  });
}
