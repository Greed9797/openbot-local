import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "src");

/**
 * Palavras que só aparecem em inglês.
 *
 * Não é um detector de idioma: é uma lista de palavras de função que uma frase em português não tem.
 * Duas delas numa string de interface é o bastante para dizer que ela não foi traduzida, e nenhuma
 * palavra técnica que sobrevive em português — "deployment", "token", "commit" — está aqui.
 */
const INGLESAS = new Set(
  `the of and to is are was were be been can cannot could should would will
   this that these those with without for from not your you their there here
   what who whose when where why how add edit delete remove save cancel close
   create new all any some each every more most less only just still yet
   already again back next previous first last name email password sign
   settings none nothing something anything about into onto over under
   between across through during before after until while does did done
   which them they it its his her our us we`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * O que a pessoa lê, e não o que o modelo lê.
 *
 * `description` e `confirmation` num componente da galeria são a descrição da FERRAMENTA: o texto que
 * o Bot lê para decidir quando desenhar aquilo. Traduzir isso não melhora a interface de ninguém e
 * piora o julgamento do modelo, então esta varredura não olha para lá. O que ela olha é rótulo,
 * título, placeholder, mensagem de erro e texto solto na tela.
 */
const ATRIBUTOS =
  /\b(placeholder|title|aria-label|label|fallback|emptyText)\s*[=:]\s*"([^"]{6,})"/g;
const TEXTO_SOLTO = />\s*([A-Z][A-Za-z0-9 ,.'’\-?!]{6,})\s*</g;

/** Endereços de exemplo. São endereços, não frases, e traduzir um quebra o exemplo. */
const EXEMPLOS = /^(https?:\/\/|[\w.+-]+@[\w-]+\.)/;

function arquivosDaInterface(directory: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.tsx?$/.test(entry) || entry.endsWith(".gen.ts")) continue;
      found.push(path);
    }
  };
  walk(directory);
  return found;
}

function pareceIngles(texto: string): boolean {
  if (EXEMPLOS.test(texto.trim())) return false;
  // Um acento resolve a questão sem contar palavra nenhuma.
  if (/[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/.test(texto)) return false;
  const palavras = texto.toLowerCase().match(/[a-z']+/g) ?? [];
  if (palavras.length < 3) return false;
  return palavras.filter((palavra) => INGLESAS.has(palavra)).length >= 2;
}

describe("a interface fala português", () => {
  /**
   * A tradução não é um estado, é uma coisa que apaga.
   *
   * Este fork acompanha um upstream em inglês, e todo merge traz texto novo. O dicionário em
   * `tools/pt-br/` só sabe reaplicar o que alguém já traduziu uma vez — uma tela nova passa por ele
   * inteira sem uma queixa, que foi exatamente como a barra lateral do Admin ficou em inglês num
   * app onde tudo o mais já estava traduzido.
   *
   * Se este teste reprovar depois de um merge, o trabalho é traduzir as strings que ele nomeia. Se
   * ele reprovar por uma frase que deve mesmo continuar em inglês, o lugar de dizer isso é aqui.
   */
  test("nenhuma tela nova chega em inglês", () => {
    const encontrados: string[] = [];

    for (const path of arquivosDaInterface(ROOT)) {
      const linhas = readFileSync(path, "utf8").split("\n");
      linhas.forEach((linha, indice) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(linha)) return;
        const candidatos = [
          ...[...linha.matchAll(ATRIBUTOS)].map((m) => m[2] as string),
          ...[...linha.matchAll(TEXTO_SOLTO)].map((m) => m[1] as string),
        ];
        for (const texto of candidatos) {
          if (!pareceIngles(texto)) continue;
          encontrados.push(
            `${path.slice(ROOT.length + 1)}:${indice + 1}  ${texto.trim()}`,
          );
        }
      });
    }

    expect(encontrados).toEqual([]);
  });
});
