export type ConnectorUpsert = {
  kind: "upsert";
  sourceId: string;
  title: string;
  canonicalUrl: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  /**
   * O texto, em pedaços, e opcionalmente o vetor de cada um.
   *
   * `embedding` é opcional porque nada neste produto lê um ainda: a persistência escrevia vetores
   * que nenhuma consulta consultava. A recuperação hoje é a busca full-text do PostgreSQL sobre
   * `content` (ver knowledge-search.ts), que não precisa de vetor nem de chave de API. Um conector
   * que tenha um embutidor pode preencher; quando houver busca vetorial, os nulos são o que ela
   * precisa preencher.
   */
  chunks: { position: number; content: string; embedding?: number[] }[];
  acls: { principal: string; effect: "allow" | "deny" }[];
};

export type ConnectorDelete = {
  kind: "delete";
  sourceId: string;
};

export type ConnectorChange = ConnectorUpsert | ConnectorDelete;

export type ConnectorAdapter = {
  discover: (input: {
    cursor: string | null;
    mode: "sync" | "reconcile";
  }) => Promise<{
    changes: ConnectorChange[];
    nextCursor: string | null;
  }>;
};
