# dsh-airlock

Run DSH (DeepSeek Harness) on a Mac without it reading your files or talking to DeepSeek.

DeepSeek Harness is the open-source agent harness DeepSeek put out in August 2026. The plugin design is genuinely good. The defaults are not something I want on a machine that has client work on it. Out of the box on macOS, version 0.2.0-rc.2:

- Its sandbox only blocks file writes. Reads, network and process launching are wide open, and the file read tool is not sandboxed at all, so the agent can read `~/.ssh`, `~/.aws`, your Documents, anything you can read.
- Every request to DeepSeek's own model API carries an upload of your session log and a list of your installed plugins.
- Clicking like or dislike on a reply uploads the whole session log to DeepSeek's telemetry collector, whichever model provider you picked.
- Web search always goes through DeepSeek's API, even when your model is Anthropic, OpenAI or a local server.

The details, with file and line references, are in [docs/REVIEW.md](docs/REVIEW.md).

dsh-airlock is a launcher, a web search plugin and a pinned install. It does not fork DSH. It installs the upstream release from npm and changes how it runs.

## What it does

- Runs the whole dsh process, and every command the agent runs, inside a macOS kernel sandbox (`sandbox-exec`). Inside the box:
  - HOME is a fake home (`~/.dsh-airlock`). Your real home folder can't be read, except the workspace folder.
  - Writes only go to the workspace and the fake home.
  - No launching apps, no AppleScript, no keychain tool, no screen capture, no clipboard, and no reading other apps' preferences.
  - In normal runs dsh's own settings, stored keys, `.env` files and skills folders are read-only, so the agent can't rewrite its own configuration.
- Unmounts every DeepSeek-facing plugin: the official DeepSeek model route and its request add-ons (session-log upload, plugin inventory), DeepSeek account login, DeepSeek web search, and the like/dislike/feedback pieces that feed the telemetry upload. The DeepSeek endpoints are also pointed at a local discard port as a backstop.
- Swaps in its own web search: the [Brave Search API](https://brave.com/search/api/) or any [SearXNG](https://docs.searxng.org/) server you point it at. Web fetch keeps working as before.
- Installs a pinned DSH release with `npm ci --ignore-scripts` from a committed lockfile, so you get exact versions with integrity hashes and no install scripts run.
- Ships a self-test and a network proof so you don't have to take any of this on faith.

## What it doesn't do

- **The network stays open.** dsh needs it to reach your model. Anything the agent can read inside the box (your workspace, the keys you gave it) could be sent anywhere your Mac can reach, including hosts on your internal network. macOS sandbox rules can't filter by host name.
- **The agent can read its own API keys** inside the box, because dsh has to. Use keys you can revoke and put a spend limit on them.
- **Approvals are dsh's defaults.** Commands run without asking, inside the box. dsh's own per-command sandbox is replaced with a pass-through because macOS won't nest sandboxes; the airlock box is the boundary instead.
- **macOS only.** Apple marks `sandbox-exec` deprecated but still ships it. If it ever goes away, dsh-airlock refuses to start rather than run unboxed.
- **This is not a security audit.** DSH is preview software that warns about breaking changes, and nobody has audited it. dsh-airlock limits what it can touch. It doesn't make it trustworthy.

## Install

You need macOS, Node.js 22 or newer and npm. No admin rights.

```bash
git clone https://github.com/ThatSimpleTech/dsh-airlock.git
cd dsh-airlock
./install.sh
```

That puts the launcher in `~/.local/bin/dsh-airlock` (make sure that's on your PATH) and everything else in `~/.local/share/dsh-airlock`. `PREFIX=/some/dir ./install.sh` installs somewhere else.

## First run

1. Start in setup mode and add a model:
   ```bash
   dsh-airlock --setup
   ```
   Your browser opens the dsh web UI. Go to Settings > Models > Add model provider and pick Anthropic, OpenAI, another listed provider, or Custom model API for a gateway or a local server (Ollama, vLLM, LiteLLM). Then pick that model in the model picker so it's saved as the default, and press Ctrl+C. The official DeepSeek provider is gone. You can still run DeepSeek's open-weight models through any other host or your own server.

2. Set up web search. Brave is the default and needs a key (they have a free tier):
   ```bash
   dsh-airlock --set-key BRAVE_SEARCH_API_KEY
   ```
   Or use a SearXNG server instead. It has to allow JSON output (`json` under `search.formats` in its `settings.yml`):
   ```bash
   dsh-airlock --search searxng https://search.example.org
   ```
   Or turn search off with `dsh-airlock --search off`.

3. Check the box holds:
   ```bash
   dsh-airlock --selftest
   ```

4. From then on:
   ```bash
   dsh-airlock
   ```

The agent works in `~/Documents/dsh-workspace`. Put files there for it to work on. `DSH_WORKSPACE=/some/folder dsh-airlock` uses a different folder.

## Commands

| Command | What it does |
|---|---|
| `dsh-airlock` | Start the web UI. Settings and keys are read-only. |
| `dsh-airlock --setup` | Start the web UI with settings writable, to add or change model keys. |
| `dsh-airlock --search brave` | Use Brave Search (default). |
| `dsh-airlock --search searxng URL` | Use a SearXNG server. |
| `dsh-airlock --search off` | No web search. |
| `dsh-airlock --set-key NAME` | Store a secret such as `BRAVE_SEARCH_API_KEY`. Prompts with input hidden. |
| `dsh-airlock --selftest` | Run probe commands inside the box and report. |
| `dsh-airlock --check` | Print the sandbox profile and the composed dsh configuration. |
| `dsh-airlock --run ARGS...` | Run `dsh ARGS...` inside the box, for example `--run headless "summarize this folder"`. |

Environment overrides: `DSH_WORKSPACE`, `DSH_PORT` (default 3080), `DSH_AIRLOCK_HOME` (default `~/.dsh-airlock`), `DSH_AIRLOCK_ROOT` (default `~/.local/share/dsh-airlock`), `DSH_AIRLOCK_NODE`, and `DSH_AIRLOCK_NO_BROWSER=1` to print the sign-in URL instead of opening it.

## Where things live

| Path | What |
|---|---|
| `~/.local/bin/dsh-airlock` | The launcher |
| `~/.local/share/dsh-airlock/upstream/<version>` | The pinned DSH install, plus the search plugin |
| `~/.local/share/dsh-airlock/libexec` | The command runner and self-test |
| `~/.dsh-airlock` | The fake home: dsh settings, sessions, stored keys (`.dsh/.env`, `.dsh/.credentials.yaml`), `airlock.conf` |
| `~/Documents/dsh-workspace` | The workspace |

`./uninstall.sh` removes the program files and leaves your data where it is.

## Proving it

Three layers of checks.

- `dsh-airlock --selftest` runs about 40 probes inside the real box: reads of `~/.ssh`, `~/.aws`, Documents, Downloads, keychains, cloud storage and temp folders must fail; writes outside the workspace and to dsh's settings must fail; `open`, `osascript`, `security`, `screencapture`, the clipboard and other apps' preferences must fail; git, node and https must still work. Add your own paths, one per line, to `~/.dsh-airlock/selftest-probes`. A credentials file you care about is a good one.
- `test/prove.sh` runs real agent turns with the network locked to your Mac, a fake model, a fake Brave API and a trap on every DeepSeek endpoint, while a hook inside dsh records every connection and DNS lookup it makes. It passes only if dsh talked to nothing but the local fakes, the trap saw nothing, the model requests carried no DeepSeek add-on fields, the agent's shell was confined, and search worked through the new plugin. It uses a throwaway home and workspace.
- `cd plugins/web-search && npm test` runs the search plugin's unit tests against local mock servers.

## Upgrading DSH

DSH changes fast, and a new release can add new rows that phone home. Don't just bump the version.

1. Change the version in `upstream/package.json`, then run `npm install --package-lock-only --ignore-scripts` in `upstream/`.
2. Repeat the review in [docs/REVIEW.md](docs/REVIEW.md) against the new release. At minimum, diff the shipped plugin rows in `dsh-base/cordis.patch.yml` and `dsh-web-app/cordis.patch.yml` and grep the `@deepseek-ai` packages for hosts.
3. `./install.sh`, then `test/prove.sh` and `dsh-airlock --selftest`. Both have to pass.

## How it works

- **Settings layer.** dsh builds its configuration from patch layers. On every start the launcher rewrites `~/.dsh-airlock/.dsh/cordis.patch.yml`, the home layer, which ranks above the per-profile layer the web UI saves to. That's where the DeepSeek rows get disabled and the search plugin gets mounted, so nothing saved in Settings can turn them back on.
- **The box.** The launcher builds a sandbox profile from your real paths and runs `node` under `sandbox-exec` with a clean environment. Children inherit the box. dsh's own per-command `sandbox-exec` would fail under it, since macOS refuses nested sandboxes, so dsh is pointed at `libexec/passthrough-runner` through its `sandbox.runnerCommand` setting.
- **Search.** `plugins/web-search` registers a provider with dsh's web seam (`ctx.web`). dsh only imports plugins in the dependency closure of its own `package.json`, so the installer adds one dependency line to the installed copy of that file. That's the only edit made to an upstream file.

## License

Apache-2.0. See [LICENSE](LICENSE).

DSH itself is MIT licensed and is installed from npm, not redistributed here. "DeepSeek Harness" is a trademark of DeepSeek. dsh-airlock is not affiliated with or endorsed by DeepSeek, and per their brand guidelines it uses the "DSH" name.
