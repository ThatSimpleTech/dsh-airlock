// Local stand-ins for the proof run, all on 127.0.0.1 with OS-assigned ports:
//   model - an OpenAI-compatible chat endpoint that drives the agent through a
//           shell probe, then a web search, then a final answer.
//   brave  - a fake Brave Search API that checks the subscription token.
//   tavily - a fake Tavily Search API that checks the bearer key.
//   trap  - where every DeepSeek endpoint is pointed; any hit is a failure.
// Usage: node mock-servers.mjs <outdir> <canary-path>. Writes <outdir>/ports.json
// and one JSONL log per server.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const [outDir, canary] = process.argv.slice(2);
if (!outDir || !canary) {
  console.error("usage: node mock-servers.mjs <outdir> <canary-path>");
  process.exit(2);
}
const log = (name, entry) => fs.appendFileSync(path.join(outDir, `${name}.jsonl`), JSON.stringify(entry) + "\n");
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

const PROBE = [
  "echo hello > airlock-probe.txt && echo WROTE_WORKSPACE",
  `head -c1 '${canary}' >/dev/null 2>&1 && echo CANARY_READABLE || echo CANARY_BLOCKED`,
  "/usr/bin/open -g -a TextEdit >/dev/null 2>&1 && echo OPEN_WORKED || echo OPEN_BLOCKED",
  "/usr/bin/curl -s -m 5 -o /dev/null https://example.com/ && echo EXTERNAL_REACHABLE || echo EXTERNAL_BLOCKED",
].join("; ");

const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const chunk = (delta, finish = null) => ({ id: "mock", object: "chat.completion.chunk", created: 0, model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage } : {}) });
function sse(res, chunks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const c of chunks) res.write("data: " + JSON.stringify(c) + "\n\n");
  res.end("data: [DONE]\n\n");
}
const toolCall = (id, name, args) => [chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }), chunk({}, "tool_calls")];
const text = (s) => [chunk({ role: "assistant", content: s }), chunk({}, "stop")];
const content = (m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));

function argsFor(tool, primary) {
  const params = tool.function.parameters ?? {};
  const out = {};
  for (const key of params.required ?? []) {
    const type = params.properties?.[key]?.type;
    out[key] = type === "array" ? [primary] : type === "number" || type === "integer" ? 60000 : type === "boolean" ? false : primary;
  }
  return out;
}

const model = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  if (req.url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
  }
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const messages = body.messages ?? [];
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  const toolResults = messages.slice(lastUser + 1).filter((m) => m.role === "tool").map(content);
  const tools = body.tools ?? [];
  log("model", { keys: Object.keys(body), store: body.store, tools: tools.map((t) => t.function?.name), toolResults: toolResults.map((r) => r.slice(0, 800)) });
  const bash = tools.find((t) => t.function?.name === "bash");
  const search = tools.find((t) => t.function?.name === "web_search");
  if (bash && toolResults.length === 0) return sse(res, toolCall("call_probe", "bash", { ...argsFor(bash, "probe"), command: PROBE }));
  if (search && toolResults.length === 1) return sse(res, toolCall("call_search", "web_search", argsFor(search, "airlock proof query")));
  return sse(res, text(toolResults.length ? "PROOF RESULTS: " + toolResults.join(" | ").replace(/\s+/g, " ").slice(0, 2000) : "Mock reply."));
});

const brave = http.createServer(async (req, res) => {
  await readBody(req);
  const url = new URL(req.url, "http://localhost");
  const token = req.headers["x-subscription-token"];
  log("brave", { path: url.pathname, q: url.searchParams.get("q"), count: url.searchParams.get("count"), tokenOk: token === "prove-brave-key" });
  if (token !== "prove-brave-key") { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ web: { results: [{ url: "https://example.com/airlock", title: "<strong>Airlock</strong> mock result", description: "served by the fake Brave API" }] } }));
});

const tavily = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  let body = {};
  try { body = JSON.parse(raw); } catch {}
  const url = new URL(req.url, "http://localhost");
  const tokenOk = req.headers.authorization === "Bearer prove-tavily-key";
  log("tavily", { method: req.method, path: url.pathname, query: body.query, max_results: body.max_results, tokenOk });
  if (!tokenOk || req.method !== "POST") { res.writeHead(401); return res.end("{}"); }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ query: body.query, results: [{ url: "https://example.net/tavily", title: "Tavily mock result", content: "served by the fake Tavily API", score: 0.9 }], response_time: 0.1 }));
});

const trap = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  log("trap", { method: req.method, url: req.url, host: req.headers.host, bytes: raw.length });
  res.writeHead(503);
  res.end();
});

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const ports = { model: await listen(model), brave: await listen(brave), tavily: await listen(tavily), trap: await listen(trap) };
fs.writeFileSync(path.join(outDir, "ports.json"), JSON.stringify(ports));
console.log("mock servers", ports);
