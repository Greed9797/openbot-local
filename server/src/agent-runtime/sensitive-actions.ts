/**
 * O que exige uma pessoa antes de acontecer.
 *
 * A pergunta não é "isto é perigoso?", é "isto tem efeito lá fora que ninguém pediu explicitamente".
 * Um clique que abre um menu não tem; um clique que publica um produto tem, e a diferença entre os
 * dois está na consequência, não na ferramenta. Por isso a decisão é tomada sobre o que a ação diz de
 * si — o verbo que o modelo escolheu, o texto do controle em que ele mandou clicar, e o endereço em
 * que isso vai acontecer — e nunca sobre o que o modelo afirma que a ação faz.
 *
 * Classificador, não porteiro: quem recusa de verdade é o gateway e quem espera é o loop. Aqui só se
 * responde "esta ação precisa de um sim?" e por quê, uma resposta que é registrada junto do passo e
 * que uma pessoa lê no painel quando vai decidir.
 */

/** Uma ação proposta pelo modelo, reduzida ao que a decisão precisa saber. */
export type ProposedAction = {
  name: string;
  arguments: Record<string, unknown>;
};

/** O contexto em que a ação vai acontecer. */
export type ActionContext = {
  /** O endereço da página da observação atual, quando houver. */
  url?: string | null;
  /** O texto do controle, quando a ação é sobre um elemento e a observação o conhece. */
  targetName?: string | null;
  /** O papel ARIA do controle, quando conhecido. */
  targetRole?: string | null;
};

export type SensitivityVerdict =
  | { sensitive: false }
  | {
      sensitive: true;
      reason: string;
      /** A regra que decidiu, para o registro e para o painel. */
      rule: string;
      /** Onde isso acontece, para quem for decidir. */
      destination: string | null;
      /** O que se espera que aconteça, em uma frase. */
      expectedEffect: string;
    };

/**
 * Os verbos que, num controle, significam efeito externo.
 *
 * Não são palavras de perigo, são verbos de publicação e de compromisso: o que sai da máquina e vai
 * para outra pessoa, o que gasta dinheiro, o que apaga o que não volta, o que muda uma configuração
 * que vale para todos. Rótulo de botão é texto humano, e é por isso que a lista é de palavras
 * inteiras com fronteira, e não de prefixos: "enviar rascunho" e "publicar" são o mesmo gesto, mas
 * "cancelar" não é "cadastrar".
 */
const ACTING_WORDS = [
  // Publicar e enviar
  "publicar",
  "publish",
  "enviar",
  "reenviar",
  "resend",
  "send",
  "submit",
  "postar",
  "post",
  "submeter",
  "confirmar",
  "confirm",
  "finalizar",
  "concluir",
  "completar",
  "salvar",
  "save",
  "criar",
  "create",
  "cadastrar",
  "registrar",
  "register",
  "sign up",
  "assinar",
  "subscribe",
  // Dinheiro
  "comprar",
  "buy",
  "pagar",
  "pay",
  "checkout",
  "finalizar compra",
  "place order",
  "assinar plano",
  // Destrutivo
  "excluir",
  "delete",
  "remover",
  "remove",
  "apagar",
  "deletar",
  "destruir",
  "cancelar conta",
  "close account",
  // Alcance e configuração
  "convidar",
  "invite",
  "compartilhar",
  "share",
  "transferir",
  "transfer",
  "aprovar",
  "approve",
  "habilitar",
  "enable",
  "desabilitar",
  "disable",
  "configurar",
  "configure",
  "alterar permissões",
  "permissions",
  "adicionar membro",
  "add member",
  "fazer upgrade",
  "upgrade",
  "downgrade",
];

/**
 * Caminhos que, por si só, dizem que a página é a etapa final de alguma coisa.
 *
 * Um `navigate` para `/checkout` não é a mesma coisa que um `navigate` para `/produtos`, e o modelo
 * não deveria conseguir chegar ao botão de pagar contornando a pergunta pela barra de endereço.
 */
const ACTING_PATHS = [
  "/checkout",
  "/purchase",
  "/payment",
  "/pagamento",
  "/comprar",
  "/pedido/confirmar",
  "/order/confirm",
  "/publish",
  "/publicar",
  "/settings/permissions",
  "/admin",
];

/**
 * Ferramentas cuja consequência é sempre externa, seja qual for o argumento.
 *
 * `request_help` não está aqui: pedir ajuda não é um efeito, é a ausência dele.
 */
const ALWAYS_SENSITIVE = new Set<string>(["submit_form", "publish"]);

/** Argumentos que, quando presentes, fazem a ação sair da máquina. */
const ACTING_KEYWORDS = ["submit", "publish", "delete", "confirm", "purchase"];

function normalized(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function matchesWord(haystack: string, needle: string): boolean {
  const index = haystack.indexOf(needle);
  if (index === -1) return false;
  const before = index === 0 ? undefined : haystack[index - 1];
  const after = haystack[index + needle.length];
  return (
    (before === undefined || /[\s:.,!?()\-–—/]/.test(before)) &&
    (after === undefined || /[\s:.,!?()\-–—/]/.test(after))
  );
}

/** O texto que descreve o que a ação faz, junto: o verbo, o alvo e o endereço. */
function haystackOf(action: ProposedAction, context: ActionContext): string {
  const parts: string[] = [action.name.replace(/_/g, " ")];
  const values = Object.entries(action.arguments ?? {})
    .filter(([key]) => key !== "snapshotId" && key !== "ref")
    .map(([key, value]) =>
      typeof value === "string"
        ? `${key} ${value}`
        : typeof value === "boolean" && value
          ? key
          : "",
    )
    .filter(Boolean);
  parts.push(...values);
  if (context.targetName) parts.push(context.targetName);
  if (context.url) parts.push(context.url);
  return normalized(parts.join(" "));
}

/** A primeira palavra que decidiu, com a regra que a encontrou. */
function findWord(
  haystack: string,
): { word: string; rule: string } | undefined {
  for (const word of ACTING_WORDS) {
    if (matchesWord(haystack, word)) {
      return { word, rule: "acting-word" };
    }
  }
  return undefined;
}

/**
 * A decisão.
 *
 * A ordem importa: o que é sempre sensível vem primeiro, depois o argumento que manda executar (um
 * `click` com `submit: true`, por exemplo), depois o verbo no rótulo, depois o endereço. Devolver a
 * primeira razão encontrada é deliberado: quem lê a tela precisa de uma frase, não de uma lista.
 */
export function classifyAction(
  action: ProposedAction,
  context: ActionContext = {},
): SensitivityVerdict {
  if (ALWAYS_SENSITIVE.has(action.name)) {
    return {
      sensitive: true,
      reason: `A ação "${action.name}" sempre exige uma pessoa.`,
      rule: "always-sensitive",
      destination: context.url ?? null,
      expectedEffect: `Executar ${action.name}.`,
    };
  }

  const argumentKeys = Object.keys(action.arguments ?? {}).map((key) =>
    key.toLowerCase(),
  );
  const actingArgument = ACTING_KEYWORDS.find((keyword) =>
    argumentKeys.some((key) =>
      key === keyword || key.endsWith(`_${keyword}`) || key.startsWith(`${keyword}_`),
    ),
  );
  const argumentTrue =
    actingArgument !== undefined &&
    action.arguments?.[actingArgument] !== false &&
    action.arguments?.[actingArgument] !== "false";
  if (argumentTrue) {
    return {
      sensitive: true,
      reason: `O argumento "${actingArgument}" manda concluir a ação.`,
      rule: "acting-argument",
      destination: context.url ?? null,
      expectedEffect: `Concluir "${action.name}" na página atual.`,
    };
  }

  const haystack = haystackOf(action, context);
  const word = findWord(haystack);
  if (word) {
    const target = context.targetName
      ? `"${context.targetName}"`
      : `"${action.name}"`;
    return {
      sensitive: true,
      reason: `O rótulo de ${target} contém "${word.word}", que é um efeito externo.`,
      rule: word.rule,
      destination: context.url ?? null,
      expectedEffect: `Acionar ${target} na página atual.`,
    };
  }

  if (action.name === "navigate" && context.url) {
    const path = normalized(context.url);
    const hit = ACTING_PATHS.find((candidate) => path.includes(candidate));
    if (hit) {
      return {
        sensitive: true,
        reason: `O endereço é uma etapa final (${hit}).`,
        rule: "acting-path",
        destination: context.url,
        expectedEffect: `Abrir ${context.url} e seguir adiante.`,
      };
    }
  }

  return { sensitive: false };
}
