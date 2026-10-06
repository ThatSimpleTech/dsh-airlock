#!/bin/bash
# Proof run: real dsh agent turns inside the airlock, with
#   - the network locked to this Mac (an extra sandbox rule),
#   - a fake model that makes the agent run a shell probe and a web search,
#   - fake Brave and Tavily search APIs (check the keys stored with --set-key),
#   - every DeepSeek endpoint pointed at a trap,
#   - a hook inside dsh recording every connection and DNS lookup it makes.
# Uses a throwaway sandbox home and workspace; your real ones are not touched.
# Passes only if dsh talked to nothing but the local fakes, the trap saw no
# request, the model requests carried no DeepSeek add-on fields, the probe was
# confined, and the search result came back through the new plugin.
#
#   test/prove.sh            (needs dsh-airlock installed; KEEP=1 keeps the temp dir)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd -P)"
AIRLOCK="${AIRLOCK:-$(command -v dsh-airlock || true)}"
[ -n "$AIRLOCK" ] || { echo "prove: dsh-airlock not on PATH (run install.sh)" >&2; exit 2; }
NODE="$(command -v node)"

T="$(mktemp -d "${TMPDIR:-/tmp}/dsh-airlock-prove.XXXXXX")"
T="$(cd "$T" && pwd -P)"
CANARY="$HOME/.dsh-airlock-prove-canary.$$"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -f "$CANARY"
  if [ -n "${KEEP:-}" ]; then echo "prove: kept $T"; else rm -rf "$T"; fi
}
trap cleanup EXIT

export DSH_AIRLOCK_HOME="$T/home" DSH_WORKSPACE="$T/ws" DSH_AIRLOCK_NO_BROWSER=1
mkdir -p "$DSH_AIRLOCK_HOME" "$DSH_WORKSPACE"
echo "canary, must stay unreadable inside the box" > "$CANARY"
cp "$HERE/prove/netlog-hook.mjs" "$DSH_AIRLOCK_HOME/netlog-hook.mjs"

"$NODE" "$HERE/prove/mock-servers.mjs" "$T" "$CANARY" > "$T/mock.out" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do [ -s "$T/ports.json" ] && break; sleep 0.1; done
[ -s "$T/ports.json" ] || { cat "$T/mock.out"; echo "prove: mock servers did not start" >&2; exit 2; }
port() { "$NODE" -p "require('$T/ports.json').$1"; }
MODEL_PORT="$(port model)"; BRAVE_PORT="$(port brave)"; TAVILY_PORT="$(port tavily)"; TRAP_PORT="$(port trap)"

"$AIRLOCK" --search brave >/dev/null
printf 'BRAVE_BASE_URL=http://127.0.0.1:%s/res/v1\n' "$BRAVE_PORT" >> "$DSH_AIRLOCK_HOME/airlock.conf"
printf 'prove-brave-key' | "$AIRLOCK" --set-key BRAVE_SEARCH_API_KEY >/dev/null
printf 'TAVILY_BASE_URL=http://127.0.0.1:%s\n' "$TAVILY_PORT" >> "$DSH_AIRLOCK_HOME/airlock.conf"
printf 'prove-tavily-key' | "$AIRLOCK" --set-key TAVILY_API_KEY >/dev/null

cat > "$DSH_AIRLOCK_HOME/mock-provider.yml" <<YAML
- id: llm-pi-ai
  config:
    providers:
      mock:
        apiKeyEnv: MOCK_LLM_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:$MODEL_PORT/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: mock-model
- id: agent-default-model
  config:
    provider: mock
    model: mock-model
YAML

export MOCK_LLM_KEY=mock-not-a-secret
export NODE_OPTIONS="--import=$DSH_AIRLOCK_HOME/netlog-hook.mjs"
export NETLOG_FILE="$DSH_AIRLOCK_HOME/netlog.jsonl"
export DSH_TELEMETRY_OTLP_URL="http://127.0.0.1:$TRAP_PORT/v1/logs"
export DSH_PRODUCT_ANALYTICS_OTLP_URL="http://127.0.0.1:$TRAP_PORT/v1/logs"
export DEEPSEEK_BASE_URL="http://127.0.0.1:$TRAP_PORT"
export DEEPSEEK_SEARCH_BASE_URL="http://127.0.0.1:$TRAP_PORT/v1"
export DSH_AIRLOCK_PASS_ENV="MOCK_LLM_KEY NODE_OPTIONS NETLOG_FILE DSH_TELEMETRY_OTLP_URL DSH_PRODUCT_ANALYTICS_OTLP_URL DEEPSEEK_BASE_URL DEEPSEEK_SEARCH_BASE_URL"
export DSH_AIRLOCK_SANDBOX_EXTRA='(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))'

# First start, as a user would: the web UI in setup mode creates dsh's key
# file, so the agent turns below run with the normal locked rules.
WEB_PORT="$("$NODE" -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
DSH_PORT="$WEB_PORT" "$AIRLOCK" --setup > "$T/setup.out" 2>&1 &
LAUNCHER_PID=$!
for _ in $(seq 1 60); do grep -q "127.0.0.1:$WEB_PORT/" "$T/setup.out" 2>/dev/null && break; sleep 0.5; done
WEB_PID="$(lsof -t -nP -iTCP:"$WEB_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
[ -n "$WEB_PID" ] || { cat "$T/setup.out"; echo "prove: FAIL web UI did not start" >&2; exit 1; }
kill "$WEB_PID"; wait "$LAUNCHER_PID" 2>/dev/null || true
[ -f "$DSH_AIRLOCK_HOME/.dsh/.credentials.yaml" ] || { echo "prove: FAIL setup run created no key file" >&2; exit 1; }
echo "prove: web UI started and stopped (setup run)"

"$AIRLOCK" --run headless --dump-config > /dev/null 2>&1 || true  # first use of the headless profile (setup rules)
for turn in 1 2; do
  # Turn 1 searches through Brave, turn 2 through Tavily.
  [ "$turn" = 1 ] && search=brave || search=tavily
  "$AIRLOCK" --search "$search" >/dev/null
  echo "prove: agent turn $turn (locked mode, $search search)"
  if ! perl -e 'alarm shift; exec @ARGV' 180 "$AIRLOCK" --run headless --patch "$DSH_AIRLOCK_HOME/mock-provider.yml" "Run the airlock probe." > "$T/turn$turn.out" 2>&1; then
    cat "$T/turn$turn.out"; echo "prove: FAIL dsh headless turn $turn exited non-zero" >&2; exit 1
  fi
done
unset NODE_OPTIONS

"$NODE" - "$T" "$MODEL_PORT" "$BRAVE_PORT" "$TAVILY_PORT" <<'JS'
const fs = require("fs");
const [dir, modelPort, bravePort, tavilyPort] = process.argv.slice(2);
const lines = (f) => (fs.existsSync(`${dir}/${f}`) ? fs.readFileSync(`${dir}/${f}`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []);
let failed = 0;
const check = (ok, label, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${label}${detail ? "  (" + detail + ")" : ""}`); if (!ok) failed++; };

for (const turn of [1, 2]) {
  const out = fs.readFileSync(`${dir}/turn${turn}.out`, "utf8");
  check(!/first run|first use|setup mode/.test(out), `turn ${turn}: ran with the normal locked rules`);
  check(out.includes("WROTE_WORKSPACE"), `turn ${turn}: agent shell ran and wrote in the workspace`);
  check(out.includes("CANARY_BLOCKED") && !out.includes("CANARY_READABLE"), `turn ${turn}: file in the real home folder unreadable`);
  check(out.includes("OPEN_BLOCKED"), `turn ${turn}: launching apps blocked`);
  check(out.includes("EXTERNAL_BLOCKED"), `turn ${turn}: proof network lock active (harness sanity)`);
  const want = turn === 1 ? ["Airlock mock result", "Brave"] : ["Tavily mock result", "Tavily"];
  check(out.includes(want[0]), `turn ${turn}: web search answered through the dsh-airlock plugin (${want[1]})`);
}
const brave = lines("brave.jsonl");
check(brave.length >= 1 && brave.every((r) => r.tokenOk), "Brave key from --set-key reached the Brave API", `${brave.length} request(s)`);
const tavily = lines("tavily.jsonl");
check(tavily.length >= 1 && tavily.every((r) => r.tokenOk && r.method === "POST"), "Tavily key from --set-key reached the Tavily API", `${tavily.length} request(s)`);
const trap = lines("trap.jsonl");
check(trap.length === 0, "no request reached any DeepSeek endpoint", trap.length ? JSON.stringify(trap[0]) : "");
const model = lines("model.jsonl");
const extra = [...new Set(model.flatMap((m) => m.keys).filter((k) => /^dsh_|session_log|plugin_packages/i.test(k)))];
check(model.length > 0 && extra.length === 0, "model requests carry no DeepSeek add-on fields", extra.join(",") || `${model.length} request(s)`);
const net = lines("home/netlog.jsonl");
check(net.some((n) => n.kind === "hook-loaded"), "connection recorder loaded in dsh");
const allowed = new Set([modelPort, bravePort, tavilyPort].flatMap((p) => [`127.0.0.1:${p}`, `localhost:${p}`]));
const outbound = net.filter((n) => n.kind === "connect" && !allowed.has(n.target) && !n.target.startsWith("/"));
check(outbound.length === 0, "dsh connected only to the local fakes", outbound.map((n) => n.target).join(", ") || `${net.filter((n) => n.kind === "connect").length} connect(s)`);
const dns = net.filter((n) => n.kind === "dns" && !["127.0.0.1", "localhost", "::1"].includes(n.target));
check(dns.length === 0, "dsh looked up no external host names", dns.map((n) => n.target).join(", "));
console.log(failed === 0 ? "\nprove: PASS" : `\nprove: FAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
JS
