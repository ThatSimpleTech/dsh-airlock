// DeepSeek Harness plugin: registers the dsh-airlock search provider (Brave
// Search or SearXNG) with the web seam, replacing the DeepSeek-only provider.
// Loaded by the patch layer dsh-airlock writes; see the repo README.
import z from "@deepseek-ai/schemastery";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { WebError } from "@deepseek-ai/dsh-web";
import { BRAVE_DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, PROVIDER_ID, createSearchProvider } from "./provider.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "web-search-airlock";
/** The web seam this provider registers into. */
export const inject = ["web"];

export const Config = z.object({
  backend: z.string().default("brave").volatile(),
  braveApiKeyEnv: z.string().role("credential-ref").default("BRAVE_SEARCH_API_KEY").volatile(),
  braveBaseURL: z.string().default(BRAVE_DEFAULT_BASE_URL).volatile(),
  searxngURL: z.string().volatile(),
  timeoutMs: z.number().step(1).min(1000).default(DEFAULT_TIMEOUT_MS).volatile(),
});

export { PROVIDER_ID };

/**
 * Resolve a credential reference the same way the shipped providers do: the
 * harness credential store (environment, `.credentials.yaml`, `.env` files),
 * falling back to the launch environment when the store is not mounted.
 */
async function resolveApiKey(ctx, ref) {
  const reference = credentialRef(ref);
  const credentials = ctx.get("credentials");
  if (credentials !== undefined) return (await credentials.resolve(reference))?.value;
  const ambient = launchEnvironmentOf(ctx).get(reference);
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined;
}

export function apply(ctx, config) {
  ctx.web.registerSearchProvider(
    createSearchProvider({
      resolveOptions: () => ({
        backend: config.backend.get(),
        braveApiKeyEnv: config.braveApiKeyEnv.get(),
        braveBaseURL: config.braveBaseURL.get(),
        searxngURL: config.searxngURL.get(),
        timeoutMs: config.timeoutMs.get(),
        resolveApiKey: (ref) => resolveApiKey(ctx, ref),
      }),
      makeError: (message, code, options) => new WebError(message, code, options),
    }),
  );
}
