# Better Frames desktop app

A personal Mac app around the open-source HyperFrames editor. Everything here is a thin shell: the editor, renderer and CLI come from this repo's `packages/`, run through the `hyperframes` command.

## Ship a change

```bash
bun run ship
```

Run it from `desktop/`. It rebuilds the engine if `packages/` changed, packages the app, installs it to `/Applications` and restarts it. Run `bun run typecheck` first. To try a change without installing, use `bun run dev`.

## Where things are

- `brand.json`: name, app id, tagline, colors, logo path, and the folder projects live in. Renaming here renames the installed app on the next ship.
- `assets/logo.svg`: the logo. The Dock icon is generated from it.
- `src/main/index.ts`: the window, menu, the single embedded editor, and how a Make request becomes projects and jobs.
- `src/main/queue.ts`: runs import, edit and render jobs. `queueCore.ts` holds the rules (one at a time, order, failures) and is tested by `queueCore.test.ts`; run it with `bun test`.
- `src/main/library.ts`: folders, pins and archive, stored in `library.json` under the app's data folder. It never deletes videos.
- `src/main/chat.ts`: the Claude chats (project, folder Director, this app): what each may run and its instructions.
- `src/main/preview.ts`: starts and stops the one `hyperframes preview` behind the editor.
- `src/main/brand.ts`: `editorCss()` puts the brand on the embedded editor. Prefer this over editing `packages/studio`, so merges from upstream stay clean.
- `src/main/pending.ts`: marks from the picture and Script panel wait here until sent together.
- `src/main/brandKits.ts`: brand kits, and copying a kit into a project's `assets/brand-kit`.
- `src/main/projectData.ts`: chat menu data, caption styles, transcripts, run undo.
- `src/main/settings.ts`: model, effort, access, default export choices.
- `src/editor-preload.ts`: runs inside the embedded editor. Draw and Comment live here, and it reroutes the editor's Export button.
- `src/renderer/`: the UI. `app.ts` holds the sidebar and main screens, `make.ts` the Make box, `chatPanel.ts` the chat and its @ # / menus, `exportPanel.ts`, `scriptPanel.ts`, `captionsPanel.ts`, `brandView.ts`, `settingsView.ts`, `sharePanel.ts`, `jobs.ts` the queue list, `styles.css` all styling.

## How it stays light

- One editor at a time: opening a project closes the last one, and leaving a project frees its memory after a minute.
- One job at a time: imports, then each edit. Exports the person adds go ahead of edits still waiting, but never interrupt one. It waits if macOS reports critical memory pressure, and keeps the Mac awake while working.
- Nothing exports by itself unless the person ticks that box: they review, then add videos to the export queue.
- Claude never renders by itself: it runs `bf-render <folder>`, which adds to the queue.

To try a change on test data, set `BETTER_FRAMES_USER_DATA` and `BETTER_FRAMES_PROJECTS_DIR` before `bun run dev`, so your real folders and queue stay untouched.

## Rules

- This folder is not part of the bun workspace: it has its own `bun.lock`. Run `bun install` here.
- Call `hyperframes`, never `npx hyperframes`.
- Never use HeyGen's or HyperFrames' name or logos as this app's brand. Keep the Apache-2.0 credit in the About panel.
