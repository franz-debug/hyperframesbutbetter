import { h } from "./dom";
import type { CaptionStyle } from "../shared/types";

/** Caption styles from this repo's registry. Choosing one adds it to the next chat message. */
export function captionsPanel(onPick: (style: CaptionStyle) => void): HTMLElement {
  const grid = h("div", { class: "caption-grid" });
  const root = h(
    "aside",
    { class: "side-panel" },
    h("h3", {}, "Captions"),
    h("p", { class: "batch-note" }, "Click one to use it in the chat, then say where it goes."),
    grid,
  );
  void window.app.captionStyles().then((styles) => {
    grid.replaceChildren(
      ...styles.map((style) => {
        const preview = document.createElement("video");
        preview.muted = true;
        preview.loop = true;
        preview.playsInline = true;
        preview.preload = "none";
        if (style.preview) preview.src = style.preview;
        const card = h(
          "button",
          { class: "caption-card", title: style.description, onClick: () => onPick(style) },
          preview,
          h("span", { class: "tile-name" }, style.title),
        );
        card.addEventListener("mouseenter", () => void preview.play().catch(() => {}));
        card.addEventListener("mouseleave", () => preview.pause());
        return card;
      }),
    );
    if (styles.length === 0)
      grid.replaceChildren(h("p", { class: "empty" }, "No caption styles found."));
  });
  return root;
}
