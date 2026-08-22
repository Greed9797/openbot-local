#!/usr/bin/env bun
/**
 * Aplica dictionary.json ao código da interface.
 *
 * Por que um script e não uma camada de i18n: o produto fala um idioma só. Uma camada de tradução
 * para um idioma é indireção sem leitor — `t("Close")` custa um dicionário em runtime, uma chave por
 * string e um fallback silencioso quando a chave some, para entregar exatamente o mesmo texto que
 * escrever "Fechar" entrega.
 *
 * Por que o dicionário fica no repositório: o upstream é alpha e cada merge traz texto novo em
 * inglês. Rodar isto de novo depois de um merge retraduz o que voltou, e `--check` diz o que apareceu
 * de novo e ainda não tem tradução.
 *
 * O dicionário é o filtro. Só é substituído o que alguém traduziu à mão, então sintaxe de tipos e
 * identificadores nunca são tocados: eles não estão lá.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const dictionary = JSON.parse(
  readFileSync(join(here, "dictionary.json"), "utf8"),
);
delete dictionary._;

/*
 * Strings entre aspas, tratadas à parte do texto JSX.
 *
 * Ficam num arquivo próprio porque a regra de segurança é outra: o texto JSX é reconhecido pela
 * forma (está entre `>` e `<`, logo é o que a pessoa lê), enquanto uma string entre aspas pode ser
 * qualquer coisa — uma chave, um valor de API, uma instrução ao modelo. A única garantia aqui é a
 * curadoria, então cada entrada foi olhada uma a uma.
 */
const literals = JSON.parse(readFileSync(join(here, "literals.json"), "utf8"));
delete literals._;

const check = process.argv.includes("--check");

/** Atributos cujo valor uma pessoa lê na tela. `name`, `id` e `value` ficam de fora de propósito. */
const HUMAN_ATTRS =
  "placeholder|aria-label|title|label|description|emptyLabel|confirmLabel|cancelLabel|alt|heading|summary|tooltip";

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    // .ts entra junto: erro de tela, rótulo e estado vazio moram tanto em componente quanto em
    // módulo de dados. O casamento de texto JSX simplesmente não encontra nada num .ts.
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

/** Escapa para uso dentro de uma expressão regular. */
const quote = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let changedFiles = 0;
let replacements = 0;
const used = new Set();
/*
 * Entradas cuja tradução já está no código.
 *
 * Sem isto toda rodada depois da primeira acusa o dicionário inteiro como "não casou", porque o
 * inglês realmente sumiu — foi traduzido. O que interessa saber é o contrário: qual entrada não
 * casou com o inglês E também não tem o português em lugar nenhum, que é a que parou de valer.
 */
const already = new Set();

for (const file of sourceFiles(join(repo, "app", "src"))) {
  const before = readFileSync(file, "utf8");
  let after = before;

  /*
   * Comparado com o espaço achatado, porque o formatador reparte um parágrafo traduzido em três
   * linhas e um `includes` literal não o reconhece mais. Sem isto o relatório acusa como perdida
   * cada frase longa que foi traduzida com sucesso.
   */
  const flattened = before.replace(/\s+/g, " ");
  for (const [english, portuguese] of Object.entries({
    ...dictionary,
    ...literals,
  })) {
    if (flattened.includes(portuguese.replace(/\s+/g, " "))) {
      already.add(english);
    }
  }

  /*
   * gallery/ desenha o que o Bot responde e computer-tools descreve as ferramentas: as strings dos
   * dois são lidas pelo modelo, não pela pessoa. Traduzi-las mudaria o comportamento do Bot em vez
   * da interface, então os literais não entram nesses arquivos.
   */
  const modelFacing =
    file.includes("/gallery/") || file.includes("computer-tools");

  if (!modelFacing) {
    for (const [english, portuguese] of Object.entries(literals)) {
      const pattern = new RegExp(`"${quote(english)}"`, "g");
      after = after.replace(pattern, () => {
        replacements += 1;
        used.add(english);
        return `"${portuguese}"`;
      });
    }
  }

  for (const [english, portuguese] of Object.entries(dictionary)) {
    const source = quote(english);

    /*
     * O mesmo texto, aceitando qualquer espaço entre as palavras.
     *
     * O Prettier quebra um parágrafo JSX na largura da linha, então a frase que a pessoa lê como uma
     * só está no arquivo partida em três com indentação no meio. Casar a forma literal encontrava só
     * as curtas; costurar as palavras com `\s+` encontra as duas.
     */
    const loose = english.trim().split(/\s+/).map(quote).join("\\s+");

    /*
     * Texto entre tags. A borda à esquerda tem de ser `>` e à direita `<`, com só espaço em volta,
     * o que mantém a troca dentro de um nó de texto JSX e fora de qualquer expressão.
     */
    const asText = new RegExp(`(>\\s*)${loose}(\\s*<)`, "g");

    /* Valor de atributo, aspas incluídas, só para os atributos que uma pessoa lê. */
    const asAttribute = new RegExp(`((?:${HUMAN_ATTRS})=")${source}(")`, "g");

    for (const pattern of [asText, asAttribute]) {
      after = after.replace(pattern, (_match, open, close) => {
        replacements += 1;
        used.add(english);
        return `${open}${portuguese}${close}`;
      });
    }
  }

  if (after !== before) {
    changedFiles += 1;
    if (!check) writeFileSync(file, after);
  }
}

const unused = Object.keys({ ...dictionary, ...literals }).filter(
  (key) => !used.has(key) && !already.has(key),
);

console.log(
  check
    ? `${replacements} trecho(s) em ${changedFiles} arquivo(s) seriam traduzidos.`
    : `${replacements} trecho(s) traduzidos em ${changedFiles} arquivo(s).`,
);

if (unused.length > 0) {
  /*
   * Entrada sem uso é sinal, não sujeira: ou o upstream reescreveu aquele texto, ou ele está numa
   * forma que este script não alcança (JSX em várias linhas, string montada em código). Vale olhar
   * em vez de apagar.
   */
  console.log(
    `\n${unused.length} entrada(s) sem inglês para casar e sem português no código:`,
  );
  for (const key of unused) console.log(`  ${key}`);
}
