import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun runs test files in one process: a second unconditional register throws.
if (typeof document === "undefined") {
  GlobalRegistrator.register();
}

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { agentStores, copilotFake, resetCopilotFake } from "./copilot-fake";

// The shared fake runtime, not one of this file's own: see tests/copilot-fake.ts.
mock.module("@copilotkit/react-core/v2", copilotFake);

/*
 * The direct chat is held back rather than stubbed. `useBotThread` answers `undefined` until the
 * thread is known, and the page already renders nothing for the packaged chat until then, so this
 * is a state production has — and it keeps the packaged component, whose client surface is the
 * vendor's business and not ours, out of a test about which conversation the tab shows.
 */
mock.module("@/lib/copilot/bot-thread", () => ({
  useBotThread: () => undefined,
}));

/*
 * Deliberately dynamic: a static import is hoisted above the `register` call, and `render` binds
 * `document.body` while it evaluates.
 */
const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const { BotTabs } = await import("../src/components/bot/bot-tabs");
const { BotHistoryList } = await import(
  "../src/components/channels/bot-history-list"
);
const { BotHistoryDetail } = await import(
  "../src/components/channels/bot-history-detail"
);
const { BotPage } = await import("../src/routes/_authed/_app/bot");

import type { ChannelSummary } from "../src/lib/channels/queries";

type Seed = {
  id: string;
  name: string;
  lastMessage: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  threadId: string;
};

let conversas: Seed[] = [];
let pedidos: { url: string; method: string; body?: unknown }[] = [];
let realFetch: typeof fetch;
const views: { unmount: () => void }[] = [];
let channelSeq = 0;
const mensagensPorThread = new Map<string, Message[]>();

function seed(parcial: Partial<Seed> & { id: string }): Seed {
  return {
    name: `Conversa ${parcial.id}`,
    lastMessage: null,
    lastMessageAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    threadId: `thread-${parcial.id}`,
    ...parcial,
  };
}

function resumo(c: Seed): ChannelSummary {
  return {
    id: c.id,
    name: c.name,
    agentIds: ["bot-1"],
    threadId: c.threadId,
    active: true,
    lastMessage: c.lastMessage,
    lastMessageAt: c.lastMessageAt,
    lastMessageAgentId: "bot-1",
    createdAt: c.createdAt,
  };
}

function atividade(c: Seed): string {
  return c.lastMessageAt ?? c.createdAt;
}

beforeEach(() => {
  conversas = [];
  pedidos = [];
  channelSeq = 0;
  resetCopilotFake();
  mensagensPorThread.clear();
  mensagensPorThread.set("thread-c1", [
    { id: "m1", role: "user", content: "Quanto foi o almoço?" },
    { id: "m2", role: "assistant", content: "Foi quarenta e dois." },
  ] as Message[]);
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    pedidos.push({ url, method, body });
    const u = new URL(url, "http://openbot.test");

    if (u.pathname === "/api/agents/fantasma") {
      return new Response(JSON.stringify({ error: "Agent not found." }), {
        status: 404,
      });
    }
    if (u.pathname === "/api/agents/bot-1") {
      // Envelopado em `agent`: é o que `client(..., "agent")` desembrulha.
      return Response.json({
        agent: {
          id: "bot-1",
          name: "Bot Um",
          title: "Bot",
          roleDescription: "Ajuda.",
          avatarSeed: "bot-1",
          visibility: "private",
          endpoint: null,
          provider: null,
          model: null,
          allowPrivateNavigation: false,
          hasAuth: false,
          hasCallbackToken: false,
          hidden: false,
          systemOwned: false,
          canManage: true,
          mine: true,
        },
      });
    }
    if (u.pathname === "/api/bots/bot-1/conversas") {
      const q = (u.searchParams.get("q") ?? "").toLowerCase();
      const cursor = u.searchParams.get("cursor");
      const limit = Number(u.searchParams.get("limit") ?? "20");
      const lista = conversas
        .filter((c) =>
          q
            ? c.name.toLowerCase().includes(q) ||
              (c.lastMessage ?? "").toLowerCase().includes(q)
            : true,
        )
        .sort(
          (a, b) =>
            atividade(b).localeCompare(atividade(a)) ||
            b.id.localeCompare(a.id),
        );
      let start = 0;
      if (cursor) {
        const i = lista.findIndex((c) => c.id === cursor);
        start = i === -1 ? lista.length : i + 1;
      }
      const page = lista.slice(start, start + limit);
      const sobrou = lista.length - start - page.length;
      return Response.json({
        conversas: page.map(resumo),
        ...(sobrou > 0 && page.length > 0
          ? { nextCursor: page.at(-1)?.id }
          : {}),
      });
    }
    if (u.pathname === "/api/channels" && method === "POST") {
      channelSeq += 1;
      const pedido = (body ?? {}) as {
        agentIds?: string[];
        visivelNoRoster?: boolean;
      };
      const created = {
        id: `channel-nova-${channelSeq}`,
        name: "Bot Um",
        agentIds: pedido.agentIds ?? ["bot-1"],
        threadId: `thread-nova-${channelSeq}`,
        active: true,
      };
      conversas.push(
        seed({
          id: created.id,
          name: created.name,
          threadId: created.threadId,
          createdAt: "2026-03-01T00:00:00.000Z",
        }),
      );
      return new Response(JSON.stringify({ channel: created }), {
        status: 201,
      });
    }
    const thread = u.pathname.match(
      /^\/api\/copilotkit\/threads\/([^/]+)\/messages/,
    );
    if (thread) {
      // Per thread, not one canned answer: a conversation that opens with another
      // one's messages is the bug these cases exist to catch.
      return Response.json({
        messages:
          mensagensPorThread.get(decodeURIComponent(thread[1] as string)) ?? [],
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  /*
   * Unmounted and then cleaned: a live tree keeps queries that would land in the next tally, and
   * `cleanup` also takes the containers out of `document.body`. Bun shares one document across
   * files, so a tree left behind here is a duplicate match in the next file's queries.
   */
  for (const view of views.splice(0)) view.unmount();
  cleanup();
  globalThis.fetch = realFetch;
  conversas = [];
  pedidos = [];
});

function mount(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
  views.push(view);
  return { view, client };
}

function noop() {}

describe("abas do bot", () => {
  test("mostra Conversa e Histórico", () => {
    mount(<BotTabs conversa={<p>ca</p>} historico={<p>hi</p>} />);

    expect(screen.getByRole("tab", { name: "Conversa" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "Histórico" })).toBeDefined();
  });

  test("rascunho da conversa sobrevive à troca de aba", () => {
    mount(
      <BotTabs
        conversa={<input data-testid="rascunho" />}
        historico={<p>histórico</p>}
      />,
    );

    const campo = screen.getByTestId("rascunho") as HTMLInputElement;
    fireEvent.change(campo, { target: { value: "minuta" } });
    fireEvent.click(screen.getByRole("tab", { name: "Histórico" }));
    fireEvent.click(screen.getByRole("tab", { name: "Conversa" }));

    expect((screen.getByTestId("rascunho") as HTMLInputElement).value).toBe(
      "minuta",
    );
  });
});

describe("lista do histórico", () => {
  test("busca pergunta ao servidor, não filtra local", async () => {
    conversas = [
      seed({ id: "c1", name: "Fatura mensal" }),
      seed({ id: "c2", name: "Outro assunto" }),
    ];
    mount(
      <BotHistoryList botId="bot-1" onAbrir={noop} onNovaConversa={noop} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Fatura mensal/ }),
      ).toBeDefined();
    });
    fireEvent.change(screen.getByLabelText("Buscar no histórico"), {
      target: { value: "fatura" },
    });

    await waitFor(() => {
      expect(pedidos.some((p) => p.url.includes("q=fatura"))).toBe(true);
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /Outro assunto/ }),
      ).toBeNull();
    });
  });

  test("carregar mais pagina sem pular", async () => {
    conversas = Array.from({ length: 21 }, (_, i) =>
      seed({ id: `c${String(i + 1).padStart(2, "0")}` }),
    );
    mount(
      <BotHistoryList botId="bot-1" onAbrir={noop} onNovaConversa={noop} />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Conversa c21/ }),
      ).toBeDefined();
    });
    expect(screen.queryByRole("button", { name: /Conversa c01/ })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Carregar mais" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Conversa c01/ }),
      ).toBeDefined();
    });
  });

  test("abrir item entrega o canal", async () => {
    conversas = [seed({ id: "c1", name: "Extrato do mês" })];
    let aberto: ChannelSummary | null = null;
    mount(
      <BotHistoryList
        botId="bot-1"
        onAbrir={(c) => {
          aberto = c;
        }}
        onNovaConversa={noop}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /Extrato do mês/ }),
      ).toBeDefined();
    });
    fireEvent.click(screen.getByRole("button", { name: /Extrato do mês/ }));

    expect(aberto?.id).toBe("c1");
  });

  test("nova conversa cria canal oculto sem mexer no roster", async () => {
    conversas = [];
    let nova: { id: string } | null = null;
    const { client } = mount(
      <BotHistoryList
        botId="bot-1"
        onAbrir={noop}
        onNovaConversa={(c) => {
          nova = c;
        }}
      />,
    );
    const invalidadas: unknown[][] = [];
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = (async (filters?: { queryKey?: unknown }) => {
      invalidadas.push((filters?.queryKey ?? []) as unknown[]);
      return original(filters as Parameters<typeof original>[0]);
    }) as typeof client.invalidateQueries;

    try {
      await waitFor(() => {
        expect(
          screen.getByRole("button", { name: "Nova conversa" }),
        ).toBeDefined();
      });
      fireEvent.click(screen.getByRole("button", { name: "Nova conversa" }));

      await waitFor(() => {
        expect(nova?.id).toBe("channel-nova-1");
      });
      const post = pedidos.find(
        (p) => p.url.endsWith("/api/channels") && p.method === "POST",
      );
      expect(post?.body).toEqual({
        agentIds: ["bot-1"],
        visivelNoRoster: false,
      });

      /*
       * O histórico do bot recarrega; o roster não. O canal nasce invisível para
       * `GET /api/channels`, então pedir essa lista de novo seria pedir ao servidor algo que não
       * pode ter mudado — a mesma agitação que o caminho do socket evita.
       */
      await waitFor(() => {
        expect(invalidadas.some((chave) => chave[0] === "bots")).toBe(true);
      });
      expect(invalidadas.some((chave) => chave[0] === "channels")).toBe(false);
    } finally {
      client.invalidateQueries = original;
    }
  });
});

describe("detalhe somente leitura", () => {
  test("mostra mensagens sem composer e Continuar volta ao jogo", async () => {
    conversas = [seed({ id: "c1", threadId: "thread-c1" })];
    const canal = resumo(conversas[0] as Seed);
    let continuado: ChannelSummary | null = null;
    let voltou = false;
    mount(
      <BotHistoryDetail
        botId="bot-1"
        channel={canal}
        onVoltar={() => {
          voltou = true;
        }}
        onContinuar={(c) => {
          continuado = c;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("Quanto foi o almoço?")).toBeDefined();
    });
    expect(screen.getByText("Foi quarenta e dois.")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(continuado?.id).toBe("c1");

    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(voltou).toBe(true);
  });
});

describe("bot desconhecido", () => {
  test("mostra estado dito em vez de chat vazio", async () => {
    mount(<BotPage agentId="fantasma" />);

    await waitFor(() => {
      expect(
        screen.getByText("Não foi possível carregar este colega."),
      ).toBeDefined();
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});

describe("página do bot", () => {
  test("Continuar traz a conversa escolhida para a aba Conversa", async () => {
    conversas = [seed({ id: "c1", name: "Fatura mensal" })];
    mount(<BotPage agentId="bot-1" />);

    fireEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Fatura mensal/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Continuar" }));

    // De volta na aba Conversa por conta própria: continuar e depois ter de
    // achar a aba na mão seria a mesma coisa que não continuar.
    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Conversa" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    // A conversa escolhida, com o que já foi dito nela e um composer para dizer mais.
    expect(await screen.findByText("Quanto foi o almoço?")).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /Buscar/ })).toBeNull();
    });
  });

  test("Nova conversa abre vazia, sem herdar a anterior", async () => {
    conversas = [seed({ id: "c1", name: "Fatura mensal" })];
    mount(<BotPage agentId="bot-1" />);

    fireEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Nova conversa" }),
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Conversa" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });
    // Zerada: a conversa anterior continua no histórico, não no painel aberto.
    await waitFor(() => {
      expect(screen.queryByText("Quanto foi o almoço?")).toBeNull();
    });
    expect(
      pedidos.some(
        (p) => p.url.endsWith("/api/channels") && p.method === "POST",
      ),
    ).toBe(true);
  });

  test("Nova conversa nunca recebe o thread da anterior", async () => {
    // O hydrate é o que está em julgamento: cada conversa ativa só pode receber a própria thread.
    mensagensPorThread.set("thread-c1", [
      { id: "a1", role: "user", content: "O código do cofre é 4242." },
    ] as Message[]);
    conversas = [seed({ id: "c1", name: "Conversa do cofre" })];
    mount(<BotPage agentId="bot-1" />);

    fireEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Nova conversa" }),
    );

    await waitFor(() => {
      expect(
        screen
          .getByRole("tab", { name: "Conversa" })
          .getAttribute("aria-selected"),
      ).toBe("true");
    });

    const nova = pedidos.find(
      (p) => p.url.endsWith("/api/channels") && p.method === "POST",
    );
    expect(nova).toBeDefined();
    const pedido = nova?.body as { threadId?: string } | undefined;
    // O canal novo foi criado com outro thread — o fato do cofre não tem como chegar nele.
    expect(pedido?.threadId ?? "thread-nova-1").not.toBe("thread-c1");
    await waitFor(() => {
      expect(screen.queryByText("O código do cofre é 4242.")).toBeNull();
    });
    expect(
      agentStores.get("thread-nova-1")?.messages.map((m) => m.id),
    ).not.toContain("a1");
  });

  test("trocar de conversa não junta os históricos", async () => {
    // Um fato plantado em cada conversa: a mistura tem de ter o que mostrar.
    conversas = [
      seed({ id: "c1", name: "Conversa do cofre" }),
      seed({ id: "c2", name: "Conversa do almoço" }),
    ];
    mensagensPorThread.set("thread-c1", [
      { id: "a1", role: "user", content: "O código do cofre é 4242." },
    ] as Message[]);
    mensagensPorThread.set("thread-c2", [
      { id: "b1", role: "user", content: "O almoço foi feijoada." },
    ] as Message[]);
    mount(<BotPage agentId="bot-1" />);

    async function continuar(nome: RegExp) {
      fireEvent.click(await screen.findByRole("tab", { name: "Histórico" }));
      fireEvent.click(await screen.findByRole("button", { name: nome }));
      fireEvent.click(await screen.findByRole("button", { name: "Continuar" }));
    }

    await continuar(/Conversa do cofre/);
    // Esperar o fato aparecer é o que prova que a hidratação terminou; sem isso a
    // ausência do outro fato seria só a tela ainda vazia.
    expect(await screen.findByText("O código do cofre é 4242.")).toBeDefined();
    expect(screen.queryByText("O almoço foi feijoada.")).toBeNull();

    await continuar(/Conversa do almoço/);
    expect(await screen.findByText("O almoço foi feijoada.")).toBeDefined();
    expect(screen.queryByText("O código do cofre é 4242.")).toBeNull();

    /*
     * O que se afirma é o escopo da hidratação, não a resposta do modelo: cada conversa só recebeu
     * a própria thread, então o fato de uma nunca entra no que seria enviado pela outra.
     */
    expect(agentStores.get("thread-c1")?.messages.map((m) => m.id)).toEqual([
      "a1",
    ]);
    expect(agentStores.get("thread-c2")?.messages.map((m) => m.id)).toEqual([
      "b1",
    ]);
  });
});
