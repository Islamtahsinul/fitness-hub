# Fitness Hub

A private, self-hosted training hub and guide for getting back to training after an arm injury. It's written for an experienced lifter returning after a fracture (for example a forearm fracture, possibly with surgical plates). Your fracture clinic and physio set the pace: each clearance you record unlocks the next exercises and phases, never before.

It's a small Python server and a plain JavaScript app with no build step and no dependencies. It runs on your own computer or home server. Nothing is sent anywhere: no accounts, no cloud, no analytics, no third-party requests.

> **Medical disclaimer: this is not medical advice.**
> Fitness Hub is a training diary and a general-information guide. It doesn't diagnose, treat or replace professional care. Always follow your fracture clinic, physio and doctor; where the hub and your clinician differ, your clinician wins. The content is general information written for adults and may not suit your injury, your surgery or your health. If a red flag appears (worsening pain, new swelling, numbness, a pale or cold hand, a fall on the arm and so on), stop and contact your fracture clinic or NHS 111. In an emergency, call 999 (or your local emergency number). You use the hub at your own risk.

## Features

- **Clearance gates.** Five cumulative levels, from "Available now" (nothing goes through the injured arm) to "Full clearance". Exercises, phases and add-ons above your recorded clearance stay locked everywhere, and recording one always asks you to confirm.
- **Daily readiness.** A morning check-in (sleep, resting heart rate, energy, soreness, arm pain and red flags) gives a green, amber or red day. Amber halves the sets and holds the loads; red stops training and points you to your clinic.
- **Today and the session logger.** The day's plan, warm-ups and timers, double progression from your logged sets, a plate calculator, safe swaps when kit is busy, and short-on-time or gym-closed alternatives.
- **Programme roadmap.** Phases that wait for their gates, week overrides and deloads, and a printable A4 week for the gym.
- **Exercise library.** Setup, cues, common mistakes and arm-safety notes for every exercise, with regressions and progressions.
- **Your arm.** Clearances, appointments with countdowns, questions for the clinic, a rehab log with charts, healing stages and your physio's exercises.
- **Progress.** Charts, a fitness-test battery, goals, weekly reviews and a fortnightly weight verdict (no dieting while the bone heals).
- **Nutrition.** Calorie and protein targets from your own numbers (Mifflin-St Jeor, 1.6–2.2 g/kg), meal templates with halal-friendly and vegetarian swaps, a food table and an evidence-graded supplement list.
- **Hiking.** A gated hiking ladder, a weekend plan, a kit list, terrain skills and a hike log.
- **The guide.** 23 chapters on training, engine and hiking, fuel and recovery, arm recovery and mindset, with sources.
- **Your data stays yours.** One JSON file, saved as you type, with automatic backups, JSON export and import, CSV export, conflict-safe saving across tabs and devices, and a data check for typing slips.
- **Fasting periods (optional).** For example Ramadan, other religious fasts or planned fasting: those days switch to easy-day mode automatically.

There are no screenshots in this repository: see the app. To explore it with sample data, open `http://127.0.0.1:8642/?fixtures=1` (nothing is saved in that mode).

## Quick start

You need **Python 3.10 or newer** and a current browser (Edge, Chrome or Firefox). Nothing else is installed.

**Windows:** double-click `start_hub.bat`. It starts the hub and opens **http://127.0.0.1:8642/**. Keep the window open while you use it; close it (or press `Ctrl+C`) to stop. Everything is already saved.

**Linux or macOS:**

```sh
./start_hub.sh --open      # or: python3 server.py --open
```

Stop it with `Ctrl+C`. `python3 server.py --check` checks the settings and folders without starting anything.

The first time, a short welcome asks for your details (used only for the formulas), your start date, what your clinic has cleared so far and the safety rules. Your programme always starts on a Monday; until you choose a date, it counts from the next Monday.

## Your data

- Everything lives in `data/data.json`, next to `server.py`. It's created on first run and is never served.
- Backups go to `data/backups/`: a daily copy on the first save of each day, an automatic copy before any save that would remove many records, and manual ones from **Settings → Back up now**.
- **Restore a backup:** stop the hub, copy a backup over `data/data.json` (keep the name), then start it again. Or use **Settings → Import a JSON file**.
- If `data.json` is ever damaged, the hub refuses to overwrite it and asks you to restore a backup.
- The data format is described in [`SPEC-DATA.md`](SPEC-DATA.md).
- If you choose to share an export (for example with an AI assistant), you're sharing your health data with that service.

## Security model

The hub has no login. **Where it listens is the security boundary**, and it refuses to start if that would be widened.

- **Loopback only.** By default it binds `127.0.0.1:8642` and refuses any other address (`0.0.0.0` included), so only programs on the same computer can connect.
- **Unix socket on a server.** On Linux it can listen on a private Unix socket instead (`0600` in a `0700` folder) with no TCP port at all. You reach it from your PC through an **SSH tunnel** to that socket.
- **Optional, identity-gated Tailscale.** Phone access is off by default. When you turn it on, Tailscale Serve publishes a second private socket inside your tailnet, and the hub answers only requests that Serve marks as one of the Tailscale logins you allow. Funnel (public internet) is never used.
- **Browser-attack defences.** A Host allowlist (DNS rebinding), CSRF checks on every write, a strict Content-Security-Policy and related headers, and no CORS. Requests that arrive through an unexpected proxy are refused.
- **Safe saves and bounded requests.** Saves need the current ETag, so a stale tab can't overwrite newer data. Bodies, nesting depth, timeouts and connections are capped. Logs never contain request bodies or your data.

Never expose the hub with a wider bind, a port forward or a public reverse proxy. The details are in the `server.py` docstring and [`deploy/CODEX_HOSTING_GUIDE.md`](deploy/CODEX_HOSTING_GUIDE.md).

### Settings

| Variable | Default | Notes |
|---|---|---|
| `FITNESS_HUB_HOST` | `127.0.0.1` | Must be loopback: `127.0.0.1`, `::1` or `localhost`. |
| `FITNESS_HUB_PORT` | `8642` | In socket mode, the port the tunnel's Host header names. |
| `FITNESS_HUB_SOCKET` | *(empty)* | Linux only: listen on this Unix socket instead of TCP. |
| `FITNESS_HUB_TS_SOCKET`, `FITNESS_HUB_TS_HOST`, `FITNESS_HUB_TS_USERS` | *(empty)* | Opt-in Tailscale phone access (Linux, socket mode): all three or none. |
| `FITNESS_HUB_DATA_DIR` | `./data` | Where the data and backups live (the tests use a temporary folder). |
| `FITNESS_HUB_LOG_LEVEL` | `info` | `debug`, `info`, `warning` or `error`. |

## Deploying to a home server

[`deploy/`](deploy/) moves the hub to an Ubuntu server as a systemd user service on a private Unix socket. It contains the bundle builder, install, verify, update (with rollback) and backup scripts, and SSH-tunnel launchers for Windows and Linux.

- [`MIGRATE.md`](MIGRATE.md) is the short version.
- [`deploy/CODEX_HOSTING_GUIDE.md`](deploy/CODEX_HOSTING_GUIDE.md) is the full step-by-step procedure, with its guardrails and expected outputs. It's written for an AI coding agent such as Codex, and works just as well for a person. Section 14 covers the opt-in phone access over Tailscale.

`python deploy/make_bundle.py` runs every check and test on a temporary copy of what it will ship, and refuses to build `fitness-hub.zip` if anything fails.

## Running the tests

Run these from the repository root. You need Node.js 18 or newer for the JavaScript suites.

```sh
node tests/test_logic.mjs       # scheduling, readiness, formulas, the store and sync engine, Markdown safety
node tests/test_ui.mjs          # view helpers, insights, clearances, dates
node tests/test_content.mjs     # the content files in public/content/ against the contracts
python tests/test_server.py     # API, ETags, limits, socket and Tailscale modes, deploy scripts
python deploy/check_imports.py  # every ES-module import under public/js resolves
```

`test_server.py` starts its own servers on free ports or temporary sockets, with temporary data folders. It never uses port 8642 or `data/`. Tests that need Linux are skipped on Windows. The sample files in `public/dev-fixtures/` are generated by `python tests/make_fixtures.py`.

## Project layout

```
fitness-hub/
  server.py            the web server (Python standard library only)
  start_hub.bat/.sh    launchers (Windows / Linux and macOS)
  SPEC.md              the build spec: safety rules, gates and the JSON contracts
  SPEC-DATA.md         the user-data format and module APIs
  public/
    index.html, css/, js/    the app (plain ES modules, no build step)
    content/                 programme, exercise library, tests, hikes, nutrition, arm and the guide
    dev-fixtures/            sample content and data for ?fixtures=1
  deploy/              home-server kit and the hosting guide
  tests/               test suites and the fixture generator
  tools/               canonical exercise ids
  data/                your data and backups (created at runtime, not in git)
```

To change the programme, the exercises or the guide, edit the files in `public/content/` and reload the page (or use **Settings → Reload content**). `SPEC.md` describes their contracts.

## Built with AI assistance

Fitness Hub was built with AI assistance (Claude, by Anthropic). The code and content were reviewed and tested, but read the medical disclaimer above: the content is general information.

## Contributing

Issues and pull requests are welcome. Please:

- keep the safety rules in `SPEC.md` §2 and the gates intact;
- keep the server on the standard library and the app free of external requests and build steps;
- run all the test suites above before you open a pull request;
- never include real personal or health data in issues, fixtures or tests.

## Licence

MIT: see [`LICENSE`](LICENSE).
