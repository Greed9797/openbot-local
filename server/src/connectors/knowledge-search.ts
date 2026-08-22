import { sql } from "drizzle-orm";
import type { Database } from "../db/client";

/**
 * Procurar no que os conectores trouxeram.
 *
 * Busca full-text do PostgreSQL, e não busca vetorial, por uma razão de contexto: este deployment
 * não usa chave de API de modelo — o modelo é o Codex CLI, por assinatura — e gerar embeddings
 * exigiria ou uma chave ou um modelo local de centenas de megabytes rodando na mesma VPS. A coluna
 * `embedding` existia e nenhuma consulta a lia; o texto sempre esteve ali ao lado.
 *
 * O que se perde: sinônimo e paráfrase. Perguntar "quanto posso gastar em viagem" não encontra um
 * documento que só diz "limite de despesas de deslocamento". `websearch_to_tsquery` cobre plural,
 * radical e negação, e é o suficiente para "cite a política que fala de X" — que é o que se pede a
 * um Bot de conhecimento. Quando houver embutidor, isto vira o primeiro estágio de um híbrido em vez
 * de sumir.
 */

/** Português primeiro: os documentos deste deployment são em português, e a raiz importa. */
const REGCONFIG = process.env.KNOWLEDGE_FTS_LANGUAGE?.trim() || "portuguese";

export type KnowledgePassage = {
  documentTitle: string;
  documentUrl: string;
  content: string;
  /** Quanto o PostgreSQL achou que este trecho responde. Maior é melhor. */
  rank: number;
};

export function createKnowledgeSearch(database: Database) {
  return {
    /**
     * Os trechos que respondem à pergunta, do mais forte para o mais fraco.
     *
     * Documentos apagados ficam de fora pelo `deleted_at`: um conector marca a exclusão em vez de
     * remover a linha, e sem este filtro o Bot citaria com confiança um documento que já não existe.
     */
    async search(question: string, limit = 6): Promise<KnowledgePassage[]> {
      const asked = question.trim();
      if (!asked) return [];

      const rows = await database.execute<{
        title: string;
        canonical_url: string;
        content: string;
        rank: number;
      }>(sql`
        select
          d.title,
          d.canonical_url,
          c.content,
          ts_rank(
            to_tsvector(${REGCONFIG}::regconfig, c.content),
            websearch_to_tsquery(${REGCONFIG}::regconfig, ${asked})
          ) as rank
        from chunks c
        join documents d on d.id = c.document_id
        where d.deleted_at is null
          and to_tsvector(${REGCONFIG}::regconfig, c.content)
              @@ websearch_to_tsquery(${REGCONFIG}::regconfig, ${asked})
        order by rank desc
        limit ${limit}
      `);

      return [...rows].map((row) => ({
        documentTitle: row.title,
        documentUrl: row.canonical_url,
        content: row.content,
        rank: Number(row.rank),
      }));
    },

    /** Quantos documentos vivos existem, para a tela de conectores poder dizer algo verdadeiro. */
    async count(): Promise<number> {
      const rows = await database.execute<{ total: number }>(
        sql`select count(*)::int as total from documents where deleted_at is null`,
      );
      return Number([...rows][0]?.total ?? 0);
    },
  };
}

export type KnowledgeSearch = ReturnType<typeof createKnowledgeSearch>;
