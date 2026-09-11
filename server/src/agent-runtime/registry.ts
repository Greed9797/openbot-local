/**
 * Which providers this deployment has, and what each one can actually do.
 *
 * Adding a model family means adding an adapter to this list, not changing the browser, the
 * gateway or the loop. A provider that is not registered is a run that fails with
 * PROVIDER_UNAVAILABLE rather than a run that silently falls back to a different vendor.
 */
import type {
  AgentModelProvider,
  ModelCapabilities,
  ProviderRegistry,
} from "./contracts";

export function createProviderRegistry(
  providers: AgentModelProvider[],
): ProviderRegistry {
  return {
    get(id: string): AgentModelProvider | undefined {
      return providers.find((provider) => provider.id === id);
    },

    default(): AgentModelProvider | undefined {
      return providers[0];
    },

    list(): { id: string; capabilities: ModelCapabilities }[] {
      return providers.map((provider) => ({
        id: provider.id,
        capabilities: provider.capabilities,
      }));
    },
  };
}
