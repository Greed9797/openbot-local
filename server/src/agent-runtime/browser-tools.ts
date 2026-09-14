/**
 * O catálogo de ferramentas que o modelo pode chamar, e nada além.
 *
 * Toda ação daqui passa pelo gateway, que resolve a referência contra o snapshot, consulta a
 * política, grava a auditoria antes de agir e só então toca o navegador. O modelo nunca recebe
 * Playwright, nunca escolhe seletor e nunca executa JavaScript: ele escolhe um `ref` que o servidor
 * traduz. É o mesmo caminho de uma pessoa no painel, e é por isso que a política e a trilha valem
 * para os dois.
 *
 * O que o modelo vê é o resultado, não o mecanismo: um clique devolve o rótulo do elemento e onde a
 * página foi parar, nunca o texto que foi digitado.
 */
import {
  type ActionActor,
  ActionRefusedError,
  type ComputerGateway,
  ComputerUnavailableError,
  ElementNotFoundError,
  HumanHasControlError,
  NavigationRefusedError,
  SecretPendingError,
  StaleSnapshotError,
  ViewportError,
} from "../computer/gateway";
import type { SnapshotElement, SnapshotResult } from "../computer/schema";
import type {
  ToolCall,
  ToolCallContext,
  ToolCatalog,
  ToolDefinition,
  ToolOutcome,
} from "./contracts";
import { extractForm, planFill } from "./form-extract";

/** Quanto uma espera pode durar. Acima disto, a tarefa está presa e quem decide é a pessoa. */
const MAX_WAIT_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const WAIT_POLL_MS = 500;

/** Uma definição mais a pergunta que só este arquivo faz: repetir esta ação pode duplicar o efeito? */
type CatalogEntry = ToolDefinition & { acting: boolean };

export type BrowserToolOptions = {
  gateway: ComputerGateway;
  /** Cap on how many elements a snapshot result carries into the model's context. */
  maxElements?: number;
};

export function createBrowserTools(options: BrowserToolOptions): ToolCatalog {
  const { gateway } = options;
  const maxElements = options.maxElements ?? 80;

  const definitions: CatalogEntry[] = [
    {
      name: "navigate",
      description:
        "Abre um endereço no navegador que a pessoa vê. É uma ação sujeita à política do deployment: um endereço proibido volta como recusa, e a recusa é definitiva — não tente de novo.",
      parameters: object({ url: string("O endereço completo, com https://") }, [
        "url",
      ]),
      acting: true,
    },
    {
      name: "fetch_page",
      description:
        "Lê uma página pública só pelo texto, sem abrir nada no navegador que a pessoa vê e sem sessão do Bot. É governada como qualquer outra: um endereço proibido volta como recusa definitiva, e a recusa nunca tem fallback para o Chromium. Só uma falha técnica informa o Chromium como alternativa explícita, sujeito às mesmas permissões. Para sessão autenticada ou pixels, continue no Chromium.",
      parameters: object({ url: string("O endereço completo, com https://") }, [
        "url",
      ]),
      acting: false,
    },
    {
      name: "read_page",
      description:
        "Lê o texto da página aberta agora. Barato, não muda nada e não abre nada. Use para saber o que está escrito antes de decidir o próximo passo.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "snapshot_page",
      description:
        "Mapeia o que dá para acionar na página: campos, botões, links, caixas de seleção. Devolve um ref para cada elemento e o snapshotId a que pertencem. Chame quando suspeitar que a página mudou; a ref e o snapshotId de uma ação precisam vir da mesma observação.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "click",
      description:
        "Clica em um elemento. O ref e o snapshotId vêm da observação atual; uma ref de uma página que mudou é recusada, e a resposta certa é mapear de novo, não repetir o clique.",
      parameters: object(
        {
          ref: string("A ref do elemento, vinda da observação atual"),
          snapshotId: integer(
            "O snapshotId da mesma observação de onde veio a ref",
          ),
        },
        ["ref", "snapshotId"],
      ),
      acting: true,
    },
    {
      name: "type_text",
      description:
        "Escreve em um campo, substituindo o que houver nele. `submit: true` aperta Enter depois, que é como se envia um formulário de um campo só. O texto digitado não volta na resposta e não é registrado: repita-o só se precisar.",
      parameters: object(
        {
          ref: string("A ref do campo, vinda da observação atual"),
          snapshotId: integer(
            "O snapshotId da mesma observação de onde veio a ref",
          ),
          text: string("O texto a escrever no campo"),
          submit: boolean("Apertar Enter depois de escrever"),
        },
        ["ref", "snapshotId", "text"],
      ),
      acting: true,
    },
    {
      name: "press_key",
      description:
        "Aperta uma tecla, como Enter, Tab ou Escape. Com ref, a tecla vai para aquele campo; sem ref, vai para a página.",
      parameters: object(
        {
          key: string("O nome da tecla: Enter, Tab, Escape, ArrowDown…"),
          ref: string("Opcional: a ref do campo que deve receber a tecla"),
          snapshotId: integer("O snapshotId da ref, quando houver ref"),
        },
        ["key"],
      ),
      acting: true,
    },
    {
      name: "scroll",
      description:
        "Rola a página para ver o que está mais abaixo. Use quando o formulário for maior que a tela.",
      parameters: object({
        deltaY: integer("Quantos pixels rolar; positivo desce. Padrão 600"),
      }),
      acting: false,
    },
    {
      name: "select_option",
      description:
        "Escolhe uma opção de um campo de seleção (um dropdown). O valor é o `value` da opção, não o texto que aparece na tela; se não souber, mapeie a página e leia o campo antes.",
      parameters: object(
        {
          ref: string("A ref do campo de seleção"),
          snapshotId: integer(
            "O snapshotId da mesma observação de onde veio a ref",
          ),
          value: string("O value da opção a escolher"),
        },
        ["ref", "snapshotId", "value"],
      ),
      acting: true,
    },
    {
      name: "screenshot",
      description:
        "Pede para olhar a tela. A imagem vem na observação seguinte a esta chamada, com o mesmo snapshotId de lá. Use quando o texto não bastar: conteúdo desenhado em canvas, um estado visual, uma dúvida sobre o que a pessoa está vendo.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "telemetry",
      description:
        "Lê o que a página disse enquanto ninguém olhava: mensagens de console, erros da página, requisições que falharam e tempos de carregamento. Sem corpos, sem query strings, texto truncado. Durante entrada de segredo responde SECRET_PENDING em vez de dados: a lacuna é o desenho, não falha.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "audit",
      description:
        "Auditoria de acessibilidade da página: controles sem nome acessível, imagens sem alt e texto com contraste baixo. Contagens mais amostras; sem valores de campos, sem URLs. Use para o ledger de QA em vez de adivinhar pelo snapshot.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "audit_focus",
      description:
        "Caminha o foco com Tab e devolve a ordem encontrada (papel e rótulo por parada, sem valores). Tab nunca submete nada. Uma passada por viewport basta; repita após trocar de viewport.",
      parameters: object(
        {
          steps: integer("Quantos Tabs, 1-60 (padrão 30)"),
        },
        [],
      ),
      acting: false,
    },

    {
      name: "set_viewport",
      description:
        "Troca o tamanho do navegador: um preset (laptop, desktop, tablet, mobile) ou largura/altura explícitas. Para passes responsivos do QA, um viewport por vez, com snapshot depois de cada troca. Presets mobile/tablet reiniciam o navegador para ligar toque; refs anteriores morrem com ele.",
      parameters: object(
        {
          preset: string("Um preset: laptop, desktop, tablet ou mobile"),
          width: integer("Largura em px, 320-2560 (alternativa ao preset)"),
          height: integer("Altura em px, 320-1600 (alternativa ao preset)"),
        },
        [],
      ),
      acting: true,
    },
    {
      name: "wait_for",
      description:
        "Espera um texto aparecer na página, ou o tempo passar. Use depois de uma ação que dispara carregamento. Não substitui olhar: a resposta diz apenas se o texto apareceu.",
      parameters: object(
        {
          text: string("O trecho de texto a esperar"),
          timeoutMs: integer(
            `Quanto esperar no máximo, em ms (padrão ${DEFAULT_WAIT_MS}, máximo ${MAX_WAIT_MS})`,
          ),
        },
        ["text"],
      ),
      acting: false,
    },
    {
      name: "request_help",
      description:
        "Para a tarefa e chama uma pessoa: login, CAPTCHA, 2FA, uma decisão que só o operador pode tomar, ou qualquer coisa que você não possa fazer sozinho. Depois disto a tarefa fica esperando, e retomar é decisão de quem responde.",
      parameters: object(
        {
          reason: string(
            "Em uma frase, o que está impedindo e o que a pessoa precisa fazer",
          ),
        },
        ["reason"],
      ),
      acting: false,
    },
    {
      name: "read_form",
      description:
        "Lê o formulário da página como uma lista de campos: rótulo, tipo, se é obrigatório, se já está preenchido e as opções de cada seleção. Use antes de preencher — cada campo vem com o ref e o snapshotId que as ações precisam.",
      parameters: object({}),
      acting: false,
    },
    {
      name: "plan_form",
      description:
        "Monta o preenchimento a partir dos valores que você tem: casa cada valor com um campo pelo rótulo (aceita sinônimos como nome/name, preço/valor) e devolve a lista de ações a executar, o que ficou sem valor e o que não encontrou campo. Só planeja; quem preenche é você, com `type_text`, `select_option` ou `click`.",
      parameters: object(
        {
          values: array(
            object(
              {
                label: string("O rótulo do campo, como aparece na página"),
                value: string("O valor a preencher"),
              },
              ["label", "value"],
            ),
            "Os valores que você tem, na ordem em que devem ser aplicados",
          ),
        },
        ["values"],
      ),
      acting: false,
    },
    {
      name: "fill_form",
      description:
        "Preenche vários campos do formulário de uma vez, a partir de pares rótulo/valor. Resolve quais campos casam com quais valores, preenche um por vez com as mesmas ações governadas de `type_text` e `select_option` e confere a página antes de cada campo: se a estrutura mudou, para e devolve o que já preencheu e o que ficou pendente. Nunca envia o formulário nem aperta Enter. Os valores preenchidos não voltam na resposta.",
      parameters: object(
        {
          values: array(
            object(
              {
                label: string("O rótulo do campo, como aparece na página"),
                value: string(
                  "O valor a preencher; para seleção, o value da opção",
                ),
              },
              ["label", "value"],
            ),
            "Os valores a preencher, na ordem em que devem ser aplicados",
          ),
        },
        ["values"],
      ),
      acting: true,
    },
  ];

  const acting = new Set(
    definitions
      .filter((definition) => definition.acting === true)
      .map((d) => d.name),
  );
  const known = new Map(
    definitions.map((definition) => [definition.name, definition]),
  );

  return {
    definitions: () =>
      definitions.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),

    async execute(
      call: ToolCall,
      context: ToolCallContext,
    ): Promise<ToolOutcome> {
      const definition = known.get(call.name);
      if (!definition) {
        // Ferramenta desconhecida é resposta do modelo inválida, não falha de execução: quem chama
        // decide se corrige ou desiste.
        return {
          ok: false,
          error: {
            code: "UNKNOWN_TOOL",
            message: `Não existe ferramenta chamada ${call.name}.`,
          },
        };
      }

      const { botId, runId: callRun } = context;
      const actor: ActionActor = {
        id: context.actor.id,
        ...(context.actor.userId ? { userId: context.actor.userId } : {}),
        // Human HTTP calls carry no run: the key stays absent rather than becoming a placeholder.
        ...(callRun ? { runId: callRun } : {}),
      };

      try {
        switch (call.name) {
          case "navigate":
            return ok(
              await gateway.navigate(botId, actor, textOf(call, "url")),
            );
          case "fetch_page": {
            return await fetchPage(call, botId, actor, context.signal);
          }
          case "read_page": {
            const page = await gateway.read(botId);
            return ok({
              url: page.url,
              title: page.title,
              text: page.text,
              truncated: page.truncated,
            });
          }
          case "snapshot_page": {
            const snapshot = await gateway.snapshot(botId);
            return ok(trim(snapshot.elements, maxElements), {
              snapshotId: snapshot.snapshotId,
              url: snapshot.url,
              title: snapshot.title,
              truncated: snapshot.truncated,
              elementCount: snapshot.elements.length,
              viewport: snapshot.viewport,
            });
          }
          case "click":
            return ok(
              await gateway.click(
                botId,
                actor,
                {
                  ref: textOf(call, "ref"),
                  snapshotId: numberOf(call, "snapshotId"),
                },
                context.signal,
              ),
            );
          case "type_text":
            return ok(
              await gateway.type(
                botId,
                actor,
                {
                  ref: textOf(call, "ref"),
                  snapshotId: numberOf(call, "snapshotId"),
                  text: textOf(call, "text"),
                  ...(call.arguments.submit === true ? { submit: true } : {}),
                },
                context.signal,
              ),
            );
          case "press_key":
            return ok(
              await gateway.key(
                botId,
                actor,
                {
                  key: textOf(call, "key"),
                  ...(typeof call.arguments.ref === "string" &&
                  call.arguments.ref
                    ? {
                        ref: call.arguments.ref,
                        snapshotId: numberOf(call, "snapshotId"),
                      }
                    : {}),
                },
                context.signal,
              ),
            );
          case "scroll":
            return ok(
              await gateway.scroll(botId, actor, {
                ...(typeof call.arguments.deltaY === "number"
                  ? { deltaY: call.arguments.deltaY }
                  : {}),
              }),
            );
          case "select_option":
            return ok(
              await gateway.select(
                botId,
                actor,
                {
                  ref: textOf(call, "ref"),
                  snapshotId: numberOf(call, "snapshotId"),
                  value: textOf(call, "value"),
                },
                context.signal,
              ),
            );
          case "screenshot":
            return await requestScreenshot(botId);
          case "telemetry": {
            const telemetry = await gateway.telemetry(botId);
            return ok({
              console: telemetry.console,
              pageErrors: telemetry.pageErrors,
              failedRequests: telemetry.failedRequests,
              timing: telemetry.timing,
            });
          }
          case "set_viewport": {
            const args = call.arguments;
            const input: { preset?: string; width?: number; height?: number } =
              {};
            if (typeof args.preset === "string" && args.preset)
              input.preset = args.preset;
            if (typeof args.width === "number") input.width = args.width;
            if (typeof args.height === "number") input.height = args.height;
            const result = await gateway.setViewport(botId, actor, input);
            // A restart killed the browser the refs belonged to: say so at the outcome level,
            // where the loop already knows what stale means, rather than burying it in the result.
            return {
              ...ok({ viewport: result.viewport, restarted: result.restarted }),
              ...(result.restarted ? { stale: true } : {}),
            };
          }

          case "audit": {
            const report = await gateway.audit(botId);
            return ok({
              unnamedControls: report.unnamedControls,
              imagesMissingAlt: report.imagesMissingAlt,
              contrastFailures: report.contrastFailures,
            });
          }
          case "audit_focus": {
            const steps =
              typeof call.arguments.steps === "number"
                ? call.arguments.steps
                : 30;
            const walk = await gateway.auditFocus(botId, steps);
            return ok({ steps: walk.steps, order: walk.order });
          }
          case "wait_for":
            return await waitFor(call, context);
          case "read_form": {
            const snapshot = await gateway.snapshot(botId);
            const form = extractForm(snapshot);
            return ok(
              {
                url: snapshot.url,
                title: snapshot.title,
                fields: form.fields,
                required: form.required,
                unfilled: form.unfilled,
                buttons: form.buttons,
                elementCount: snapshot.elements.length,
              },
              { snapshotId: snapshot.snapshotId },
            );
          }
          case "plan_form": {
            const values = pairsOf(call);
            const snapshot = await gateway.snapshot(botId);
            const form = extractForm(snapshot);
            const plan = planFill(form, values);
            return ok(
              {
                url: snapshot.url,
                assignments: plan.assignments,
                missing: plan.missing,
                unknown: plan.unknown,
                fieldCount: form.fields.length,
              },
              { snapshotId: snapshot.snapshotId },
            );
          }
          case "fill_form": {
            return await fillForm(call, context, botId, actor);
          }
          case "request_help": {
            const reason = textOf(call, "reason");
            const state = await gateway.requestHelp(botId, actor, reason);
            return { ok: true, result: state, help: { reason } };
          }
          default:
            return {
              ok: false,
              error: {
                code: "UNKNOWN_TOOL",
                message: `Não existe ferramenta chamada ${call.name}.`,
              },
            };
        }
      } catch (error) {
        return failure(error, acting.has(call.name), context.signal);
      }
    },
  };

  /**
   * Pedir para olhar não é capturar agora.
   *
   * A imagem é produzida pela observação seguinte, com o snapshotId de lá, e é lá que ela vira
   * artefato classificado. Capturar aqui também devolveria uma imagem que o passo não tem onde
   * guardar e uma segunda captura logo depois. O que se verifica agora é só se é possível capturar:
   * durante um segredo, não é.
   */
  async function requestScreenshot(botId: string): Promise<ToolOutcome> {
    const control = await gateway.control(botId);
    if (control.secretWanted) {
      return {
        ok: false,
        error: {
          code: "SECRET_PENDING",
          message:
            "A person is entering a value the assistant must not see. No capture is taken while that is happening.",
        },
      };
    }
    return {
      ok: true,
      result: {
        captured: false,
        note: "A imagem vem na observação seguinte a esta chamada.",
      },
    };
  }

  async function waitFor(
    call: ToolCall,
    context: ToolCallContext,
  ): Promise<ToolOutcome> {
    const wanted = textOf(call, "text");
    const requested =
      typeof call.arguments.timeoutMs === "number"
        ? call.arguments.timeoutMs
        : DEFAULT_WAIT_MS;
    const timeoutMs = Math.max(
      WAIT_POLL_MS,
      Math.min(Math.trunc(requested), MAX_WAIT_MS),
    );
    const startedAt = Date.now();
    const botId = context.botId;
    let page = await gateway.read(botId);
    while (!page.text.includes(wanted)) {
      if (context.signal.aborted) {
        return {
          ok: false,
          error: { code: "STOPPED", message: "A tarefa foi interrompida." },
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        return ok({
          found: false,
          waitedMs: Date.now() - startedAt,
          url: page.url,
          note: `O texto não apareceu em ${timeoutMs} ms. A página pode ter mudado, ou o texto pode estar em outra parte dela.`,
        });
      }
      await sleep(WAIT_POLL_MS, context.signal);
      page = await gateway.read(botId);
    }
    return ok({
      found: true,
      waitedMs: Date.now() - startedAt,
      url: page.url,
    });
  }

  /**
   * Ler uma página pública pelo motor sem pixels, sem abrir sessão do Bot.
   *
   * Passa pelo mesmo gateway governado da navegação: a recusa da política é terminal e nunca
   * aciona o Chromium por outro caminho — contornar a recusa seria o desvio que o gateway existe
   * para impedir. Só a falha técnica (o motor não respondeu) informa o Chromium como alternativa
   * explícita, sujeito às mesmas permissões; o modelo decide, nunca esta ferramenta sozinha.
   */
  async function fetchPage(
    call: ToolCall,
    botId: string,
    actor: ActionActor,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    let url: string;
    try {
      url = textOf(call, "url");
    } catch (error) {
      return failure(error, false, signal);
    }
    try {
      return ok(await gateway.fetch(botId, actor, url));
    } catch (error) {
      if (
        error instanceof ActionRefusedError ||
        error instanceof NavigationRefusedError
      ) {
        return failure(error, false, signal);
      }
      if (signal.aborted) {
        return failure(error, false, signal);
      }
      if (error instanceof ComputerUnavailableError) {
        return {
          ...failure(error, false, signal),
          result: {
            fallback: {
              tool: "navigate",
              note: "O motor sem pixels não respondeu. Se a leitura continuar necessária, abra o endereço no Chromium com `navigate` e leia com `read_page`: vale a mesma política, e páginas com sessão ou pixels só existem por lá mesmo.",
            },
          },
        };
      }
      return failure(error, false, signal);
    }
  }
  /**
   * Preencher vários campos sem nova chamada do modelo por campo.
   *
   * Cada campo passa pelo mesmo caminho governado das ferramentas unitárias
   * (`gateway.type` / `gateway.select`), então política e auditoria valem por campo:
   * a ferramenta composta não desvia aprovação nem regra. Antes de cada campo depois
   * do primeiro, um snapshot novo e um plano novo só para aquele campo — refs e
   * snapshotId de geração antiga nunca são reutilizados, e se o rótulo não casar mais
   * a estrutura relevante mudou e a ferramenta para com o parcial. Nunca submit, nunca
   * Enter, nunca clique: enviar continua decisão do modelo com ferramenta própria.
   * Concluídos e pendentes carregam rótulos, nunca os valores digitados.
   */
  async function fillForm(
    call: ToolCall,
    context: ToolCallContext,
    botId: string,
    actor: ActionActor,
  ): Promise<ToolOutcome> {
    let values: Record<string, string>;
    try {
      values = pairsOf(call);
    } catch (error) {
      return failure(error, true, context.signal);
    }
    const wanted = Object.keys(values);
    if (wanted.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENTS",
          message: `A ferramenta ${call.name} precisa de ao menos um par em "values".`,
        },
      };
    }
    if (context.signal.aborted) {
      return {
        ok: false,
        error: { code: "STOPPED", message: "A tarefa foi interrompida." },
        result: { filled: [], pending: wanted, unknown: [] },
      };
    }
    let snapshot: SnapshotResult;
    try {
      snapshot = await gateway.snapshot(botId);
    } catch (error) {
      return failure(error, false, context.signal);
    }
    const firstForm = extractForm(snapshot);
    const firstPlan = planFill(firstForm, values);
    if (firstPlan.assignments.length === 0) {
      return {
        ok: false,
        error: {
          code: "INVALID_ARGUMENTS",
          message:
            `Nenhum rótulo de values casou com um campo da página: ` +
            `${firstPlan.unknown.join(", ")}. Leia o formulário de novo antes de preencher.`,
        },
      };
    }
    const filled: { label: string; ref: string }[] = [];
    const queue = [...firstPlan.assignments];
    let current = snapshot;
    for (const [index, item] of queue.entries()) {
      if (context.signal.aborted) {
        return {
          ok: false,
          error: { code: "STOPPED", message: "A tarefa foi interrompida." },
          result: partial(
            current,
            filled,
            queue.slice(index),
            firstPlan.unknown,
          ),
        };
      }
      let ref = item.ref;
      let how = item.how;
      if (index > 0) {
        let fresh: typeof snapshot;
        try {
          fresh = await gateway.snapshot(botId);
        } catch (error) {
          return {
            ...failure(error, false, context.signal),
            result: partial(
              current,
              filled,
              queue.slice(index),
              firstPlan.unknown,
            ),
          };
        }
        const freshForm = extractForm(fresh);
        const renewed = planFill(freshForm, { [item.label]: item.value });
        const next = renewed.assignments[0];
        if (!next) {
          return {
            ok: false,
            stale: true,
            error: {
              code: "STALE_SNAPSHOT",
              message:
                `A página mudou antes do campo "${item.label}": o rótulo não casa ` +
                `mais com um campo. Mapeie de novo antes de continuar.`,
            },
            result: partial(
              current,
              filled,
              queue.slice(index),
              firstPlan.unknown,
            ),
          };
        }
        if (
          fresh.url !== snapshot.url ||
          freshForm.fields.length !== firstForm.fields.length ||
          freshForm.fields.some((field, position) => {
            const original = firstForm.fields[position];
            return (
              !original ||
              field.label !== original.label ||
              field.kind !== original.kind ||
              field.role !== original.role ||
              field.required !== original.required
            );
          }) ||
          next.how !== item.how ||
          next.kind !== item.kind
        ) {
          return {
            ok: false,
            stale: true,
            error: {
              code: "STALE_SNAPSHOT",
              message:
                `A página mudou antes do campo "${item.label}": a estrutura já não é a ` +
                `mesma do início do preenchimento. Mapeie de novo antes de continuar.`,
            },
            result: partial(
              current,
              filled,
              queue.slice(index),
              firstPlan.unknown,
            ),
          };
        }
        current = fresh;
        ref = next.ref;
        how = next.how;
      }
      if (how !== "fill" && how !== "select") {
        return {
          ok: false,
          error: {
            code: "FIELD_NOT_SUPPORTED",
            message:
              `O campo "${item.label}" não é texto nem seleção, e o fill_form só ` +
              `preenche esses dois.`,
          },
          result: partial(
            current,
            filled,
            queue.slice(index),
            firstPlan.unknown,
          ),
        };
      }
      try {
        if (how === "fill") {
          await gateway.type(
            botId,
            actor,
            { ref, snapshotId: current.snapshotId, text: item.value },
            context.signal,
          );
        } else {
          await gateway.select(
            botId,
            actor,
            { ref, snapshotId: current.snapshotId, value: item.value },
            context.signal,
          );
        }
      } catch (error) {
        return {
          ...failure(error, true, context.signal),
          result: partial(
            current,
            filled,
            queue.slice(index),
            firstPlan.unknown,
          ),
        };
      }
      filled.push({ label: item.label, ref });
    }
    return ok(
      {
        url: current.url,
        filled,
        pending: [],
        unknown: firstPlan.unknown,
        fieldCount: firstForm.fields.length,
      },
      { snapshotId: current.snapshotId },
    );
  }

  /**
   * O parcial que acompanha toda parada no meio do preenchimento: rótulos
   * concluídos e pendentes, nunca os valores.
   */
  function partial(
    current: SnapshotResult,
    filled: { label: string; ref: string }[],
    rest: { label: string }[],
    unknown: string[],
  ): Record<string, unknown> {
    return {
      url: current.url,
      filled,
      pending: rest.map((item) => item.label),
      unknown,
    };
  }
}

/**
 * Um resultado, com os campos do computador e sem o que não deve entrar num passo.
 *
 * O texto digitado nunca aparece: o `ActionResult` já não o devolve, e esta função não o acrescenta.
 * O que entra num passo é o rótulo do elemento e o endereço em que a página ficou.
 */
function ok(result: unknown, extra: Record<string, unknown> = {}): ToolOutcome {
  return {
    ok: true,
    result: { ...(asRecord(result) ?? { result }), ...extra },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Uma lista de elementos cortada ao que cabe no contexto de um modelo. */
function trim(
  elements: SnapshotElement[],
  maxElements: number,
): Record<string, unknown> {
  return {
    elements: elements.slice(0, maxElements),
    elementsOmitted: Math.max(0, elements.length - maxElements),
  };
}

/**
 * Traduzir a falha para o que o modelo deve fazer a seguir.
 *
 * Duas distinções carregam o peso. Uma ref vencida é `stale`: nada quebrou e a resposta certa é
 * mapear de novo. E uma ação que pode ter acontecido sem confirmação é `uncertain`: repetir um envio
 * que talvez tenha sido enviado é o erro que o PRD inteiro existe para evitar, então a tarefa para em
 * reconciliação e uma pessoa decide.
 */
function failure(
  error: unknown,
  acting: boolean,
  signal: AbortSignal,
): ToolOutcome {
  if (signal.aborted) {
    return {
      ok: false,
      error: {
        code: "STOPPED",
        message:
          "A tarefa foi interrompida (pausa, cancelamento ou perda do lease).",
      },
    };
  }
  if (error instanceof ToolArgumentError) {
    return {
      ok: false,
      error: { code: "INVALID_ARGUMENTS", message: error.message },
    };
  }
  if (error instanceof ActionRefusedError) {
    return { ok: false, refused: { rule: error.rule, reason: error.message } };
  }
  if (error instanceof NavigationRefusedError) {
    return {
      ok: false,
      refused: {
        rule: null,
        reason: error.message,
        ...(error.cause === "private_network"
          ? { cause: "private_network" as const }
          : {}),
      },
    };
  }
  if (error instanceof StaleSnapshotError) {
    return {
      ok: false,
      stale: true,
      error: { code: "STALE_SNAPSHOT", message: error.message },
    };
  }
  if (error instanceof ElementNotFoundError) {
    return {
      ok: false,
      stale: true,
      error: { code: "ELEMENT_NOT_FOUND", message: error.message },
    };
  }
  if (error instanceof HumanHasControlError) {
    return {
      ok: false,
      error: { code: "HUMAN_CONTROL", message: error.message },
    };
  }
  if (error instanceof SecretPendingError) {
    return {
      ok: false,
      error: { code: "SECRET_PENDING", message: error.message },
    };
  }
  if (error instanceof ViewportError) {
    return {
      ok: false,
      error: { code: "VIEWPORT_ERROR", message: error.message },
    };
  }
  if (error instanceof ComputerUnavailableError) {
    if (acting) {
      // O computador parou de responder no meio de uma ação que muda a página. Não é uma falha
      // limpa: a ação pode ter sido aplicada antes da resposta se perder, e por isso o resultado é
      // incerto e não um erro para tentar de novo.
      return {
        ok: false,
        uncertain: true,
        error: {
          code: "EFFECT_UNCERTAIN",
          message: `A ação foi enviada e o computador não confirmou: ${error.message}`,
        },
      };
    }
    return {
      ok: false,
      error: { code: "COMPUTER_UNAVAILABLE", message: error.message },
    };
  }
  return {
    ok: false,
    error: {
      code: "TOOL_FAILED",
      message: error instanceof Error ? error.message : "A ferramenta falhou.",
    },
  };
}

function textOf(call: ToolCall, field: string): string {
  const value = call.arguments[field];
  if (typeof value !== "string" || !value) {
    throw new ToolArgumentError(
      `A ferramenta ${call.name} precisa do campo ${field}.`,
    );
  }
  return value;
}

function numberOf(call: ToolCall, field: string): number {
  const value = call.arguments[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolArgumentError(
      `A ferramenta ${call.name} precisa do campo ${field}, numérico.`,
    );
  }
  return value;
}

/**
 * Os pares rótulo/valor que o modelo mandou, na ordem.
 *
 * Lista de pares, e não um objeto livre, porque é assim que um modelo acerta: a chave passa a ter um
 * lugar nomeado, e o rótulo não se confunde com o nome do campo. O último valor de um rótulo repetido
 * vence — quem escreveu duas vezes quis a segunda.
 */
function pairsOf(call: ToolCall): Record<string, string> {
  const raw = call.arguments.values;
  if (!Array.isArray(raw)) {
    throw new ToolArgumentError(
      `A ferramenta ${call.name} precisa de uma lista em "values".`,
    );
  }
  const values: Record<string, string> = {};
  for (const item of raw) {
    const pair = item as { label?: unknown; value?: unknown } | null;
    const label = typeof pair?.label === "string" ? pair.label.trim() : "";
    if (!label) {
      throw new ToolArgumentError("Cada item de values precisa de um label.");
    }
    values[label] =
      typeof pair?.value === "string"
        ? pair.value
        : pair?.value === undefined || pair?.value === null
          ? ""
          : String(pair.value);
  }
  return values;
}

/** Argumento faltando é resposta inválida do modelo, e vale como tal. */
class ToolArgumentError extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

const string = (description: string) => ({ type: "string", description });
const integer = (description: string) => ({ type: "integer", description });
const boolean = (description: string) => ({ type: "boolean", description });

/** Uma lista de itens iguais, que é como os modelos acertam um par rótulo/valor. */
function array(items: Record<string, unknown>, description: string) {
  return { type: "array", items, description };
}

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
