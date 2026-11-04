import { askText, h } from "./dom";
import type { ScriptWord } from "../shared/types";

const FILLERS = new Set(["um", "uh", "umm", "uhh", "er", "ah", "hmm", "mm"]);

const clean = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** Filler words and a word said twice in a row: what the "suggested cuts" button offers. */
function suggestedCuts(words: ScriptWord[], cut: Set<number>): number[] {
  const found: number[] = [];
  words.forEach((word, index) => {
    if (cut.has(index)) return;
    const text = clean(word.text);
    const repeated = index > 0 && text.length > 0 && clean(words[index - 1]?.text ?? "") === text;
    if (FILLERS.has(text) || repeated) found.push(index);
  });
  return found;
}

const clock = (seconds: number): string => {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/**
 * Every spoken word as text, from the transcript made at import. Selecting words and choosing an
 * action adds a row to Pending video edits; Claude applies them when they're sent.
 */
export function scriptPanel(dir: string): HTMLElement {
  const root = h("aside", { class: "side-panel" }, h("h3", {}, "Script"));
  const body = h("div", { class: "script-body" });
  const bar = h("div", { class: "script-bar" });
  root.append(bar, body);
  let words: ScriptWord[] = [];
  let cut = new Set<number>();
  let anchor: number | null = null;
  let selected: [number, number] | null = null;

  const selectedText = (): string =>
    selected
      ? words
          .slice(selected[0], selected[1] + 1)
          .map((word) => word.text)
          .join(" ")
      : "";

  const where = (): string => {
    if (!selected) return "";
    const from = words[selected[0]]?.start ?? 0;
    const to = words[selected[1]]?.end ?? from;
    return `The words "${selectedText()}", spoken from ${from.toFixed(2)}s to ${to.toFixed(2)}s in the raw footage's transcript.`;
  };

  const stage = async (note: string, detail: string) => {
    await window.app.pendingAdd(dir, { kind: "script", note, detail });
  };

  const saveCuts = () => void window.app.setScriptCut(dir, [...cut]);

  const action = (label: string, run: () => void | Promise<void>) =>
    h("button", { class: "ghost", onClick: () => void run() }, label);

  const paintBar = () => {
    if (!selected) {
      const suggestions = suggestedCuts(words, cut);
      bar.replaceChildren(
        ...(suggestions.length > 0
          ? [
              h(
                "button",
                {
                  class: "ghost",
                  title: "Filler words and words said twice in a row",
                  onClick: () => {
                    const list = suggestions.map(
                      (index) => `"${words[index]?.text}" at ${words[index]?.start.toFixed(2)}s`,
                    );
                    suggestions.forEach((index) => cut.add(index));
                    saveCuts();
                    void stage(
                      `Cut ${suggestions.length} filler or repeated words`,
                      `Cut these from the edit: ${list.join(", ")}.`,
                    );
                    paint();
                  },
                },
                `Cut ${suggestions.length} suggested`,
              ),
            ]
          : [h("span", { class: "count" }, "Click a word, then shift-click another.")]),
      );
      return;
    }
    const [from, to] = selected;
    const indexes = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    const allCut = indexes.every((index) => cut.has(index));
    bar.replaceChildren(
      allCut
        ? action("Restore", () => {
            indexes.forEach((index) => cut.delete(index));
            saveCuts();
            void stage(`Restore "${selectedText()}"`, `${where()} Put these back in the edit.`);
            selected = null;
            paint();
          })
        : action("Cut", () => {
            indexes.forEach((index) => cut.add(index));
            saveCuts();
            void stage(
              `Cut "${selectedText()}"`,
              `${where()} Cut them from the edit and close the gap.`,
            );
            selected = null;
            paint();
          }),
      action("Comment", async () => {
        const note = await askText("A note about these words");
        if (note) await stage(`"${selectedText()}": ${note}`, where());
      }),
      action("Fix words", async () => {
        const fixed = await askText("What was actually said?", selectedText());
        if (fixed) {
          await stage(
            `Fix "${selectedText()}" to "${fixed}"`,
            `${where()} The transcript misheard these. They should read "${fixed}" in captions and on screen. The audio stays the same.`,
          );
        }
      }),
      action("Zoom in", () =>
        stage(`Zoom in on "${selectedText()}"`, `${where()} Add a subtle punch-in on these words.`),
      ),
      action("B-roll", async () => {
        const idea = await askText("What should the B-roll show?");
        if (idea) await stage(`B-roll on "${selectedText()}": ${idea}`, where());
      }),
      action("Title card", async () => {
        const title = await askText("What should the title card say?", selectedText());
        if (title) await stage(`Title card on "${selectedText()}": ${title}`, where());
      }),
      action("Ask", async () => {
        const question = await askText("What do you want to ask about these words?");
        if (question) {
          await window.app.chatSend(
            dir,
            `${where()} ${question}`,
            `"${selectedText()}": ${question}`,
          );
        }
      }),
    );
  };

  const paint = () => {
    body.replaceChildren(
      ...words.flatMap((word, index) => {
        const isSelected = selected && index >= selected[0] && index <= selected[1];
        const span = h(
          "span",
          {
            class: `word${cut.has(index) ? " cut" : ""}${isSelected ? " picked" : ""}`,
            title: clock(word.start),
            onClick: (event) => {
              if (event.shiftKey && anchor !== null) {
                selected = [Math.min(anchor, index), Math.max(anchor, index)];
              } else {
                anchor = index;
                selected = [index, index];
              }
              paint();
            },
          },
          word.text,
        );
        return [span, " "];
      }),
    );
    if (words.length === 0) {
      body.replaceChildren(
        h(
          "p",
          { class: "empty" },
          "No transcript in this project yet. Ask Claude to transcribe it: it runs `hyperframes transcribe`.",
        ),
      );
    }
    paintBar();
  };

  void window.app.scriptData(dir).then((data) => {
    words = data.words;
    cut = new Set(data.cut);
    paint();
  });
  return root;
}
