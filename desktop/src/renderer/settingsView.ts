import { h } from "./dom";
import type { Settings } from "../shared/types";

function select(
  label: string,
  note: string,
  options: { value: string; label: string }[],
  current: string,
  onChange: (value: string) => void,
): HTMLElement {
  const element = document.createElement("select");
  element.className = "chat-select";
  element.setAttribute("aria-label", label);
  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    element.append(option);
  }
  element.value = current;
  element.addEventListener("change", () => onChange(element.value));
  return h(
    "div",
    { class: "setting" },
    h(
      "div",
      {},
      h("div", { class: "setting-label" }, label),
      h("p", { class: "batch-note" }, note),
    ),
    element,
  );
}

function heygenSection(): HTMLElement {
  const section = h("section", { class: "setting-group" }, h("h3", {}, "HeyGen"));
  const body = h("div", {});
  section.append(
    h(
      "p",
      { class: "batch-note" },
      "Needed for HeyGen voices, avatars and generated video, cloud rendering and share links. Everything else works without it.",
    ),
    body,
  );
  const paint = (status: { signedIn: boolean; detail: string }, message = "") => {
    const key = document.createElement("input");
    key.type = "password";
    key.placeholder = "Paste a HeyGen API key";
    key.autocomplete = "off";
    key.setAttribute("aria-label", "HeyGen API key");
    body.replaceChildren(
      h("div", { class: "setting" }, h("div", { class: "setting-label" }, status.detail)),
      message ? h("p", { class: "make-error" }, message) : "",
      status.signedIn
        ? h(
            "button",
            {
              class: "ghost",
              onClick: () => void window.app.heygenSignOut().then((next) => paint(next)),
            },
            "Disconnect",
          )
        : h(
            "div",
            { class: "setting-actions" },
            h(
              "button",
              {
                class: "primary",
                onClick: () => {
                  void window.app
                    .heygenSignIn()
                    .then((next) => paint(next, next.signedIn ? "" : "Sign-in didn't finish."));
                },
              },
              "Sign in with HeyGen",
            ),
            key,
            h(
              "button",
              {
                class: "ghost",
                onClick: () => {
                  const value = key.value.trim();
                  key.value = "";
                  if (value) {
                    void window.app
                      .heygenUseKey(value)
                      .then((next) => paint(next, next.signedIn ? "" : "That key didn't work."));
                  }
                },
              },
              "Use key",
            ),
          ),
    );
  };
  void window.app.heygenStatus().then((status) => paint(status));
  return section;
}

export function settingsView(): HTMLElement {
  const groups = h("div", {});
  const update = (patch: Partial<Settings>) => void window.app.updateSettings(patch);
  void window.app.settings().then((settings) => {
    groups.replaceChildren(
      h(
        "section",
        { class: "setting-group" },
        h("h3", {}, "Claude"),
        select(
          "Model",
          "Used from your next request.",
          [
            { value: "default", label: "Claude Code's default" },
            { value: "opus", label: "Opus" },
            { value: "fable", label: "Fable" },
            { value: "sonnet", label: "Sonnet" },
            { value: "haiku", label: "Haiku" },
          ],
          settings.model,
          (model) => update({ model }),
        ),
        select(
          "Effort",
          "Higher takes longer and uses more of your plan.",
          ["default", "low", "medium", "high", "xhigh", "max"].map((value) => ({
            value,
            label: value === "default" ? "Default" : value,
          })),
          settings.effort,
          (effort) => update({ effort }),
        ),
        select(
          "Access",
          "Auto lets Claude work in your project and run a fixed list of commands. Full access lets it install and run anything, with no checks.",
          [
            { value: "auto", label: "Auto" },
            { value: "full", label: "Full access" },
          ],
          settings.access,
          (access) => update({ access: access === "full" ? "full" : "auto" }),
        ),
        select(
          "While Claude works, Enter",
          "Control-Enter does the other one.",
          [
            { value: "steer", label: "Stops it and starts on your message" },
            { value: "queue", label: "Queues your message to run next" },
          ],
          settings.whileBusy,
          (whileBusy) => update({ whileBusy: whileBusy === "queue" ? "queue" : "steer" }),
        ),
      ),
      heygenSection(),
    );
  });
  return h("div", { class: "page" }, h("h1", { class: "page-title" }, "Settings"), groups);
}
