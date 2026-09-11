/**
 * Os modelos que este deployment tem, gravados para quem precisa listá-los.
 *
 * O ambiente é a fonte; esta tabela é a cópia que a interface e o Telegram leem. Copiar não é
 * duplicar por gosto: um comando `/modelo` no Telegram não deve receber uma credencial nem viver no
 * processo que tem uma, e um painel precisa mostrar o que existe sem abrir o `.env` de ninguém.
 *
 * `testedAt` fica nulo até alguém rodar o teste de canvas contra o modelo. É o campo que transforma
 * "presumidamente tem visão" em "homologado", e é por isso que ele não é preenchido aqui.
 */
import { eq } from "drizzle-orm";
import type { AgentModelConfig } from "../config";
import type { Database } from "../db/client";
import { modelConfigurations } from "../db/schema";

export type StoredModelConfiguration = typeof modelConfigurations.$inferSelect;

export function createModelConfigurationStore(database: Database) {
  return {
    /** Grava o que o ambiente diz, sem apagar o que já foi homologado. */
    async sync(
      configs: AgentModelConfig[],
    ): Promise<StoredModelConfiguration[]> {
      for (const config of configs) {
        const capabilities = {
          vision: config.vision,
          tools: config.tools,
          mode: config.transport === "codex" ? "delegated" : "step",
        };
        await database
          .insert(modelConfigurations)
          .values({
            id: config.id,
            provider: config.id,
            transport: config.transport,
            modelId: config.model,
            baseUrl: config.baseUrl ?? null,
            capabilities,
            enabled: true,
          })
          .onConflictDoUpdate({
            target: modelConfigurations.id,
            set: {
              transport: config.transport,
              modelId: config.model,
              baseUrl: config.baseUrl ?? null,
              capabilities,
              enabled: true,
              updatedAt: new Date(),
            },
          });
      }
      return this.list();
    },

    async list(): Promise<StoredModelConfiguration[]> {
      return database.select().from(modelConfigurations);
    },

    async get(id: string): Promise<StoredModelConfiguration | undefined> {
      const [row] = await database
        .select()
        .from(modelConfigurations)
        .where(eq(modelConfigurations.id, id))
        .limit(1);
      return row;
    },

    /**
     * Marca que este modelo passou por um teste de verdade.
     *
     * Chamado por quem roda a verificação — hoje o teste de homologação manual, amanhã um endpoint
     * de administração. Nenhum caminho automático chega aqui: um selo de compatibilidade dado pelo
     * próprio código que ele deveria estar provando não vale nada.
     */
    async markTested(
      id: string,
      capabilities: { vision: boolean; tools: boolean },
    ): Promise<StoredModelConfiguration | undefined> {
      const [row] = await database
        .update(modelConfigurations)
        .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
        .where(eq(modelConfigurations.id, id))
        .returning();
      return row;
    },
  };
}

export type ModelConfigurationStore = ReturnType<
  typeof createModelConfigurationStore
>;
