// Search backends for the dsh-airlock web search provider: the Brave Search API,
// the Tavily Search API, or a SearXNG instance. This module has no DeepSeek
// Harness imports so it can be tested on its own; index.js wires it into the
// harness's web seam (ctx.web).

export const PROVIDER_ID = "airlock-search";
export const BRAVE_DEFAULT_BASE_URL = "https://api.search.brave.com/res/v1";
export const TAVILY_DEFAULT_BASE_URL = "https://api.tavily.com";
export const DEFAULT_TIMEOUT_MS = 15000;
export const BACKENDS = ["brave", "tavily", "searxng"];

const BRAVE_MAX_COUNT = 20;
const TAVILY_MAX_RESULTS = 20;
const DEFAULT_COUNT = 10;
const ERROR_BODY_CHARS = 300;

/**
 * Remove HTML tags and decode the few entities search APIs put in titles and
 * snippets (Brave wraps matched terms in <strong>). `&amp;` is decoded last so
 * an encoded entity such as `&amp;lt;` stays literal text.
 */
export function plainText(value) {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0 ? text : undefined;
}

function isHttpUrl(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return false;
  const { protocol } = new URL(value);
  return protocol === "http:" || protocol === "https:";
}

function source(url, title, snippet, publishedAt) {
  const out = { url };
  if (title !== undefined) out.title = title;
  if (snippet !== undefined) out.snippet = snippet;
  if (typeof publishedAt === "string" && publishedAt.length > 0) out.publishedAt = publishedAt;
  return out;
}

/** Map a Brave Search API `web/search` response to portable sources. */
export function braveSources(body) {
  const results = Array.isArray(body?.web?.results) ? body.web.results : [];
  return results
    .filter((r) => isHttpUrl(r?.url))
    .map((r) => source(r.url, plainText(r.title), plainText(r.description), r.page_age));
}

/** Map a Tavily `/search` response to portable sources. */
export function tavilySources(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => isHttpUrl(r?.url))
    .map((r) => source(r.url, plainText(r.title), plainText(r.content), r.published_date));
}

/** Map a SearXNG `format=json` response to portable sources. */
export function searxngSources(body) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .filter((r) => isHttpUrl(r?.url))
    .map((r) => source(r.url, plainText(r.title), plainText(r.content), r.publishedDate ?? undefined));
}

/** Join `path` onto a base URL, keeping any path prefix the base already has. */
export function joinUrl(base, path) {
  const withSlash = base.endsWith("/") ? base : base + "/";
  return new URL(path, withSlash);
}

/**
 * Create the search provider.
 * @param {object} deps
 * @param {() => object} deps.resolveOptions - current options, re-read on every call:
 *   { backend, braveBaseURL, braveApiKeyEnv, tavilyBaseURL, tavilyApiKeyEnv, searxngURL,
 *   timeoutMs, resolveApiKey(ref) }.
 * @param {typeof fetch} [deps.fetch] - fetch implementation (tests pass their own).
 * @param {(message: string, code: string, options?: object) => Error} deps.makeError -
 *   builds the harness's typed WebError.
 */
export function createSearchProvider({ resolveOptions, fetch: fetchImpl = globalThis.fetch, makeError }) {
  async function callJson(url, init, label, signal, timeoutMs) {
    if (signal?.aborted) throw makeError(`${label} search aborted`, "WEB_ABORTED", { cause: signal.reason });
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw makeError(`${label} search aborted`, "WEB_ABORTED", { cause: error });
      if (timeout.aborted) throw makeError(`${label} search timed out after ${timeoutMs} ms`, "WEB_TIMEOUT", { cause: error });
      const reason = error?.cause?.code ?? error?.message ?? String(error);
      throw makeError(
        `${label} search could not reach ${new URL(url).host} (${reason}). If this network blocks it, ` +
          "the user can switch backends outside the app with `dsh-airlock --search brave|tavily|searxng <url>`.",
        "WEB_PROVIDER_ERROR",
        { cause: error },
      );
    }
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, text: text.slice(0, ERROR_BODY_CHARS) };
    try {
      return { ok: true, body: JSON.parse(text) };
    } catch (error) {
      throw makeError(`${label} returned a response that is not JSON`, "WEB_PROVIDER_ERROR", { cause: error });
    }
  }

  async function requireKey(options, label, ref, signupUrl) {
    const apiKey = await options.resolveApiKey(ref);
    if (apiKey) return apiKey;
    throw makeError(
      `${label} has no API key in ${ref}. The user can add one outside the app with ` +
        `\`dsh-airlock --set-key ${ref}\` (keys: ${signupUrl}), ` +
        "or pick another backend with `dsh-airlock --search brave|tavily|searxng <url>`.",
      "WEB_PROVIDER_CREDENTIAL_MISSING",
    );
  }

  async function searchBrave(options, query, maxResults, signal) {
    const apiKey = await requireKey(options, "Brave Search", options.braveApiKeyEnv, "https://brave.com/search/api/");
    const url = joinUrl(options.braveBaseURL, "web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(maxResults ?? DEFAULT_COUNT, BRAVE_MAX_COUNT)));
    const result = await callJson(
      url,
      { headers: { Accept: "application/json", "X-Subscription-Token": apiKey } },
      "Brave",
      signal,
      options.timeoutMs,
    );
    if (!result.ok) {
      const hint =
        result.status === 401 || result.status === 403
          ? " The API key was rejected; set a new one with `dsh-airlock --set-key " + options.braveApiKeyEnv + "`."
          : result.status === 429
            ? " The plan's rate limit or monthly quota is used up."
            : "";
      throw makeError(`Brave Search returned HTTP ${result.status}.${hint} ${result.text}`.trim(), "WEB_PROVIDER_ERROR");
    }
    return braveSources(result.body);
  }

  async function searchTavily(options, query, maxResults, signal) {
    const apiKey = await requireKey(options, "Tavily search", options.tavilyApiKeyEnv, "https://app.tavily.com/");
    const result = await callJson(
      joinUrl(options.tavilyBaseURL, "search"),
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          query,
          max_results: Math.min(maxResults ?? DEFAULT_COUNT, TAVILY_MAX_RESULTS),
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
      },
      "Tavily",
      signal,
      options.timeoutMs,
    );
    if (!result.ok) {
      const hint =
        result.status === 401
          ? " The API key was rejected; set a new one with `dsh-airlock --set-key " + options.tavilyApiKeyEnv + "`."
          : result.status === 429
            ? " Rate limited; try again shortly."
            : result.status === 432 || result.status === 433
              ? " The plan's credit or spending limit is used up."
              : "";
      throw makeError(`Tavily returned HTTP ${result.status}.${hint} ${result.text}`.trim(), "WEB_PROVIDER_ERROR");
    }
    return tavilySources(result.body);
  }

  async function searchSearxng(options, query, maxResults, signal) {
    const url = joinUrl(options.searxngURL, "search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const result = await callJson(url, { headers: { Accept: "application/json" } }, "SearXNG", signal, options.timeoutMs);
    if (!result.ok) {
      const hint =
        result.status === 403
          ? " The instance may not allow JSON output; add `json` to `search.formats` in its settings.yml."
          : result.status === 429
            ? " The instance is rate limiting this client."
            : "";
      throw makeError(`SearXNG returned HTTP ${result.status}.${hint} ${result.text}`.trim(), "WEB_PROVIDER_ERROR");
    }
    const sources = searxngSources(result.body);
    return maxResults === undefined ? sources : sources.slice(0, maxResults);
  }

  return {
    id: PROVIDER_ID,
    /** Local check only: a known backend with a usable base URL. No network. */
    available() {
      const options = resolveOptions();
      if (options.backend === "brave") return isHttpUrl(options.braveBaseURL);
      if (options.backend === "tavily") return isHttpUrl(options.tavilyBaseURL);
      if (options.backend === "searxng") return isHttpUrl(options.searxngURL);
      return false;
    },
    async search(request, signal) {
      const options = resolveOptions();
      const query = typeof request?.query === "string" ? request.query.trim() : "";
      if (query.length === 0) throw makeError("search query is empty", "WEB_INVALID_REQUEST");
      const maxResults = Number.isInteger(request.maxResults) && request.maxResults > 0 ? request.maxResults : undefined;
      let sources;
      if (options.backend === "brave") sources = await searchBrave(options, query, maxResults, signal);
      else if (options.backend === "tavily") sources = await searchTavily(options, query, maxResults, signal);
      else if (options.backend === "searxng") {
        if (!isHttpUrl(options.searxngURL)) {
          throw makeError(
            "SearXNG search has no server URL. Set one outside the app with `dsh-airlock --search searxng <url>`.",
            "WEB_PROVIDER_UNAVAILABLE",
          );
        }
        sources = await searchSearxng(options, query, maxResults, signal);
      } else {
        throw makeError(`unknown search backend "${options.backend}" (use ${BACKENDS.join(" or ")})`, "WEB_PROVIDER_UNAVAILABLE");
      }
      return { sources, truncated: false };
    },
  };
}
