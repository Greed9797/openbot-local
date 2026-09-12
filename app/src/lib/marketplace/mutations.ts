import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { agentKeys } from "@/lib/agents/queries";
import { pluginKeys } from "@/lib/plugins/queries";
import type { BotTemplate } from "@/components/marketplace/bot-templates";

const FALLBACK = "Não foi possível instalar a partir do marketplace.";

/**
 * Install a bot from a template: create the agent, then grant each template skill.
 * Skills and grants reuse the existing endpoints; failures surface the server's message.
 */
export function installBotMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (template: BotTemplate): Promise<void> => {
      const agent = await client<{ id: string }>("/api/agents", "agent", {
        method: "POST",
        body: {
          name: template.name,
          title: template.title,
          roleDescription: template.description,
          visibility: "private",
        },
        fallback: FALLBACK,
      });
      for (const skill of template.skills) {
        await client("/api/plugins/grants", {
          method: "POST",
          body: { kind: "skill", ref: skill, agentId: agent.id },
          fallback: FALLBACK,
        });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.all });
      void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
    },
  });
}
