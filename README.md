# Tmux Tab Restore

[![CI](https://github.com/DavidTimar1/VSCode-Tmux-Restore/actions/workflows/ci.yml/badge.svg)](https://github.com/DavidTimar1/VSCode-Tmux-Restore/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/DavidTimar1/VSCode-Tmux-Restore?sort=semver)](https://github.com/DavidTimar1/VSCode-Tmux-Restore/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A VS Code extension for Remote-SSH windows. It remembers which tmux session each terminal tab is attached to, and reopens those tabs, attached to the same sessions, on request. It runs on the Linux server (a workspace extension) and needs bash, tmux and `/proc`.

## Contents

- [Background](#background)
- [Is this safe?](#is-this-safe)
- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [Commands and icons](#commands-and-icons)
- [Read the detection log](#read-the-detection-log)
- [Building and releasing](#building-and-releasing)
- [License and contributing](#license-and-contributing)

## Background

This is a hobby project. I keep my terminal tabs attached to tmux sessions on a Remote-SSH server, and VS Code forgets those tabs when the window reloads. This extension saves them and brings them back. I have limited time for it, but contributions are welcome.

## Is this safe?

The extension runs only on the remote host, never on your local machine. It calls `tmux list-clients` and reads `/proc` to find which session a tab belongs to, and when you restore it types `tmux new-session -A -s '<session>'` into a new terminal. It opens no network connection and has no telemetry. The saved list stays in VS Code's own workspace storage.

Do not take my word for it. Paste this repository into an AI and ask:

- [Ask Claude](https://claude.ai/new?q=Is%20https%3A//github.com/DavidTimar1/VSCode-Tmux-Restore%20safe%2C%20will%20it%20spy%20on%20me%2C%20does%20it%20send%20anything%20over%20the%20network%2C%20and%20what%20does%20it%20run%20on%20my%20server%3F)
- [Ask ChatGPT](https://chatgpt.com/?q=Is%20https%3A//github.com/DavidTimar1/VSCode-Tmux-Restore%20safe%2C%20will%20it%20spy%20on%20me%2C%20does%20it%20send%20anything%20over%20the%20network%2C%20and%20what%20does%20it%20run%20on%20my%20server%3F)

## Quick start

1. Download the latest `.vsix` file from the [Releases page](https://github.com/DavidTimar1/VSCode-Tmux-Restore/releases).
2. Open a Remote-SSH window. In the Extensions view, open the `...` menu and choose `Install from VSIX...`, then pick the file. It needs VS Code 1.93 or newer, and installs on the remote server.
3. Reload the window if asked.

## How it works

- Finds the tmux session of each terminal tab by matching the tab's shell process against `tmux list-clients` on every tmux socket of your user.
- Saves tab name, session and socket (the socket only when it is not the default one) in the workspace state.
- Saves automatically when a tab opens or closes (after 2 s) and every 30 s. It also saves 2 s and 6 s after a command starting with `tmux` is started in a tab (needs VS Code shell integration; without it the 30 s save still covers it). After the window starts, automatic saves are in merge mode: they add newly detected tabs and never remove an entry. After you run `Save tabs` or `Restore tabs` in this window session, automatic saves are in replace mode and track the open tabs. An automatic save never replaces a non-empty saved list with an empty one. The mode is written in the detection log on every save.
- Tabs that are not attached to tmux are not saved.
- Restore opens one bash terminal per saved entry, each as its own tab in the main editor area, named after its session, and types `tmux new-session -A -s '<session>'`. A missing session is created. After you detach, the tab keeps its bash prompt. The location of an existing terminal cannot be read from the API for terminals the extension did not create, so restore always uses the editor area.
- Restore skips sessions that are already attached in a tab of this window.
- The saved list is kept in VS Code's own per-folder state, on the machine running the VS Code window (in its workspace storage), so it survives window reloads and server reboots.

Limits:

- On a host without `/proc` the commands show a message and do nothing.
- Replaying typed commands and split or group layout are not supported.

## Commands and icons

- `Tmux Restore: Save tabs`: saves now, and may save an empty list.
- `Tmux Restore: Restore tabs`: reopens the saved tabs.
- `Tmux Restore: Show detection log`: opens the "Tmux Restore" output channel.

The editor title bar (top right, next to the split editor icon) has two icons: a save icon that runs `Save tabs` and a history icon that runs `Restore tabs`.

## Read the detection log

Run `Tmux Restore: Show detection log`. Every save and restore writes, per terminal:

- the tab name and its shell PID;
- every tmux socket queried, with the number of clients found on it;
- the result: the matched session, or the reason it failed.

Failure reasons:

- `processId undefined`: the tab has no shell process the extension can see (extension terminal, not started yet, or no answer within 3 s).
- `no tmux on PATH of the extension host`: tmux is not found by the extension host.
- `no tmux clients attached on any socket`: tmux has no client on the default socket or in the socket directory (`${TMUX_TMPDIR:-/tmp}/tmux-<uid>/`).
- `no ancestor match`: clients exist, but none descends from this tab's shell PID. Compare the shell PID with the client PIDs listed above it.

## Building and releasing

With Node 20 or newer installed, from the project root:

```bash
npm ci
npx tsc -p .
npx --no-install vsce package --no-dependencies
```

This writes `tmux-tab-restore-<version>.vsix`. Releases are built by GitHub Actions when a `v*` tag matching `VERSION` is pushed, and the `.vsix` is attached to the GitHub release.

## License and contributing

Licensed under the [MIT License](LICENSE). Contributions are welcome: open an issue or a pull request.
