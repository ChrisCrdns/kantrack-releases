# KanTrack

KanTrack is a minimal macOS menu bar task board built with Tauri v2. It is designed to feel lightweight, local, and fast: open it with a global shortcut, capture a task, move work across lanes, and get back to what you were doing.

The app favors native macOS utility behavior over a heavy desktop-window workflow. It lives in the menu bar, keeps data local, and supports keyboard-first navigation for quick triage.

## Features

- Menu bar board with a floating, always-on-top macOS utility window.
- Global shortcut: `⌥K` toggles KanTrack open and closed.
- Compact search: press `/` to filter tasks, notes, and tags.
- Keyboard-first navigation with one active task selection when tasks are visible.
- Create tasks with `A`, `+`, or a lane add button.
- Move selected tasks with `⌘←` and `⌘→`.
- Adjust priority with `⌘↑` and `⌘↓`, or by clicking the left edge of a task.
- Drag tasks between lanes and drag lane headers to reorder lanes.
- Mark tasks complete with `Space`.
- Optional completed-task auto-move to a selected lane.
- Autosize window, launch-at-login support, update checks, import/export JSON, and local persistence.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Show / hide KanTrack | `⌥K` |
| Search | `/` |
| New task | `A` or `+` |
| Open / edit selected task | `Enter` |
| Complete selected task | `Space` |
| Navigate tasks and lanes | `↑` `↓` `←` `→` |
| Move selected task between lanes | `⌘←` `⌘→` |
| Raise / lower priority | `⌘↑` `⌘↓` |
| Delete selected task | `Delete` or `⌘⌫` |
| Undo delete | `⌘Z` |

## Onboarding

New installs automatically show a short walkthrough covering the global shortcut, task creation, drag-and-drop, keyboard navigation, priority, search, and completed-task auto-move. The walkthrough can be opened again from the in-app info menu.

## Requirements

- macOS 13 or newer.
- Node.js and npm.
- Rust and Cargo.
- For signed public distribution, Apple Developer signing and notarization credentials are expected outside this repository.

## Development

Install dependencies:

```bash
npm install
```

Run the Tauri app in development:

```bash
npm run tauri -- dev
```

Build locally:

```bash
npm run tauri -- build
```

## Release Packaging

KanTrack maintains one source app and generates the Mac App Store source copy from it. The direct-download app keeps GitHub updater support; both versions use Apple's SMAppService API for Launch at Login.

Create and publish the direct-download release:

```bash
npm run package:release && npm run publish:release
```

The packaging script writes versioned assets under `release/vX.Y.Z/` and the publish helper uploads them to the KanTrack releases repository.

Create a Mac App Store/TestFlight package:

```bash
npm run package:app-store
```

The update endpoint is configured for:

[github.com/ChrisCrdns/kantrack-releases/releases](https://github.com/ChrisCrdns/kantrack-releases/releases)

## App Store Variant

Generate a separate source copy without the Tauri updater or GitHub update UI:

```bash
npm run prepare:app-store
```

The generated copy is written to `app-store/KanTrack/` and is ignored by git.

For manual App Store inspection, generate the source copy:

```bash
npm run prepare:app-store
```

Launch at Login stays off by default in both versions and only changes when users explicitly opt in from Settings or the tray menu.

## Project Structure

```text
src/                 Frontend HTML, CSS, JavaScript, and image assets
src-tauri/           Tauri v2 Rust shell, tray/menu behavior, and app config
scripts/             Packaging and release helper scripts
release/             Generated release artifacts (ignored by git)
```

## Data

KanTrack stores board data locally in the app webview storage and does not require a cloud backend. Use the gear menu to export or import JSON when moving data between installs.
