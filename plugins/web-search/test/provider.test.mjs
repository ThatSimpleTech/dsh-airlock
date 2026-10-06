// Unit tests for the search backends against local mock servers. No network,
// no API keys, no DeepSeek Harness install needed: run with `node --test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createSearchProvider, plainText, joinUrl, braveSources, searxngSources } from "../provider.js";

class TestWebError extends Error {
  constructor(message, code, options) {
    super(message, options);
    this.code = code;
  }
}
const makeError = (message, code, options) => new TestWebError(message, code, options);

let server;
let base;
const seen = [];
let respond = () => ({ status: 200, body: {} });

before(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
    const out = respond(url, req);
    if (out.hang) return; // never answer: exercises the timeout path
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

function provider(overrides = {}) {
  return createSearchProvider({
    makeError,
    resolveOptions: () => ({
      backend: "brave",
      braveApiKeyEnv: "BRAVE_SEARCH_API_KEY",
      braveBaseURL: `${base}/brave/res/v1`,
      tavilyApiKeyEnv: "TAVILY_API_KEY",
      tavilyBaseURL: `${base}/tavily`,
      searxngURL: undefined,
      timeoutMs: 2000,
      resolveApiKey: async () => "test-key",
      ...overrides,
    }),
  });
}

test("plainText strips tags and decodes entities once", () => {
  assert.equal(plainText("<strong>Rust</strong> &amp; Go &lt;3"), "Rust & Go <3");
  assert.equal(plainText("a &amp;lt; b"), "a &lt; b");
  assert.equal(plainText("  spaced\n  out  "), "spaced out");
  assert.equal(plainText("<b></b>"), undefined);
  assert.equal(plainText(42), undefined);
});

test("joinUrl keeps a base path prefix", () => {
  assert.equal(joinUrl("https://host/searx", "search").href, "https://host/searx/search");
  assert.equal(joinUrl("https://host/searx/", "search").href, "https://host/searx/search");
  assert.equal(joinUrl("https://api.search.brave.com/res/v1", "web/search").href, "https://api.search.brave.com/res/v1/web/search");
});

test("result mappers drop entries without an http(s) url", () => {
  assert.deepEqual(braveSources({ web: { results: [{ url: "javascript:alert(1)" }, { title: "no url" }] } }), []);
  assert.deepEqual(searxngSources({ results: [{ url: "file:///etc/passwd" }] }), []);
  assert.deepEqual(braveSources(null), []);
});

test("brave: sends the key and query, maps and cleans results", async () => {
  seen.length = 0;
  respond = () => ({
    status: 200,
    body: {
      web: {
        results: [
          { url: "https://example.com/a", title: "<strong>Airlock</strong> one", description: "first &amp; best", page_age: "2026-10-01T00:00:00" },
          { url: "https://example.com/b", title: "Two", description: "" },
        ],
      },
    },
  });
  const result = await provider().search({ query: "airlock test", maxResults: 5 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, "/brave/res/v1/web/search");
  assert.equal(seen[0].query.q, "airlock test");
  assert.equal(seen[0].query.count, "5");
  assert.equal(seen[0].headers["x-subscription-token"], "test-key");
  assert.deepEqual(result, {
    truncated: false,
    sources: [
      { url: "https://example.com/a", title: "Airlock one", snippet: "first & best", publishedAt: "2026-10-01T00:00:00" },
      { url: "https://example.com/b", title: "Two" },
    ],
  });
});

test("brave: caps count at 20 and defaults to 10", async () => {
  seen.length = 0;
  respond = () => ({ status: 200, body: { web: { results: [] } } });
  await provider().search({ query: "x", maxResults: 50 });
  await provider().search({ query: "x" });
  assert.deepEqual(seen.map((s) => s.query.count), ["20", "10"]);
});

test("brave: missing key fails before any request, with setup instructions", async () => {
  seen.length = 0;
  await assert.rejects(provider({ resolveApiKey: async () => undefined }).search({ query: "x" }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_CREDENTIAL_MISSING");
    assert.match(error.message, /dsh-airlock --set-key BRAVE_SEARCH_API_KEY/);
    return true;
  });
  assert.equal(seen.length, 0);
});

test("brave: rejected key and rate limit produce hints", async () => {
  respond = () => ({ status: 401, body: { error: "bad token" } });
  await assert.rejects(provider().search({ query: "x" }), /HTTP 401\. The API key was rejected/);
  respond = () => ({ status: 429, body: "slow down" });
  await assert.rejects(provider().search({ query: "x" }), /HTTP 429\. The plan's rate limit/);
});

test("tavily: posts the query with a bearer key and maps results", async () => {
  seen.length = 0;
  let posted;
  respond = (url, req) => {
    posted = req;
    return {
      status: 200,
      body: {
        query: "q",
        results: [
          { url: "https://example.net/t1", title: "Tavily <b>one</b>", content: "first &amp; only", score: 0.9, published_date: "2026-10-02" },
          { url: "ftp://example.net/skip", title: "skip me", content: "" },
        ],
        response_time: 0.4,
      },
    };
  };
  const result = await provider({ backend: "tavily", resolveApiKey: async (ref) => (ref === "TAVILY_API_KEY" ? "tvly-test" : undefined) }).search({ query: "airlock", maxResults: 30 });
  assert.equal(seen[0].path, "/tavily/search");
  assert.equal(posted.method, "POST");
  assert.equal(seen[0].headers.authorization, "Bearer tvly-test");
  assert.deepEqual(seen[0].body, { query: "airlock", max_results: 20, search_depth: "basic", include_answer: false, include_raw_content: false });
  assert.deepEqual(result.sources, [{ url: "https://example.net/t1", title: "Tavily one", snippet: "first & only", publishedAt: "2026-10-02" }]);
});

test("tavily: missing key, rejected key and spent credits explain themselves", async () => {
  await assert.rejects(provider({ backend: "tavily", resolveApiKey: async () => undefined }).search({ query: "x" }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_CREDENTIAL_MISSING");
    assert.match(error.message, /dsh-airlock --set-key TAVILY_API_KEY/);
    return true;
  });
  respond = () => ({ status: 401, body: { detail: "invalid key" } });
  await assert.rejects(provider({ backend: "tavily" }).search({ query: "x" }), /HTTP 401\. The API key was rejected/);
  respond = () => ({ status: 432, body: { detail: "limit" } });
  await assert.rejects(provider({ backend: "tavily" }).search({ query: "x" }), /HTTP 432\. The plan's credit/);
});

test("searxng: requests json from the instance path and maps results", async () => {
  seen.length = 0;
  respond = () => ({
    status: 200,
    body: {
      results: [
        { url: "https://example.org/1", title: "One", content: "c1", publishedDate: null },
        { url: "https://example.org/2", title: "Two", content: "c2", publishedDate: "2026-09-30" },
        { url: "https://example.org/3", title: "Three", content: "c3" },
      ],
    },
  });
  const p = provider({ backend: "searxng", searxngURL: `${base}/searx` });
  const result = await p.search({ query: "q", maxResults: 2 });
  assert.equal(seen[0].path, "/searx/search");
  assert.equal(seen[0].query.format, "json");
  assert.equal(seen[0].headers["x-subscription-token"], undefined);
  assert.deepEqual(result.sources, [
    { url: "https://example.org/1", title: "One", snippet: "c1" },
    { url: "https://example.org/2", title: "Two", snippet: "c2", publishedAt: "2026-09-30" },
  ]);
});

test("searxng: 403 explains the json format setting; missing url is unavailable", async () => {
  respond = () => ({ status: 403, body: "Forbidden" });
  await assert.rejects(provider({ backend: "searxng", searxngURL: `${base}/searx` }).search({ query: "q" }), /search\.formats/);
  const p = provider({ backend: "searxng", searxngURL: undefined });
  assert.equal(p.available(), false);
  await assert.rejects(p.search({ query: "q" }), (error) => error.code === "WEB_PROVIDER_UNAVAILABLE");
});

test("an unreachable or blocked host names the host and how to switch backends", async () => {
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadPort = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  await assert.rejects(provider({ braveBaseURL: `http://127.0.0.1:${deadPort}/res/v1` }).search({ query: "x" }), (error) => {
    assert.equal(error.code, "WEB_PROVIDER_ERROR");
    assert.match(error.message, new RegExp(`could not reach 127\\.0\\.0\\.1:${deadPort} \\(ECONNREFUSED\\)`));
    assert.match(error.message, /dsh-airlock --search/);
    return true;
  });
});

test("non-JSON success body is a provider error", async () => {
  respond = () => ({ status: 200, body: "<html>captcha</html>" });
  await assert.rejects(provider().search({ query: "x" }), /not JSON/);
});

test("available() is local and backend-aware", () => {
  assert.equal(provider().available(), true);
  assert.equal(provider({ braveBaseURL: "not a url" }).available(), false);
  assert.equal(provider({ backend: "deepseek-official" }).available(), false);
  assert.equal(provider({ backend: "searxng", searxngURL: "ftp://host" }).available(), false);
});

test("empty query and unknown backend are rejected", async () => {
  await assert.rejects(provider().search({ query: "   " }), (error) => error.code === "WEB_INVALID_REQUEST");
  await assert.rejects(provider({ backend: "other" }).search({ query: "x" }), (error) => error.code === "WEB_PROVIDER_UNAVAILABLE");
});

test("caller abort and timeout map to distinct codes", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider().search({ query: "x" }, controller.signal), (error) => error.code === "WEB_ABORTED");
  respond = () => ({ hang: true });
  await assert.rejects(provider({ timeoutMs: 1000 }).search({ query: "x" }), (error) => error.code === "WEB_TIMEOUT");
});
