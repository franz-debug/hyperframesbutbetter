// A small Markdown view for chat replies. Builds DOM nodes, so reply text can never become markup.

function addInline(parent: HTMLElement, text: string): void {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > last) parent.append(text.slice(last, index));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    }
    last = index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function block<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  addInline(element, text);
  return element;
}

/** Shows a picture Claude points at, such as a storyboard still, if it's in a project. */
function imageBlock(path: string, alt: string, baseDir: string | null): HTMLElement {
  const full = path.startsWith("/") || !baseDir ? path : `${baseDir}/${path}`;
  const image = document.createElement("img");
  image.className = "chat-image";
  image.alt = alt;
  image.loading = "lazy";
  image.src = `bf-media://file/${encodeURIComponent(full)}`;
  return image;
}

export function renderMarkdown(
  target: HTMLElement,
  source: string,
  baseDir: string | null = null,
): void {
  target.replaceChildren();
  const lines = source.split("\n");
  let list: HTMLElement | null = null;
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) target.append(block("p", paragraph.join(" ")));
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("```")) {
      flush();
      list = null;
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) code.push(lines[i++] ?? "");
      const pre = document.createElement("pre");
      pre.textContent = code.join("\n");
      target.append(pre);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flush();
      const tag = bullet ? "UL" : "OL";
      if (list?.tagName !== tag) {
        list = document.createElement(bullet ? "ul" : "ol");
        target.append(list);
      }
      list.append(block("li", item[1] ?? ""));
      continue;
    }
    list = null;
    const picture = /^\s*!\[([^\]]*)\]\(([^)]+)\)\s*$/.exec(line);
    if (picture) {
      flush();
      // Markdown wraps a path with spaces in angle brackets.
      const path = (picture[2] ?? "").replace(/^<|>$/g, "");
      target.append(imageBlock(path, picture[1] ?? "", baseDir));
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      target.append(block("h4", heading[1] ?? ""));
    } else if (line.trim() === "") {
      flush();
    } else {
      paragraph.push(line.trim());
    }
  }
  flush();
}
