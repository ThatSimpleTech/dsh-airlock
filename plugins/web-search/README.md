# dsh-airlock-web-search

A web search provider for DSH (DeepSeek Harness) that uses the Brave Search API or a SearXNG server instead of DeepSeek's API. dsh-airlock installs and configures it for you; this is the reference if you want it on its own.

It registers with dsh's web seam (`ctx.web`) under the provider id `airlock-search`, so the shipped `web_search` tool uses it once `web.searchProvider` points there.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `backend` | `brave` | `brave` or `searxng` |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Credential reference for the Brave key, resolved through dsh's credential store (environment, `.credentials.yaml`, `.env` files) |
| `braveBaseURL` | `https://api.search.brave.com/res/v1` | Brave API base, for a proxy or tests |
| `searxngURL` | none | Base URL of the SearXNG instance, with any path prefix. The instance has to allow `json` in `search.formats`. |
| `timeoutMs` | `15000` | Per-search timeout |

Example patch rows:

```yaml
- id: web
  config:
    searchProvider: airlock-search
    fetchProvider: http
- id: web-search-deepseek
  disabled: true
- insert:
    - id: web-search-airlock
      name: 'dsh-airlock-web-search'
      config:
        backend: searxng
        searxngURL: 'https://search.example.org'
```

dsh only imports plugins in the dependency closure of `@deepseek-ai/dsh`'s `package.json`, or ones installed into a profile with `dsh plugin --profile <name> add`. dsh-airlock's `install.sh` takes the first route.

## Errors

Errors come back to the model as dsh `WebError`s with a code, and the messages tell the user what to do:

- `WEB_PROVIDER_CREDENTIAL_MISSING`: no Brave key. Set one with `dsh-airlock --set-key BRAVE_SEARCH_API_KEY`.
- `WEB_PROVIDER_UNAVAILABLE`: unknown backend or no SearXNG URL.
- `WEB_PROVIDER_ERROR`: HTTP errors, with hints for a rejected key (401/403), rate limits (429) and SearXNG instances that don't allow JSON (403).
- `WEB_TIMEOUT`, `WEB_ABORTED`, `WEB_INVALID_REQUEST`.

## Tests

```bash
npm test
```

`provider.js` has no dsh imports, so the tests run against local mock servers with no dsh install, network or keys.
