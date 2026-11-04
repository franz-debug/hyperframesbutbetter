# Skill installation and freshness

Read this reference when installing or updating skills, diagnosing unexpected skill behavior, or running HyperFrames setup in CI.

For a plugin installation, follow [plugin execution rules](plugin-installation.md); the plugin manager owns updates and every skill is bundled. The commands below apply only to standalone skills.

- **Core set, installed eagerly:** `/hyperframes`, `/hyperframes-cli`, `/hyperframes-registry` and `/media-use`.
- **On demand:** `/figma`, `/slideshow`, `/remotion-to-hyperframes` and `/reverse-any-video`, installed with `npx hyperframes skills update <name>`.

## What `init` does

`npx hyperframes init` installs the core set when it is missing and leaves every skill that is already installed as it is: it never refreshes, replaces or removes one. Updating is `npx hyperframes skills update`, run by you. Offline or rate-limited checks degrade gracefully and do not fail project scaffolding.

`--skip-skills` makes `init` leave skills alone. `HYPERFRAMES_SKIP_SKILLS=1` does the same for CI and tests.

`HYPERFRAMES_SKIP_SKILLS=1` also makes `skills update` (bare or named) and bare `skills` exit 0 without installing, so an install pinned to one commit stays pinned.

## Stale-skills notice

After `render`, `lint` and `validate`, the CLI prints `N HyperFrames skills out of date or missing` to stderr when the cached check finds stale skills, so an agent run without a terminal sees it too. It is off in CI, in dev, with `HYPERFRAMES_NO_UPDATE_CHECK=1` and with `HYPERFRAMES_SKIP_SKILLS=1`, and runs with `--json` too, since it only writes stderr and leaves `--json` stdout untouched.

## Diagnose and update

```bash
npx hyperframes skills check
npx hyperframes skills check --json
npx hyperframes skills update
npx hyperframes skills update <name>
npx hyperframes skills
```

- `skills check` exits non-zero when an installed skill is stale or the core set is incomplete. Skills available on demand but not installed are not failures.
- Bare `skills update` refreshes the core set and the HyperFrames skills already installed. It never removes a skill, and it leaves a skill the install record attributes to another publisher alone, even when the name matches one of ours.
- Named `skills update <name...>` also installs those named skills.
- Bare `skills` installs the full published set explicitly.

If the HyperFrames CLI is unavailable, use `npx skills add heygen-com/hyperframes --skill <name>` for one skill or `npx skills add heygen-com/hyperframes --all` for the full published set.

The CLI may print a one-line stale-skill reminder during `render`, `lint`, or `check`. Treat a failed update as a visible tool failure; do not continue from a remembered skill.

## Keep the project's CLI current

A project scaffolded by `hyperframes init` calls `hyperframes <command>` in its `package.json` scripts, so it runs whichever build is on PATH and has no pin to advance. A CLI update can change how an older project renders, so run `hyperframes check` before re-rendering one.

A project from the desktop app or an older CLI may still have scripts in the form `npx --yes hyperframes@<version> <command>`, which fetch that release from npm instead of using the local build. Never run those scripts. When resuming such a project, replace each one with `hyperframes <command>` before the first render-affecting command, then verify with `hyperframes check`. Do not use `upgrade --project` for this, even when the CLI suggests it (the stderr notice `This project pins hyperframes@… (latest …)`): it moves the pin to the latest npm release instead of removing it.

A passing check confirms the project's compositions still validate on the local build, not that rendered output is frame-identical to the old pin, so the change is never silent: name the old pin and the local version in the run's summary. A project with no composition yet needs no verification. If the check fails, revert the `package.json` change, do not fall back to the pinned script, and report the failure and the version the project was pinned to.
