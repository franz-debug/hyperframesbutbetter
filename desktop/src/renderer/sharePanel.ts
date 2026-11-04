import { h } from "./dom";

/** Makes a link to a project with `hyperframes publish`. It uploads the project, so it asks first. */
export async function openShareDialog(dir: string): Promise<void> {
  const existing = await window.app.shareLink(dir);
  const dialog = document.createElement("dialog");
  dialog.className = "ask";
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  const body = h("div", {});
  const showLink = (url: string, note: string) => {
    const link = document.createElement("input");
    link.className = "share-link";
    link.readOnly = true;
    link.value = url;
    link.setAttribute("aria-label", "Share link");
    body.replaceChildren(
      h("p", { class: "export-note" }, note),
      link,
      h(
        "div",
        { class: "ask-row" },
        h("button", { class: "ghost", onClick: close }, "Close"),
        h("button", { class: "ghost", onClick: () => void publish() }, "Send new version"),
        h(
          "button",
          { class: "primary", onClick: () => void window.app.copyText(url) },
          "Copy link",
        ),
      ),
    );
  };
  const publish = async () => {
    body.replaceChildren(h("p", { class: "export-note" }, "Uploading the project…"));
    try {
      showLink(
        await window.app.shareProject(dir),
        "Your link is ready. It's private to you until you share it.",
      );
    } catch (failure) {
      body.replaceChildren(
        h(
          "p",
          { class: "make-error" },
          failure instanceof Error ? failure.message : String(failure),
        ),
        h("p", { class: "export-note" }, "Sharing needs a HeyGen account: connect it in Settings."),
        h("div", { class: "ask-row" }, h("button", { class: "ghost", onClick: close }, "Close")),
      );
    }
  };
  if (existing) {
    showLink(existing, "This project already has a link.");
  } else {
    body.replaceChildren(
      h(
        "p",
        { class: "export-note" },
        "This uploads the project to HeyGen and gives you a link to it.",
      ),
      h(
        "div",
        { class: "ask-row" },
        h("button", { class: "ghost", onClick: close }, "Cancel"),
        h("button", { class: "primary", onClick: () => void publish() }, "Upload and get link"),
      ),
    );
  }
  dialog.append(h("h3", { class: "export-title" }, "Share"), body);
  document.body.append(dialog);
  dialog.showModal();
}
