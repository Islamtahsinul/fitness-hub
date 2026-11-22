# Fitness Hub: changelog

## v1.0

The first public release. It was built and then hardened over four rounds of parallel build work, structured review and scenario-based testing.

### What's in it
- **A training hub** with these pages: Today (with readiness), Check-in, Log a session, Programme, Exercises, Your arm, Hikes, Nutrition, Progress (with tests), Weekly review, The guide, and Settings, plus a short first-run welcome.
- **An 8-phase programme gated by clearances,** written for an experienced lifter returning after an arm fracture (for example a forearm fracture, possibly with surgical plates):
  - **The phases:** Re-entry Week → Foundation → Machines First → Rebuild → Build → Bridge → Forge → Mission.
  - **Clearances:** phases and exercises unlock only on dates your clinician gives: Good arm OK, then Light use, then Grip cleared, then Full clearance. An optional injury date stops a clearance from being dated before the injury.
  - **Add-ons:** good-arm training, and a daily physio slot that appears once your physio's exercises are entered.
  - **Short-on-time and gym-closed sessions.**
  - **Start date:** always a Monday. Until you choose one, the programme counts from the next Monday.
- **Safety:**
  - **One readiness rule** (Green / Amber / Red) used everywhere. It accounts for arm red flags, arm pain of 7/10 or more, rising pain, resting HR (re-baselined when the measurement method changes), sleep, soreness, energy and fasting days.
  - **Locking:** exercises the library doesn't know are locked, and swaps are limited to what the current phase allows.
  - **Rules applied everywhere:** one carrying rule, one cardio-machine rule and one step-height rule, with fall prevention throughout.
  - **Warnings:** a rhabdomyolysis warning, plus NHS 111 / 999 red-flag guidance.
- **The training logger:**
  - The prescription is stored with every log, so progression is judged against what was actually set.
  - Each block keeps its own history, so double progression works per block.
  - Hold rules apply in deload, easy, fasting and red weeks.
  - A plate calculator for a plate-loaded leg press (dead-start method).
  - A rest timer with screen wake lock.
  - A printable week sheet with last-time and target numbers, plus an "Enter from sheet" grid.
- **Nutrition:**
  - Calorie and protein targets from your own numbers, and budget-first meal templates with halal-friendly and vegetarian swaps.
  - Weight-gain bands with muscle memory in mind: a regain band while you're below your usual pre-injury weight, then a lean-gain band. No dieting while the bone heals.
  - A fortnightly weight verdict, paused during fasting periods and for 14 days after.
  - Optional fasting periods (for example Ramadan, other religious fasts or planned fasting) switch those days to easy-day mode.
- **Hikes:** a gated UK hiking ladder, a weekend plan for the first weeks of the programme, a kit list, terrain skills and a hike log.
- **The guide:** 23 chapters covering training, technique, core, mobility, muscle, carries, cardio, hiking, kit and safety, nutrition, supplements, sleep, arm recovery (including a table that turns your clinic's answers into gates), injury prevention, habits, the library and a glossary.

### Data integrity
- **Saves:** ETag / If-Match concurrency, with safe record-level merging and a conflict dialog. Changes are kept in a local copy in the browser, saves retry with backoff, and a watchdog catches stalled saves.
- **Recovery** re-applies changes onto the live data. It never reverts other devices' edits.
- **Schema migration** (v1 → v2) is lossless and keeps unknown keys.
- **Writes and backups:**
  - Writes are atomic, with fsync.
  - A daily automatic backup, plus a backup whenever a save would shrink the data.
  - Manual backups are rate-limited, and old backups are pruned by date.
- **Updates:** a build id is checked on every save, so an old tab can't save after an update.
- **Import and export:** import validation never partly applies a file. CSV exports are guarded against formula injection.

### Security
- **Private by default.** On Linux, the hub can listen on a 0600 Unix socket with no TCP port. Elsewhere, it listens only on TCP loopback. You reach a server copy through an SSH tunnel.
- **Request checks:**
  - The Host header must be on the allowlist, which blocks DNS rebinding.
  - Writes need the Origin and custom header checks.
  - A strict CSP and no CORS.
  - A tripwire refuses requests that came through a proxy.
  - Precondition checks run before the request body is read.
- **Optional Tailscale phone access,** off by default. It uses a second socket, accepts only the Tailscale logins you allow, and never uses Funnel. `verify.sh` enforces this.
- **Deployment kit:** `install.sh`, `verify.sh` (fails closed), `update.sh` (runs all test suites and an import check before switching to the new version, and rolls back on failure), `backup.sh`, the PC tunnel scripts, and a step-by-step hosting guide written for an AI coding agent such as Codex.

### Accessibility and performance
- **Accessibility:** WCAG 2.2 AA work, covering focus management, modal menus, live regions, 44 px gym controls, UK date entry and charts that don't rely on colour alone.
- **Performance:** two years of data loads and renders quickly; data is gzipped; content is fetched early; charts are bucketed.

### Known limits
- Some Linux-only behaviours (socket mode, real file permissions and the Tailscale socket) are tested on the server itself. `update.sh` runs those tests before it installs anything.
- Prices, route details and some research citations are marked approximate or "(not verified)" where they couldn't be confirmed.
- The content is general information, not medical advice: see the disclaimer in the README.
