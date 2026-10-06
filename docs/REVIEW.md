# Review of DSH 0.2.0-rc.2 on macOS

What I looked at before deciding DSH needed a box, and what dsh-airlock does about each finding. Reviewed 2026-10-06 against `@deepseek-ai/dsh@0.2.0-rc.2` from npm, installed with `--ignore-scripts`. Paths below are relative to `node_modules/@deepseek-ai/` in that install. Line numbers are for that exact release and will drift.

## Method

- Installed the pinned package with install scripts disabled and read every install hook in the tree (`dsh-subprocess-local`, `node-pty`, `koffi`, `protobufjs`). They chmod a helper, check for prebuilt binaries, or print warnings. None downloads anything.
- Checked the native binaries DeepSeek ships (`node-addon-system`, `node-addon-require-builtin`, `libreoffice-kit`). The first two import only file locking and basic libc. `libreoffice-kit` is a 140 MB LibreOffice build with normal LibreOffice network code; dsh-airlock unmounts the plugin that uses it.
- Grepped every `@deepseek-ai` package for hard-coded hosts and traced each one to the plugin row that uses it and whether that row is on by default in the `web` profile.
- Read the sandbox, approval, credential and web server code paths.
- `npm audit`: one moderate advisory, `fflate` ZIP64 parsing can loop forever on a malformed archive (GHSA-px8p-9vwx-vf98), reached through the office converter.
- Then proved the result at runtime with `test/prove.sh` (see the README).

## Findings

### Sandbox: writes only

| What | Where | dsh-airlock |
|---|---|---|
| The macOS Seatbelt profile is `(allow default) (deny file-write*)` plus writable roots. Reads, network, process launching and mach services (keychain, LaunchServices) are all allowed. | `dsh-sandbox-local/lib/index.js:65-75` | Whole process boxed with a profile that denies reads of the home folder, temp folders and `/Volumes`, plus app launching, AppleScript, keychain, clipboard and preferences. |
| The file tools' fence only checks mutations. "Reads pass through untouched." | `dsh-fs-sandbox/lib/index.js`, module comment | Same box; the read tool runs inside it. |
| Shell commands run without approval unless the model asks for wider sandbox permissions. | `dsh-tool-bash/lib/index.js:640-648` | Unchanged, but every command runs inside the box. |
| The sidebar terminal runs "without Agent sandbox or approval restrictions". | `dsh-api-terminal-controller/lib/index.js` | `terminal-controller` and `ui-sidebar-terminal` unmounted. |
| The agent can read `$DSH_HOME/.credentials.yaml`, which also holds the browser-cookie signing secret, so a confined command could mint a session and drive the local API. | `dsh-client-connection/lib/index.js` | Still readable inside the box (dsh needs it), but the escape lands inside the same box, and the settings files the API writes are read-only in normal runs. Listed as a known limit. |

### Data sent to DeepSeek

| What | Where | Default | dsh-airlock |
|---|---|---|---|
| Every official DeepSeek model request carries a `dsh_session_log` field: the new part of the session log since the last upload, up to 8 MiB. | `dsh-session-log-deepseek/lib/index.js:18` (`enabled` defaults to true), `:137`; mounted in `dsh-base/cordis.patch.yml:43` | On when using DeepSeek | Row unmounted, and the whole official DeepSeek route with it. |
| Every official DeepSeek model request also carries `dsh_plugin_packages`, your active plugin list. | `dsh-plugin-package-inventory-deepseek` (README) | On when using DeepSeek | Row unmounted. |
| Requests carry an `x-deepseek-harness-user-id` header with a persistent anonymous ID from `$DSH_HOME/.anonymous-user-id`. | `dsh-llm-deepseek/lib/index.js:2200`; `dsh-base/cordis.patch.yml:196` | On when using DeepSeek | Route unmounted. |
| Like, dislike, removing a rating, or `/feedback` uploads the session log up to that point to `https://dsh-otel-collector.deepseeksvc.com/v1/logs`, for any model provider. The Like button shows no warning. | `dsh-base/cordis.patch.yml:186-211`; `dsh-session-telemetry-otel/lib/index.js:164-178` | On (`FEEDBACK_ONLY`) | Row unmounted, `DSH_TELEMETRY_DISABLED=1`, feedback UI unmounted, endpoint pointed at a local discard port. |
| `web_search` always calls `https://api.deepseek.com/anthropic/v1` with the DeepSeek key, whichever model provider you use. | `dsh-web-search-deepseek/lib/index.js:318`; `dsh-base/cordis.patch.yml:472-481` | On when the tool is used | Row unmounted; Brave or SearXNG provider instead. |
| DeepSeek account login talks to `platform.deepseek.com`. | `dsh-deepseek-account-platform` | Only after login | Account rows and settings page unmounted. |
| The Contact link opens a Feishu form prefilled with uid, version, device info, locale and screen size. | `dsh-client-ui-settings-account/lib/client.js:907` | On click | Settings page unmounted. |
| Product analytics to the same collector. | `dsh-web-app/cordis.patch.yml:45-62` | Desktop profile only | Not used by the web profile; endpoint also pointed at the discard port. |

As far as I could tell there's no third-party analytics (no Sentry, PostHog, Statsig, Segment or crash reporter), no update check, and nothing contacts the network at startup before you configure a model.

### Other things worth knowing

| What | Where | dsh-airlock |
|---|---|---|
| A `.env` in the working folder is loaded into the process environment (variables not already set), apart from a blocklist of names like `PATH`, `NODE_OPTIONS` and `DSH_*`. | `dsh-app-boot/lib/index.js:3430-3442` | The box gets a clean environment, the workspace is a dedicated folder, and `workspace/.env` is write-protected so the agent can't plant one. |
| Instructions are loaded from `AGENTS.md` / `CLAUDE.md` up the tree, and skills from `.agents/skills` and `.dsh/skills`. That's a prompt-injection path but runs no code. Claude Code and Codex hook bridges ship disabled. | `dsh-agent-instructions`, `dsh-skill-filesystem`, `dsh-hooks-*` | Global `AGENTS.md` and skills folders are write-protected in normal runs. |
| Plugin installs fall back to `registry.npmmirror.com` when the configured registry fails. | `dsh-plugin-manager/lib/index.js:795-796` | Not changed. Install plugins on purpose, after reading them. |
| The web server binds `127.0.0.1:3080` and refuses `--host 0.0.0.0` on the command line. A random launch token is exchanged for an HMAC-signed, SameSite=Strict cookie, and API calls are checked for host and origin. | `dsh-host-webserver`, `dsh-client-connection` | Fine as shipped. |
| API keys sit in `$DSH_HOME/.credentials.yaml` in plain text, mode 0600, and dsh refuses to start if the file is group or world readable. Child processes get an environment with `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*` and `DSH_*` names removed. | `dsh-credentials-local/lib/index.js:92-104`, `dsh-subprocess/lib/index.js:32-56` | Fine as shipped; the box adds the rest. |

## Runtime proof

`test/prove.sh` result on 2026-10-06 (macOS 26, Node 24.5): 19 of 19 checks passed. Across a web UI start and two locked-mode agent turns, dsh opened connections only to the local fake model and fake Brave API, looked up no external host names, and sent nothing to the DeepSeek trap. Model request bodies carried only `model, messages, stream, stream_options, store, max_tokens, tools`. The agent's shell wrote in the workspace, couldn't read a file in the real home folder, couldn't launch apps or reach the internet under the proof's network lock, and search results came back through the dsh-airlock plugin from both the fake Brave and the fake Tavily API, using the keys stored by `--set-key`.
