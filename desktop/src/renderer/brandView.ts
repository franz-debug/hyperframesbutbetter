import { askText, h } from "./dom";
import type { BrandKit } from "../shared/types";

const ROLES = ["Main", "Secondary", "Accent", "Text", "Background", "Neutral"];

function kitEditor(kit: BrandKit, onBack: () => void): HTMLElement {
  const root = h("div", {});
  const save = () => void window.app.brandKitSave(kit);

  const paint = () => {
    const name = document.createElement("input");
    name.value = kit.name;
    name.className = "kit-name";
    name.setAttribute("aria-label", "Kit name");
    name.addEventListener("change", () => {
      kit.name = name.value.trim() || kit.name;
      save();
    });

    const site = document.createElement("input");
    site.value = kit.site;
    site.placeholder = "yoursite.com";
    site.setAttribute("aria-label", "Website");
    site.addEventListener("change", () => {
      kit.site = site.value.trim();
      save();
    });

    const status = h("span", { class: "count" });
    const scan = h(
      "button",
      {
        class: "primary",
        onClick: () => {
          kit.site = site.value.trim();
          if (!kit.site) return;
          save();
          scan.disabled = true;
          status.textContent = "Claude is reading the site";
          void window.app
            .brandKitScan(kit.id)
            .catch((failure: unknown) => {
              status.textContent = failure instanceof Error ? failure.message : String(failure);
            })
            .then(() => window.app.brandKits())
            .then((kits) => {
              const fresh = kits.find((item) => item.id === kit.id);
              if (fresh) Object.assign(kit, fresh);
              paint();
            });
        },
      },
      "Scan my site",
    );

    const colors = kit.colors.map((color, index) => {
      const value = document.createElement("input");
      value.type = "color";
      value.value = /^#[0-9a-f]{6}$/i.test(color.value) ? color.value : "#000000";
      value.setAttribute("aria-label", `${color.role} color`);
      value.addEventListener("change", () => {
        color.value = value.value;
        save();
      });
      const role = document.createElement("select");
      role.className = "chat-select";
      role.setAttribute("aria-label", "Color role");
      for (const item of ROLES) {
        const option = document.createElement("option");
        option.value = item;
        option.textContent = item;
        role.append(option);
      }
      role.value = color.role;
      role.addEventListener("change", () => {
        color.role = role.value;
        save();
      });
      return h(
        "div",
        { class: "kit-color" },
        value,
        role,
        h("span", { class: "count" }, color.value),
        h(
          "button",
          {
            class: "ghost",
            onClick: () => {
              kit.colors.splice(index, 1);
              save();
              paint();
            },
          },
          "Remove",
        ),
      );
    });

    const fileList = (title: string, kind: "logos" | "fonts" | "files", note: string) => {
      const items = kit[kind].map((name, index) => {
        const preview = kind === "logos" ? document.createElement("img") : null;
        if (preview) {
          preview.alt = "";
          preview.className = "kit-logo";
          void window.app.brandKitFileUrl(kit.id, name).then((url) => {
            preview.src = url;
          });
        }
        return h(
          "div",
          { class: "kit-file" },
          preview,
          h(
            "span",
            { class: "row-name" },
            kind === "logos" && index === 0 ? `${name} (main logo)` : name,
          ),
          h(
            "button",
            {
              class: "ghost",
              onClick: () => {
                kit[kind].splice(index, 1);
                save();
                paint();
              },
            },
            "Remove",
          ),
        );
      });
      return h(
        "section",
        { class: "setting-group" },
        h("h3", {}, title),
        h("p", { class: "batch-note" }, note),
        ...items,
        h(
          "button",
          {
            class: "pill-button",
            onClick: () => {
              void window.app.brandKitAddFiles(kit.id, kind).then((fresh) => {
                if (fresh) Object.assign(kit, fresh);
                paint();
              });
            },
          },
          `Add ${title.toLowerCase()}`,
        ),
      );
    };

    const textArea = (label: string, value: string, onChange: (text: string) => void) => {
      const area = document.createElement("textarea");
      area.rows = 3;
      area.className = "kit-text";
      area.value = value;
      area.setAttribute("aria-label", label);
      area.addEventListener("change", () => {
        onChange(area.value);
        save();
      });
      return h("section", { class: "setting-group" }, h("h3", {}, label), area);
    };

    root.replaceChildren(
      h("button", { class: "ghost", onClick: onBack }, "All brand kits"),
      name,
      h("div", { class: "setting-actions" }, site, scan, status),
      h(
        "section",
        { class: "setting-group" },
        h("h3", {}, "Colors"),
        ...colors,
        h(
          "button",
          {
            class: "pill-button",
            onClick: () => {
              kit.colors.push({ role: "Main", value: "#000000" });
              save();
              paint();
            },
          },
          "Add a color",
        ),
      ),
      fileList("Logos", "logos", "The first logo leads every title and end card."),
      fileList("Fonts", "fonts", "WOFF2, WOFF, TTF or OTF."),
      fileList("Files", "files", "Screenshots, product images and audio Claude can use."),
      textArea("Text styles", kit.textStyles, (text) => {
        kit.textStyles = text;
      }),
      textArea("Rules", kit.rules, (text) => {
        kit.rules = text;
      }),
      h(
        "button",
        {
          class: "ghost",
          onClick: () => {
            void window.app.brandKitDelete(kit.id).then(onBack);
          },
        },
        "Delete this kit",
      ),
    );
  };
  paint();
  return root;
}

export function brandView(): HTMLElement {
  const root = h("div", { class: "page" }, h("h1", { class: "page-title" }, "Brand kits"));
  const body = h("div", {});
  root.append(body);

  const list = () => {
    void window.app.brandKits().then((kits) => {
      body.replaceChildren(
        h(
          "button",
          {
            class: "primary",
            onClick: () => {
              void askText("Name this brand kit").then((name) => {
                if (!name) return;
                void window.app.brandKitNew(name, "").then((kit) => open(kit));
              });
            },
          },
          "New brand kit",
        ),
        h(
          "div",
          { class: "kit-list" },
          ...kits.map((kit) =>
            h(
              "button",
              { class: "kit-card", onClick: () => open(kit) },
              h(
                "span",
                { class: "kit-swatches" },
                ...kit.colors.slice(0, 6).map((color) => {
                  const swatch = h("span", {
                    class: "swatch",
                    title: `${color.role}: ${color.value}`,
                  });
                  swatch.style.background = color.value;
                  return swatch;
                }),
              ),
              h("span", { class: "tile-name" }, kit.name),
              h("span", { class: "tile-when" }, kit.site || `${kit.logos.length} logos`),
            ),
          ),
        ),
        kits.length === 0
          ? h(
              "p",
              { class: "empty" },
              "A brand kit holds your colors, fonts, logos and rules. Pick one for a project and Claude builds every video in it.",
            )
          : "",
      );
    });
  };
  const open = (kit: BrandKit) => {
    body.replaceChildren(kitEditor(kit, list));
  };
  list();
  return root;
}
