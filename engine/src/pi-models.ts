/**
 * The engine's one pi-ai model registry (`createModels()`), shared by workflow
 * text calls, the vision critic and the chat agent.
 *
 * Providers are dispatched by `model.provider`: `anthropic` is pi-ai's own
 * provider, `openai` is any OpenAI-compatible chat-completions endpoint, and
 * the fake providers are scripted faux providers registered on demand.
 *
 * Keys come from engine config and are passed per request; when none is set,
 * the provider falls back to its usual env var (OPENAI_API_KEY,
 * ANTHROPIC_API_KEY, …), as the old global pi-ai API did. Keys are never logged.
 */
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export const piModels = createModels();
piModels.setProvider(anthropicProvider());
piModels.setProvider(
  createProvider({
    id: "openai",
    name: "OpenAI-compatible",
    auth: { apiKey: envApiKeyAuth("OpenAI API key", ["OPENAI_API_KEY"]) },
    models: [],
    api: openAICompletionsApi(),
  }),
);

/** A blank key means "not configured", so the provider's env fallback applies. */
export const requestKey = (key: string | undefined): string | undefined => key?.trim() || undefined;

/** Register a scripted faux provider on the shared registry. */
export function registerFake(options: RegisterFauxProviderOptions): FauxProviderHandle {
  const handle = fauxProvider(options);
  piModels.setProvider(handle.provider);
  return handle;
}
