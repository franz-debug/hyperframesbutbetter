// Runs in the embedded editor before its own scripts. Its "describe a change" box and its Export
// button go to this app, and it gets the Draw and Comment tools on top of the picture.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hyperframesHostAgent", {
  send: (prompt: string, instruction: string): boolean => {
    ipcRenderer.send("editor:ask-agent", prompt, instruction);
    return true;
  },
});

document.addEventListener(
  "click",
  (event) => {
    const target = event.target;
    const button = target instanceof Element ? target.closest("button") : null;
    if (button?.textContent?.trim() !== "Export") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ipcRenderer.send("editor:export");
  },
  true,
);

type Tool = "select" | "draw" | "comment";

const css = (element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void => {
  Object.assign(element.style, styles);
};

function currentTime(): string {
  const candidates = [...document.querySelectorAll("span, div")].filter(
    (element) =>
      element.children.length === 0 &&
      /^\d\d:\d\d(\.\d+)?$/.test(element.textContent?.trim() ?? ""),
  );
  return candidates[0]?.textContent?.trim() ?? "00:00";
}

function installMarkup(): void {
  let tool: Tool = "select";
  let strokes: { x: number; y: number }[][] = [];

  const bar = document.createElement("div");
  css(bar, {
    position: "fixed",
    zIndex: "2147483000",
    display: "flex",
    gap: "2px",
    padding: "3px",
    borderRadius: "9px",
    background: "rgba(28,26,23,0.92)",
    font: "12px -apple-system, sans-serif",
  });
  const buttons = new Map<Tool, HTMLButtonElement>();
  for (const [name, label] of [
    ["select", "Select"],
    ["draw", "Draw"],
    ["comment", "Comment"],
  ] as const) {
    const button = document.createElement("button");
    button.textContent = label;
    button.title = `${label} (${label.charAt(0)})`;
    button.dataset.bfTool = name;
    css(button, {
      padding: "3px 9px",
      border: "none",
      borderRadius: "6px",
      color: "#fff",
      background: "transparent",
      cursor: "pointer",
      font: "inherit",
    });
    button.addEventListener("click", () => setTool(name));
    buttons.set(name, button);
    bar.append(button);
  }

  const layer = document.createElement("canvas");
  css(layer, { position: "fixed", zIndex: "2147482999", display: "none", cursor: "crosshair" });

  const pin = document.createElement("div");
  css(pin, {
    position: "fixed",
    zIndex: "2147483001",
    display: "none",
    pointerEvents: "none",
    width: "14px",
    height: "14px",
    margin: "-7px 0 0 -7px",
    borderRadius: "50%",
    background: "#ff3b30",
    border: "2px solid #fff",
    boxShadow: "0 1px 4px rgba(0,0,0,.5)",
  });

  const box = document.createElement("form");
  css(box, {
    position: "fixed",
    zIndex: "2147483002",
    display: "none",
    gap: "6px",
    padding: "8px",
    width: "280px",
    borderRadius: "10px",
    background: "#fff",
    color: "#1c1a17",
    boxShadow: "0 6px 24px rgba(0,0,0,.3)",
    font: "13px -apple-system, sans-serif",
  });
  const input = document.createElement("input");
  input.placeholder = "What should change here?";
  input.dataset.bfNote = "1";
  css(input, { flex: "1", minWidth: "0", border: "none", outline: "none", font: "inherit" });
  const add = document.createElement("button");
  add.textContent = "Add";
  css(add, {
    border: "none",
    borderRadius: "7px",
    padding: "4px 10px",
    background: "var(--color-accent, #0e7f5f)",
    color: "#fff",
    cursor: "pointer",
    font: "inherit",
  });
  box.append(input, add);

  document.documentElement.append(layer, pin, box, bar);

  const picture = (): DOMRect | null =>
    document.querySelector("hyperframes-player")?.getBoundingClientRect() ?? null;

  const place = () => {
    const rect = picture();
    bar.style.display = rect && rect.width > 0 ? "flex" : "none";
    if (!rect) return;
    css(bar, { left: `${rect.left}px`, top: `${Math.max(4, rect.top - 32)}px` });
    if (tool !== "select") {
      css(layer, {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      if (layer.width !== Math.round(rect.width) || layer.height !== Math.round(rect.height)) {
        layer.width = Math.round(rect.width);
        layer.height = Math.round(rect.height);
        paint();
      }
    }
  };

  const paint = () => {
    const context = layer.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, layer.width, layer.height);
    context.strokeStyle = "#ff3b30";
    context.lineWidth = 4;
    context.lineCap = "round";
    context.lineJoin = "round";
    for (const stroke of strokes) {
      context.beginPath();
      stroke.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      });
      context.stroke();
    }
  };

  const reset = () => {
    strokes = [];
    paint();
    pin.style.display = "none";
    box.style.display = "none";
    input.value = "";
  };

  function setTool(next: Tool): void {
    tool = next;
    reset();
    for (const [name, button] of buttons) {
      button.style.background = name === next ? "rgba(255,255,255,.22)" : "transparent";
    }
    layer.style.display = next === "select" ? "none" : "block";
    layer.style.cursor = next === "comment" ? "cell" : "crosshair";
    place();
  }

  const askAt = (x: number, y: number) => {
    css(box, {
      display: "flex",
      left: `${Math.min(x + 12, window.innerWidth - 300)}px`,
      top: `${Math.min(y + 12, window.innerHeight - 60)}px`,
    });
    input.focus();
  };

  layer.addEventListener("pointerdown", (event) => {
    const rect = layer.getBoundingClientRect();
    const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (tool === "comment") {
      css(pin, { display: "block", left: `${event.clientX}px`, top: `${event.clientY}px` });
      return;
    }
    layer.setPointerCapture(event.pointerId);
    strokes.push([point]);
    paint();
  });
  layer.addEventListener("pointermove", (event) => {
    if (tool !== "draw" || !layer.hasPointerCapture(event.pointerId)) return;
    const rect = layer.getBoundingClientRect();
    strokes[strokes.length - 1]?.push({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
    paint();
  });
  // Asks on release: focusing the note on press would lose it to the mouse-down that follows.
  layer.addEventListener("pointerup", (event) => {
    askAt(event.clientX, event.clientY);
  });

  const pinWhere = (rect: DOMRect): string => {
    const across = Math.round(((parseFloat(pin.style.left) - rect.left) / rect.width) * 100);
    const down = Math.round(((parseFloat(pin.style.top) - rect.top) / rect.height) * 100);
    return `${across}% across and ${down}% down the frame`;
  };

  box.addEventListener("submit", (event) => {
    event.preventDefault();
    const note = input.value.trim();
    const rect = picture();
    if (!note || !rect || tool === "select") return;
    box.style.display = "none";
    const margin = 2;
    void ipcRenderer
      .invoke("editor:annotate", {
        kind: tool,
        note,
        time: currentTime(),
        where: pinWhere(rect),
        rect: {
          x: Math.max(0, Math.round(rect.left - margin)),
          y: Math.max(0, Math.round(rect.top - margin)),
          width: Math.round(rect.width + margin * 2),
          height: Math.round(rect.height + margin * 2),
        },
      })
      .finally(reset);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "Escape" && tool !== "select") {
        setTool("select");
        event.stopImmediatePropagation();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "d" || key === "c") {
        setTool(key === "d" ? "draw" : "comment");
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );

  setInterval(place, 400);
  setTool("select");
}

window.addEventListener("DOMContentLoaded", installMarkup);
