# Moving the Fitness Hub to an Ubuntu home server

The hub is plain Python 3 (standard library only) plus static files, so it runs on Ubuntu 22.04 or newer with nothing to install.

**How it is reached after the move:**
- On the server, the hub listens **only on a private Unix socket**, `/run/user/<uid>/fitness-hub/hub.sock` (mode `600`, in a `700` folder). It has **no TCP port**, so other accounts on the server can't reach it either.
- You reach it from your PC through an **SSH tunnel** to that socket, at `http://127.0.0.1:8642/` on the PC.
- No firewall ports are opened, and nothing is exposed to your LAN or the internet.

**An AI coding agent such as Codex, or anyone else doing the hosting, must follow [`deploy/CODEX_HOSTING_GUIDE.md`](deploy/CODEX_HOSTING_GUIDE.md).** It has the exact steps, expected outputs, troubleshooting, and these rules in full.

---

## The rules, in short

1. **Never give the hub a network address on the server.**
   - No TCP listener. Never bind or publish `0.0.0.0` or `[::]`.
   - No proxy, relay or tunnel service in front of it, and never Tailscale Funnel. Tailscale Serve is allowed only as the opt-in phone access below sets it up.
   - No ports opened in `ufw` or on the router.

   `server.py` refuses non-loopback addresses, and requests that came through a proxy.
2. **Never weaken the request checks:** the Host allowlist, the proxy tripwire, the `X-Fitness-Hub`, Origin, `If-Match` and build checks, and the security headers.
3. **Never print, read or upload `data/data.json`** or its backups. They hold your health data.
4. **Other machines only connect through the SSH tunnel** (step 4 below).
5. **Phone access is opt-in.** Only when you ask for it does the guide's section 14 set it up:
   - Tailscale Serve, inside your tailnet only, to a second private socket;
   - it opens only for your own Tailscale login: tagged devices, shared-in users and the internet get 403;
   - never Funnel, and still no TCP port.

## Quick path

1. **On the PC, build the bundle and copy it over:**
   ```
   python deploy\make_bundle.py
   scp ..\fitness-hub.zip USER@HOMESERVER:~/
   ```
   - `make_bundle.py` first runs the import check and every test suite on a temporary copy (you need Python and Node.js 18+). It refuses to build if any fails.
   - The bundle carries a `BUILD_ID`, and leaves out `data/`, the dev fixtures and caches.
   - To bring your data, prefer **Settings → Export as JSON** now and **Settings → Import** once the server hub runs. (`--with-data` puts it in the zip instead, readable by you only; then delete the zip on both machines.)
2. **On the server, unpack (never over an existing install) and install:**
   ```
   sha256sum ~/fitness-hub.zip                 # must match the sha256 line make_bundle.py printed
   cd ~/fitness-hub && python3 -I -B tests/test_server.py   # after unpacking (guide, step 3); must end in OK (skipped=3)
   bash ~/fitness-hub/deploy/install.sh        # only once the tests passed (guide, steps 4 and 5)
   ```
   The tests must pass on the server before you install: on the PC, the Linux-only ones (sockets, permissions, phone access) are skipped.
   `install.sh`:
   - checks Python 3.10+;
   - makes everything in `~/fitness-hub` private to you;
   - enables linger;
   - installs the **systemd user service** (`deploy/fitness-hub.service`): a Unix socket only (`RestrictAddressFamilies=AF_UNIX`), with a seccomp filter, no-new-privileges and a private umask;
   - starts it and runs `verify.sh`.

   It never uses sudo, and it never touches the firewall.
3. **Verify** at any time with `bash ~/fitness-hub/deploy/verify.sh`. It checks that:
   - the socket is `600` in a `700` folder, and nothing listens on TCP 8642;
   - health is OK, the build is reported, and requests with a foreign Host or proxy headers are rejected;
   - a `PUT` without `If-Match` gets 428;
   - `data/` isn't web-reachable, and everything is readable only by you;
   - no program of yours listens on the network, and no web server or proxy points at the hub;
   - Tailscale Serve doesn't point at the hub, and Funnel is off everywhere. With phone access on, it also checks that Serve maps only HTTPS 443 to the hub's Tailscale socket, that Tailscale is 1.104.4 or newer, and that missing or wrong logins get 403;
   - the last off-machine backup succeeded, if you set them up.

   It exits non-zero on any failure, and fails closed: a check that can't see what it checks (for example inside a sandbox) is a failure, never a pass.
4. **Open it from your PC through the SSH tunnel.** You need your user ID on the server (`id -u` there):
   ```
   deploy\connect_from_pc.bat USER@HOMESERVER UID           (Windows)
   bash deploy/connect_from_pc.sh USER@HOMESERVER UID       (macOS, Linux, WSL, Git Bash)
   ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:8642:/run/user/UID/fitness-hub/hub.sock USER@HOMESERVER
   ```
   The scripts check that ssh exists, refuse if port 8642 is busy on the PC, and open **http://127.0.0.1:8642/** once the hub answers.
   - Keep the **local port at 8642**. The hub only accepts `127.0.0.1:8642` and `localhost:8642` (its DNS-rebinding defence), so other ports get 403.
   - If a copy of the hub also runs on the PC itself (`start_hub.bat` or `start_hub.sh`), stop it first, because both want port 8642 on the PC.
   - Set up an SSH key (`ssh-keygen -t ed25519`, then copy the public key to the server) so you don't type a password each time. The guide's section 6 has the details.

## Later

- **Updates:** copy a new bundle (built by `make_bundle.py`), then install it with `update.sh` as the guide's section 7 shows.
  - Before changing anything, it checks the bundle's build id, runs the import check and the server tests on the new code, and backs up `data.json` and the current code to `~/fitness-hub-backups/`.
  - It swaps in a pristine copy of the bundle (never the copy the tests ran in, and never `data/`), enables and restarts the service, and verifies. On any failure, it puts the old code back automatically; if the old code then fails its verification too, it stops and disables the hub (fail closed).
  - Open tabs then show "The hub was updated. Reload to continue." A normal reload gets the new code.
  - `update.sh --rollback` undoes an update.
- **Backups:** `data/backups/` keeps daily snapshots, safety copies taken before big deletions (in any list, nested ones included), and manual backups. For a copy elsewhere, once the hub has created `data.json` (open it once), run `bash ~/fitness-hub/deploy/backup.sh /path/to/folder`, or add `--install-timer` to make it daily. The timer is enabled only after its first run worked. Each archive gets a `.sha256` file, and `verify.sh` checks the last run.
- **Restore, uninstall and troubleshooting:** see the guide, sections 8 to 10.
- **Phone access (opt-in, only when you ask):** see the guide, section 14.
  - It installs the `deploy/tailscale.conf.example` drop-in, then runs one root-only `sudo tailscale serve --bg --https=443 unix:...ts.sock` command.
  - You then open `https://<machine>.<tailnet>.ts.net/` on your phone, signed in to Tailscale as yourself.
  - Section 14.6 turns it off again.
- **Reviews and content changes with Claude:** see the guide, section 13 (Export → Claude; edit → `make_bundle.py` → `update.sh`).
