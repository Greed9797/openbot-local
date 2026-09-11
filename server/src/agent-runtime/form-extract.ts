/**
 * O formulário que o snapshot ARIA já descreve, lido sem tocar no navegador.
 *
 * O snapshot lista controles com rótulo resolvido (como um leitor de tela resolve), então extrair
 * um formulário é só classificar essa lista: o que é campo, o que é opção de um campo, o que é
 * botão. Nada aqui executa ação nenhuma e nada depende de rede ou de browser — a integração com o
 * catálogo de ferramentas (transformar um `FillAssignment` em `fill`/`select`/`check`) pertence a
 * outro módulo, que consome exatamente os tipos exportados daqui.
 *
 * Três decisões que o leitor deve conhecer:
 *
 * - Rádio vira um campo por grupo contíguo, não um campo por botão. O snapshot não carrega o
 *   `fieldset`, então o grupo é derivado do rótulo: "Tamanho: M" parte em grupo "Tamanho" e opção
 *   "M" pelo `:`; sem `:`, o grupo é tudo menos a última palavra e a opção é a última palavra
 *   ("Cor Azul" vira grupo "Cor", opção "Azul"). Só irmãos contíguos com o mesmo grupo se juntam —
 *   um grupo repetido mais abaixo vira outro campo, porque a ordem do snapshot é a ordem da página.
 * - `textarea` sem `role` próprio se reconhece de dois jeitos: `type: "textarea"`, ou um nome com
 *   quebra de linha (o rótulo resolvido de um controle multilinha). É o critério porque é o único
 *   sinal que o snapshot carrega; `role: "textarea"` vale direto.
 * - `planFill` preenche mesmo campo já `filled` quando há valor para ele: o agente pode estar
 *   corrigindo, não só estreando. Cada chave gera no máximo um assignment, na ordem das chaves.
 */

export type FormFieldKind =
  | "text"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "password"
  | "url"
  | "search"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "file"
  | "unknown";

/**
 * Espelho estrutural do `SnapshotElement` do computador: os mesmos campos, sem importar o
 * servidor do computador. Quem chama passa a lista de elementos que já tem em mãos.
 */
export type FormSnapshotElement = {
  ref: string;
  role: string;
  name: string;
  value?: string;
  type?: string;
  disabled?: boolean;
  checked?: boolean;
};

/** O mínimo do snapshot que o extrator lê: só a lista de elementos. */
export type FormSnapshot = {
  elements: FormSnapshotElement[];
};

export type FormField = {
  ref: string;
  role: string;
  label: string;
  kind: FormFieldKind;
  required: boolean;
  filled: boolean;
  currentValue?: string;
  options?: string[];
  group?: string;
};

export type FormExtract = {
  fields: FormField[];
  /** Refs dos campos obrigatórios, na ordem do snapshot. Refs, não rótulos: rótulo repete, ref não. */
  required: string[];
  /** Refs dos campos ainda não preenchidos, na ordem do snapshot. */
  unfilled: string[];
  buttons: { ref: string; label: string; role: string }[];
};

export type FillAssignment = {
  ref: string;
  label: string;
  kind: FormFieldKind;
  how: "fill" | "select" | "check";
  /**
   * O valor como veio em `values`, sem transformar. Para `how: "check"`, "true"/"false"
   * marca/desmarca e qualquer outro valor é a própria opção do rádio.
   */
  value: string;
};

export type FillPlan = {
  assignments: FillAssignment[];
  /** Refs dos campos obrigatórios sem valor em `values`. */
  missing: string[];
  /** Chaves de `values` sem campo correspondente, como vieram. */
  unknown: string[];
};

/**
 * Papéis que viram campo. `option` fica de fora de propósito: vira `options` do select acima.
 * `button`, `link`, `menuitem` e `tab` também ficam de fora — botão tem saída própria.
 */
const FIELD_ROLES: Record<string, true> = {
  textbox: true,
  searchbox: true,
  spinbutton: true,
  checkbox: true,
  combobox: true,
  listbox: true,
  radio: true,
  switch: true,
  slider: true,
  textarea: true,
  file: true,
};

/** Grupos de sinônimos já normalizados (ver `normalizeLabel`). */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  ["nome", "name"],
  ["sobrenome", "surname", "last name", "lastname"],
  ["email", "e mail"],
  ["telefone", "phone", "celular", "whatsapp", "tel", "fone"],
  ["empresa", "company"],
  ["endereco", "address"],
  ["cidade", "city"],
  ["estado", "state"],
  ["pais", "country"],
  ["cep", "zip", "postal", "postal code", "codigo postal"],
  ["descricao", "description"],
  ["observacoes", "observacao", "notes", "note"],
  ["preco", "price", "valor"],
  ["quantidade", "quantity", "qtd"],
  ["titulo", "title"],
  ["categoria", "category"],
  ["sku", "codigo", "code"],
  ["cor", "color", "colour"],
];

export function extractForm(snapshot: Pick<FormSnapshot, "elements">): FormExtract {
  const fields: FormField[] = [];
  const buttons: FormExtract["buttons"] = [];
  /** O select mais próximo acima: todo `option` dali para frente é opção dele. */
  let openSelect: FormField | undefined;
  /** A corrida contígua de rádios do mesmo grupo que ainda está aberta. */
  let openRadio: { field: FormField; group: string } | undefined;

  for (const el of snapshot.elements) {
    const role = el.role.toLowerCase().trim();
    const type = (el.type ?? "").toLowerCase().trim();
    const label = el.name.trim();

    // `option` pendura no select acima e quebra corrida de rádio: opção não é campo.
    if (role === "option") {
      if (label !== "" && openSelect) {
        (openSelect.options ??= []).push(label);
      }
      openRadio = undefined;
      continue;
    }

    // Botão com rótulo, na ordem do snapshot; sem nome é ignorado.
    if (isButtonRole(role, type)) {
      if (label !== "") {
        buttons.push({ ref: el.ref, label, role: el.role });
      }
      openRadio = undefined;
      continue;
    }

    // Rádio: agrupa com os irmãos contíguos do mesmo grupo; sem nome não há grupo nem opção.
    if (role === "radio") {
      if (label === "") continue;
      const { group, option } = splitRadioName(label);
      if (openRadio && openRadio.group === group) {
        openRadio.field.options?.push(option);
        if (isRequired(label)) openRadio.field.required = true;
        if (el.checked === true) {
          openRadio.field.filled = true;
          openRadio.field.currentValue = nonEmptyValue(el) ?? option;
        }
        continue;
      }
      const field: FormField = {
        ref: el.ref,
        role: el.role,
        label: group,
        kind: "radio",
        required: isRequired(group) || isRequired(label),
        filled: el.checked === true,
        options: [option],
        group,
      };
      const current = nonEmptyValue(el);
      if (current !== undefined) field.currentValue = current;
      else if (el.checked === true) field.currentValue = option;
      fields.push(field);
      openRadio = { field, group };
      continue;
    }

    // Qualquer outro elemento quebra a corrida de rádio; o select aberto continua valendo,
    // porque `option` pertence ao select mais próximo acima mesmo com elementos no meio.
    openRadio = undefined;
    if (FIELD_ROLES[role] !== true) continue;

    const kind = resolveKind(el);
    const checkable = role === "checkbox" || role === "switch";
    const field: FormField = {
      ref: el.ref,
      role: el.role,
      label,
      kind,
      required: isRequired(label),
      filled: checkable ? el.checked === true : nonEmptyValue(el) !== undefined,
    };
    const current = nonEmptyValue(el);
    if (current !== undefined) field.currentValue = current;
    if (kind === "select") openSelect = field;
    fields.push(field);
  }

  return {
    fields,
    required: fields.filter((field) => field.required).map((field) => field.ref),
    unfilled: fields.filter((field) => !field.filled).map((field) => field.ref),
    buttons,
  };
}

export function planFill(extract: FormExtract, values: Record<string, string>): FillPlan {
  const assignments: FillAssignment[] = [];
  const unknown: string[] = [];
  const covered = new Set<string>();

  for (const [key, value] of Object.entries(values)) {
    const field = findField(extract.fields, key);
    if (!field) {
      unknown.push(key);
      continue;
    }
    assignments.push({
      ref: field.ref,
      label: field.label,
      kind: field.kind,
      how: howFor(field),
      value,
    });
    covered.add(field.ref);
  }

  return {
    assignments,
    missing: extract.required.filter((ref) => !covered.has(ref)),
    unknown,
  };
}

/** `role: "button"`, ou um `type` de submissão mesmo sob outro papel. */
function isButtonRole(role: string, type: string): boolean {
  if (role === "button") return true;
  return type === "submit" || type === "image";
}

function resolveKind(el: FormSnapshotElement): FormFieldKind {
  const role = el.role.toLowerCase().trim();
  const type = (el.type ?? "").toLowerCase().trim();

  if (type === "textarea" || role === "textarea") return "textarea";
  // Nome com quebra de linha: o rótulo resolvido de um controle multilinha.
  if (role === "textbox" && /[\r\n]/.test(el.name)) return "textarea";

  switch (type) {
    case "text":
      return "text";
    case "email":
      return "email";
    case "tel":
      return "tel";
    case "number":
      return "number";
    case "date":
      return "date";
    case "password":
      return "password";
    case "url":
      return "url";
    case "search":
      return "search";
    case "file":
      return "file";
    case "checkbox":
      return "checkbox";
    case "radio":
      return "radio";
    default:
      break;
  }

  switch (role) {
    case "textbox":
      return "text";
    case "searchbox":
      return "search";
    case "combobox":
    case "listbox":
      return "select";
    case "checkbox":
    case "switch":
      return "checkbox";
    case "radio":
      return "radio";
    case "spinbutton":
    case "slider":
      return "number";
    case "file":
      return "file";
    default:
      return "unknown";
  }
}

function splitRadioName(label: string): { group: string; option: string } {
  const colon = label.indexOf(":");
  if (colon >= 0) {
    const group = label.slice(0, colon).trim();
    const option = label.slice(colon + 1).trim();
    if (group !== "" && option !== "") return { group, option };
  }
  const words = label.split(/\s+/).filter((word) => word !== "");
  if (words.length >= 2) {
    return { group: words.slice(0, -1).join(" "), option: words[words.length - 1] };
  }
  return { group: label, option: label };
}

/** `*` no rótulo, ou obrigatorio/obrigatoria/required com ou sem acento e em qualquer caixa. */
function isRequired(label: string): boolean {
  if (label.includes("*")) return true;
  const flat = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return (
    flat.includes("obrigatorio") || flat.includes("obrigatoria") || flat.includes("required")
  );
}

function nonEmptyValue(el: FormSnapshotElement): string | undefined {
  if (typeof el.value !== "string" || el.value.trim() === "") return undefined;
  return el.value;
}

/** Minúsculas, sem acentos, sem pontuação, espaços colapsados. */
function normalizeLabel(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Membro de uma palavra casa por palavra inteira; expressão casa por substring. */
function phraseIn(normalizedLabel: string, member: string): boolean {
  if (member.includes(" ")) return normalizedLabel.includes(member);
  return normalizedLabel.split(" ").includes(member);
}

/**
 * Primeiro o rótulo exato normalizado, depois um sinônimo conhecido, depois continência —
 * e a continência só quando inequívoca, com exatamente um campo candidato.
 */
function findField(fields: FormField[], key: string): FormField | undefined {
  const nk = normalizeLabel(key);
  if (nk === "") return undefined;

  const byExact = fields.find((field) => normalizeLabel(field.label) === nk);
  if (byExact) return byExact;

  const groups = ALIAS_GROUPS.filter((group) => group.some((member) => phraseIn(nk, member)));
  if (groups.length > 0) {
    const byAlias = fields.find((field) => {
      const nl = normalizeLabel(field.label);
      if (nl === "") return false;
      return groups.some((group) => group.some((member) => phraseIn(nl, member)));
    });
    if (byAlias) return byAlias;
  }

  const candidates = fields.filter((field) => {
    const nl = normalizeLabel(field.label);
    return nl !== "" && (nl.includes(nk) || nk.includes(nl));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** select mira uma opção; checkbox e rádio marcam/desmarcam; o resto digita. */
function howFor(field: FormField): FillAssignment["how"] {
  if (field.kind === "select") return "select";
  if (field.kind === "checkbox" || field.kind === "radio") return "check";
  return "fill";
}
