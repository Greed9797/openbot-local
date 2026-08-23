import { describe, expect, test } from "bun:test";
import {
  avisoDeNaoLeitura,
  avisoDeOutraPagina,
  codexArguments,
  hostsEm,
  INSTRUÇÕES_DO_WORKSPACE,
  perguntaDoTurno,
  recapDe,
  turnPrompt,
} from "../src/index";

/**
 * `exec` and `exec resume` do not take the same flags.
 *
 * `resume` accepts neither `--sandbox` nor `-C`, because the session it resumes already carries
 * both. Passing them is not ignored: Codex exits 2 with a usage error, which showed up as every
 * second turn in a conversation failing while the first one worked. That asymmetry is invisible in
 * the code unless something asserts it.
 */
describe("codex arguments", () => {
  test("a first turn sets the sandbox and the working root", () => {
    const args = codexArguments(null);

    expect(args[0]).toBe("exec");
    expect(args).toContain("--sandbox");
    expect(args).toContain("-C");
    expect(args.at(-1)).toBe("-");
  });

  test("a resumed turn passes neither, and names the session last", () => {
    const args = codexArguments("session-123");

    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-C");
    // The session id is positional and must come after the options, immediately before the prompt.
    expect(args.slice(-2)).toEqual(["session-123", "-"]);
  });

  test("the sandbox is never handed the whole machine", () => {
    expect(codexArguments(null)).not.toContain("danger-full-access");
  });

  /**
   * `--approve-for-me` recusa conviver com `--sandbox`: já implica workspace-write, e passar os dois
   * é erro de uso com exit 2, não um flag ignorado. Sem aprovação nenhuma, por outro lado, toda
   * chamada de ferramenta MCP volta como "requires approval" e o turno termina explicando que não
   * deu — que na tela é indistinguível da ferramenta não existir. Os dois lados dessa borda estão
   * travados aqui porque nenhum deles falha de um jeito legível.
   */
  test("aprovando, não passa --sandbox junto", () => {
    const args = codexArguments(null, { OPENBOT_RUN: "r" });

    expect(args).toContain("--approve-for-me");
    expect(args).not.toContain("--sandbox");
  });

  test("sem credenciais, mantém o sandbox e não aprova nada", () => {
    const args = codexArguments(null);

    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--approve-for-me");
  });

  /**
   * O outro lado da mesma borda, e o que quebrou em produção: `--approve-for-me` só existe no
   * `exec`. Passar num `resume` é exit 2 com usage error, e o sintoma é o primeiro turno funcionar
   * e o segundo morrer. Não há como aprovar e retomar ao mesmo tempo, então quem tem ferramenta
   * abre sessão nova — o histórico volta pelo prompt.
   */
  test("aprovando, nunca retoma — mesmo com sessão guardada", () => {
    const args = codexArguments("sessao-1", { OPENBOT_RUN: "r" });

    expect(args).not.toContain("resume");
    expect(args).not.toContain("sessao-1");
    expect(args).toContain("--approve-for-me");
  });

  test("as credenciais viram env do servidor MCP, com as aspas do TOML", () => {
    expect(codexArguments(null, { OPENBOT_RUN: "abc" })).toContain(
      'mcp_servers.openbot.env.OPENBOT_RUN="abc"',
    );
  });
});

describe("turn prompt", () => {
  const messages = [
    { id: "s1", role: "system", content: "You are on call." },
    { id: "u1", role: "user", content: "first question" },
    { id: "a1", role: "assistant", content: "first answer" },
    { id: "u2", role: "user", content: "second question" },
  ];
  const input = { threadId: "t", runId: "r", messages } as never;

  test("a first turn carries the standing role and the question", () => {
    const prompt = turnPrompt(input, false);

    expect(prompt).toContain("You are on call.");
    expect(prompt).toContain("second question");
  });

  test("a resumed turn carries only the newest question", () => {
    const prompt = turnPrompt(input, true);

    // Codex is holding the rest itself. Replaying it would bill the subscription for a transcript
    // the model already remembers writing.
    expect(prompt).toBe("second question");
  });

  /**
   * Sem retomada não existe sessão guardando o que já foi dito, então o prompt é a única memória.
   * Um turno que manda só a última pergunta responde "olá, em que posso ajudar?" a alguém que está
   * no meio de uma conversa.
   */
  test("um turno novo releva o que já foi dito antes da pergunta", () => {
    const prompt = turnPrompt(input, false);

    expect(prompt).toContain("first question");
    expect(prompt).toContain("first answer");
    expect(prompt.indexOf("first answer")).toBeLessThan(
      prompt.indexOf("second question"),
    );
  });
});

describe("a regra de ler antes de afirmar", () => {
  const messages = [
    { id: "u1", role: "user", content: "Abra example.com e diga o título." },
  ];
  const input = { threadId: "t", runId: "r", messages } as never;

  /**
   * Medido antes de escrever isto: o mesmo pedido, três vezes, chamou a ferramenta uma vez. Nas
   * outras duas o modelo respondeu de cabeça e escreveu "Fonte:" com um link, do mesmo jeito que
   * escreve quando leu de verdade — e quem lê não tem como saber qual das duas recebeu.
   */
  test("com ferramentas, o turno proíbe responder de memória sobre uma página", () => {
    const prompt = turnPrompt(input, false, true);

    expect(prompt).toContain("Não responda de memória");
    expect(prompt).toContain("Fonte:");
  });

  /** Sem ferramentas a regra mandaria o Bot recusar tudo o que sabe, então ela não vai. */
  test("sem ferramentas, a regra fica de fora", () => {
    expect(turnPrompt(input, false, false)).not.toContain(
      "Não responda de memória",
    );
  });

  test("num turno retomado o prompt continua sendo só a pergunta", () => {
    expect(turnPrompt(input, true, true)).toBe(
      "Abra example.com e diga o título.",
    );
  });
});

describe("dizer quando a resposta não foi lida", () => {
  /**
   * A medição que motivou isto: pedir três vezes o valor de https://httpbin.org/uuid — que muda a
   * cada leitura — devolveu o MESMO valor nas três, sem uma única chamada de ferramenta registrada.
   * O Bot não abriu nada e inventou, e a resposta saiu com a mesma cara de uma que foi lida.
   */
  test("pergunta com endereço e nenhuma ferramenta usada ganha o aviso", () => {
    const aviso = avisoDeNaoLeitura("Abra https://httpbin.org/uuid", false);

    expect(aviso).toContain("Nenhuma página foi aberta");
  });

  test("se a ferramenta foi usada, não há o que avisar", () => {
    expect(avisoDeNaoLeitura("Abra https://httpbin.org/uuid", true)).toBe("");
  });

  /**
   * Sem endereço não há promessa de leitura a checar. "Quanto é 2+2" respondido de cabeça é a
   * resposta certa, e um aviso ali seria ruído em toda conversa que não fala de páginas.
   */
  test("pergunta sem endereço nenhum não ganha aviso", () => {
    expect(avisoDeNaoLeitura("Resuma o que conversamos ontem", false)).toBe("");
  });

  test("um domínio escrito sem http também conta como endereço", () => {
    expect(avisoDeNaoLeitura("o que tem em exemplo.com.br?", false)).toContain(
      "Nenhuma página",
    );
  });

  test("a última pergunta da conversa é a que vale", () => {
    const input = {
      messages: [
        { id: "u1", role: "user", content: "primeira" },
        { id: "a1", role: "assistant", content: "resposta" },
        { id: "u2", role: "user", content: "abra https://exemplo.dev" },
      ],
    } as never;

    expect(perguntaDoTurno(input)).toBe("abra https://exemplo.dev");
  });
});

describe("a rede do shell fica ligada, e o teste diz por quê", () => {
  /**
   * Fechar a rede do shell seria a defesa certa, e foi tentado. Com `network_access=false`, TODA
   * chamada de ferramenta MCP volta a pedir aprovação — `--approve-for-me` deixa de cobri-las, o
   * turno termina com "APPROVAL REQUEST" no rollout e o Bot responde de memória. Medido em bateria:
   * das 44 tarefas, as 40 que dependiam de abrir uma página falharam, e a mudança foi essa única
   * linha.
   *
   * Este teste existe para que a próxima pessoa que tiver a mesma boa ideia leia isto antes de
   * gastar a tarde. Se um dia o CLI parar de tratar rede desligada como motivo para pedir aprovação,
   * o caminho está aberto — e é este teste que precisa mudar junto.
   */
  test("a rede do shell continua ligada, senão as ferramentas param", () => {
    const args = codexArguments(null, { OPENBOT_RUN: "r" });

    expect(args).toContain("sandbox_workspace_write.network_access=true");
  });
});

describe("as instruções que o Bot lê como do projeto", () => {
  /**
   * Elas são o que fez o Bot passar a usar o navegador: medido, de zero chamadas em três pedidos
   * para três em três. São também a coisa mais fácil de apagar sem ninguém notar, porque a falha é
   * silenciosa — o Bot volta a responder bem, só que de memória.
   */
  test("mandam usar as ferramentas em vez de responder de cabeça", () => {
    expect(INSTRUÇÕES_DO_WORKSPACE).toContain("use as ferramentas");
    expect(INSTRUÇÕES_DO_WORKSPACE).toContain("Não responda sobre o conteúdo");
  });

  test("proíbem buscar página pelo shell, que é o caminho sem audit", () => {
    expect(INSTRUÇÕES_DO_WORKSPACE).toMatch(/nunca use o shell/i);
  });

  /** Sem isto o Bot chuta o domínio a partir do nome da marca — foi como caiu numa página de venda. */
  test("mandam perguntar o endereço em vez de adivinhar", () => {
    expect(INSTRUÇÕES_DO_WORKSPACE).toContain("Nome de marca não é endereço");
  });

  test("nomeiam as ferramentas que existem de verdade", () => {
    for (const ferramenta of [
      "abrir_pagina",
      "ler_url_rapido",
      "mapear_pagina",
    ]) {
      expect(INSTRUÇÕES_DO_WORKSPACE).toContain(ferramenta);
    }
  });
});

describe("abriu, mas não a página pedida", () => {
  /**
   * O aviso de "nenhuma página foi aberta" não alcança este caso: uma página FOI aberta, o contador
   * de ações sobe, e a resposta sai com a confiança de quem leu. Foi assim que, perguntado pelo site
   * da W3bsite, o Bot abriu um domínio parecido, caiu numa página de venda e respondeu o título dela.
   */
  test("avisa quando nada do que foi aberto bate com o que foi pedido", () => {
    const aviso = avisoDeOutraPagina("Abra https://w3bsite.com.br", [
      "w3bsite.com",
    ]);

    expect(aviso).toContain("w3bsite.com.br");
    expect(aviso).toContain("w3bsite.com");
  });

  /** Abrir a página certa e mais duas não é erro nenhum. */
  test("cala quando ao menos um dos endereços pedidos foi aberto", () => {
    expect(
      avisoDeOutraPagina("Abra https://example.com", [
        "example.com",
        "iana.org",
      ]),
    ).toBe("");
  });

  test("pedido sem endereço não tem o que comparar", () => {
    expect(avisoDeOutraPagina("me resume a conversa", ["example.com"])).toBe(
      "",
    );
  });

  test("turno que não abriu nada é assunto do outro aviso", () => {
    expect(avisoDeOutraPagina("Abra https://example.com", [])).toBe("");
  });

  test("www e maiúsculas não fazem dois hosts virarem diferentes", () => {
    expect(hostsEm("Veja https://WWW.Example.com/x")).toEqual(["example.com"]);
    expect(avisoDeOutraPagina("abra www.example.com", ["example.com"])).toBe(
      "",
    );
  });
});

/**
 * A memória da conversa, que é o prompt e mais nada.
 *
 * Cada teste aqui corresponde a uma falha medida contra o Bot rodando, em
 * `tools/bateria/conversas.json`. As três caíram na mesma fronteira — o sétimo turno, quando a
 * janela de seis trocas descartava a abertura — e as três eram invisíveis para a bateria de turno
 * único, que nunca faz a segunda pergunta.
 */
describe("a conversa recontada para um modelo que não a guardou", () => {
  /** Uma troca curta de perguntas baratas, que é o formato da conversa real. */
  function conversaDe(trocas: number, abertura: string) {
    const messages: { id: string; role: string; content: string }[] = [
      { id: "u1", role: "user", content: abertura },
      { id: "a1", role: "assistant", content: "Anotado." },
    ];
    for (let numero = 2; numero <= trocas; numero += 1) {
      messages.push({
        id: `u${numero}`,
        role: "user",
        content: `Quanto é ${numero} vezes oito?`,
      });
      messages.push({
        id: `a${numero}`,
        role: "assistant",
        content: `São ${numero * 8}, sem mistério nenhum.`,
      });
    }
    messages.push({ id: "uf", role: "user", content: "E o que eu pedi lá no começo?" });
    return messages;
  }

  /**
   * Medido: o número dado no turno 1 sumiu no turno 9, e o Bot não disse "não lembro" — disse
   * "você não me deu nenhum número de protocolo nesta conversa".
   */
  test("o que a pessoa disse na abertura atravessa uma conversa longa", () => {
    const recap = recapDe(conversaDe(12, "Guarda o protocolo 84120 para depois."));

    expect(recap).toContain("84120");
  });

  /** Medido: a regra "comece cada resposta com ABACAXI" parou de valer no sétimo turno. */
  test("uma regra dada uma vez continua valendo no décimo turno", () => {
    const recap = recapDe(conversaDe(10, "Regra desta conversa: comece tudo com ABACAXI."));

    expect(recap).toContain("ABACAXI");
  });

  /**
   * Medido: o uuid que o Bot leu numa página no turno 1 não existia mais no turno 9. O valor está
   * numa fala DELE, não numa da pessoa — por isso não basta preservar o que a pessoa escreveu.
   */
  test("o que o Bot leu e disse também atravessa", () => {
    const messages = conversaDe(10, "Abra a página e me diga o uuid.");
    messages[1] = {
      id: "a1",
      role: "assistant",
      content: "O uuid é b1ab63f9-70bf-43d2-95da-f3a9dd7e0ad2.",
    };

    expect(recapDe(messages)).toContain("b1ab63f9-70bf-43d2-95da-f3a9dd7e0ad2");
  });

  test("uma conversa que cabe inteira vai inteira, sem marcador de corte", () => {
    const recap = recapDe(conversaDe(8, "Guarda o protocolo 84120."));

    expect(recap).toContain("Quanto é 2 vezes oito?");
    expect(recap).not.toContain("omitidos por tamanho");
  });

  describe("quando não cabe", () => {
    /** Uma fala do meio grande o bastante para estourar o orçamento sozinha. */
    const gigante = "x".repeat(13_000);
    const messages = [
      { id: "u1", role: "user", content: "Guarda o protocolo 84120." },
      { id: "a1", role: "assistant", content: "Anotado." },
      { id: "u2", role: "user", content: "Cola isto aqui e resume." },
      { id: "a2", role: "assistant", content: gigante },
      { id: "u3", role: "user", content: "E o protocolo?" },
    ];

    test("a abertura fica mesmo assim", () => {
      expect(recapDe(messages)).toContain("84120");
    });

    /**
     * Sem isto o modelo trata a conversa recortada como a conversa completa e nega o que não vê,
     * que foi a resposta que a medição pegou. Dizer que faltou pedaço custa uma linha.
     */
    test("o corte é declarado, para ele não negar o que não está vendo", () => {
      expect(recapDe(messages)).toContain("omitidos por tamanho");
    });

    test("o pedaço gigante não vai junto", () => {
      expect(recapDe(messages)).not.toContain(gigante);
    });
  });

  test("um primeiro turno não tem conversa nenhuma para recontar", () => {
    expect(recapDe([{ id: "u1", role: "user", content: "Olá, tudo bem?" }])).toBe("");
  });
});
