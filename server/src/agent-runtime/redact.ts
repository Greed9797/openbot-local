/**
 * O que não pode ir para um modelo mesmo quando a página o mostra.
 *
 * Uma captura de tela é a parte fácil: campos de senha são pintados e a imagem não é tirada durante
 * a digitação de um segredo. O texto é mais difícil, porque uma página pode mostrar um token de API
 * na própria documentação e um cartão de crédito no próprio resumo da conta — e esse texto vai
 * inteiro para o modelo, para o passo da tarefa e para o histórico que os próximos passos leem.
 *
 * Só padrões de alta confiança estão aqui. Um regex que apaga números longos "por precaução" estraga
 * tarefas legítimas (números de pedido, códigos de barras, valores) e some com a informação sem
 * ninguém saber. O que não dá para classificar por padrão vira classificação de página, em
 * `image-input.ts`, e não adivinhação aqui.
 */

/** Marcador do que foi retirado. Diz que houve um corte, para o modelo não ler o texto como completo. */
export const REDACTED = "[redigido]";

type Rule = { name: string; pattern: RegExp; replacement: string };

const RULES: Rule[] = [
  // Um cabeçalho de autorização copiado para o corpo de uma página de exemplo.
  {
    name: "bearer",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  // Chaves de API dos formatos que aparecem em documentação e em painéis de conta.
  {
    name: "api_key",
    pattern:
      /\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|AKIA|ASIA)[_-][A-Za-z0-9_-]{12,}\b/g,
    replacement: REDACTED,
  },
  // JWT: três segmentos em base64url, o primeiro sempre começa em `eyJ` ({"alg"...).
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  // `senha: hunter2`, `api_key = ...`. O rótulo fica: saber que havia uma senha ali é informação.
  {
    name: "labelled_secret",
    pattern:
      /\b(senha|password|passwd|pwd|token|secret|api[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s,;]{6,})/gi,
    replacement: `$1$2${REDACTED}`,
  },
  // Cartões: 13 a 19 dígitos, com separadores opcionais, e só quando o dígito verificador fecha.
  {
    name: "card",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    replacement: REDACTED,
    // A checagem é feita em código, não no padrão: sem o Luhn, qualquer sequência longa de dígitos
    // (um número de pedido, um CNPJ, um código de rastreio) sumiria.
  },
];

export type RedactionResult = {
  text: string;
  /** How many spans were removed, so a step can record that the text was not delivered whole. */
  redactions: number;
  /** Which rules fired, once each. Never the values. */
  rules: string[];
};

export function redactSecrets(text: string): RedactionResult {
  if (!text) return { text, redactions: 0, rules: [] };
  let result = text;
  let redactions = 0;
  const fired = new Set<string>();

  for (const rule of RULES) {
    result = result.replace(rule.pattern, (match, ...groups) => {
      if (rule.name === "card" && !looksLikeCard(match)) return match;
      // Um rótulo cujo valor já foi redigido por outra regra não é uma segunda redação: sem isto,
      // "token: sk-..." contaria duas vezes e o passo relataria mais cortes do que houve.
      if (rule.name === "labelled_secret" && String(groups[2]) === REDACTED) {
        return match;
      }
      redactions += 1;
      fired.add(rule.name);
      if (!groups.length) return rule.replacement;
      return rule.replacement.replace(
        /\$(\d)/g,
        (_whole, index: string) => String(groups[Number(index) - 1] ?? ""),
      );
    });
  }

  return { text: result, redactions, rules: [...fired] };
}

/** Luhn, sobre os dígitos de um candidato. É o que separa um cartão de um número qualquer. */
function looksLikeCard(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
