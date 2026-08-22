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
  /\b(placeholder|title|aria-label|label|fallback|emptyText)\s*[=:]\s*"([^"]{3,})"/g;
const TEXTO_SOLTO = />\s*([A-Z][A-Za-z0-9 ,.'’\-?!]{6,})\s*</g;

/*
 * O QUE ESTA VARREDURA NÃO ALCANÇA, e por que não vale forçar.
 *
 * Texto que vive numa string literal solta — um ternário como
 * `ativo ? "Stop the action" : "Record it and allow it"`, um array de rótulos — não tem nome de
 * atributo nem tag por onde procurar. Varrer todo literal foi tentado e medido: os três detectores
 * acima achavam 81 strings de verdade, e varrer literal solto passou a 266, sendo a diferença quase
 * inteira nome de classe do Tailwind e descrição de ferramenta, que fica em inglês de propósito.
 * Uma varredura que reprova por 185 coisas certas é uma varredura que alguém desliga.
 */

/** Endereços de exemplo. São endereços, não frases, e traduzir um quebra o exemplo. */
const EXEMPLOS = /^(https?:\/\/|[\w.+-]+@[\w-]+\.)/;

/**
 * Palavras que denunciam sozinhas.
 *
 * A regra das duas palavras de função precisa de uma frase, e um título não é uma frase:
 * `title="Computers"` passou por ela inteiro, numa página cujo corpo já estava traduzido. Estas são
 * as poucas palavras de interface que, aparecendo em qualquer texto visível, significam que aquele
 * pedaço não foi traduzido — escolhidas por não serem também palavras portuguesas nem termos
 * técnicos que ficam em inglês de propósito.
 */
const DENUNCIAM =
  /\b(computers?|credentials?|boundaries|connectors?|settings|people|audit|overview|search|save|cancel|delete|remove|close|reset|stop|start|browser|password|sign in|sign out|log out|working|loading|failed|unknown|enabled|disabled)\b/i;

/**
 * Os pedaços de texto JSX de uma linha.
 *
 * Um parágrafo real atravessa tags: em `<strong>Stop</strong> closes the browser and keeps its`, o
 * texto está partido por elementos que dão ênfase, e o último pedaço não fecha em `<` nenhum porque
 * a frase continua na linha seguinte. Por isso os dois casos: o que está entre um `>` e um `<`, e o
 * que vem depois do último `>` até o fim da linha.
 *
 * Só texto entre tags, e nunca a linha inteira. Uma linha de código não é texto — varrê-la inteira
 * faz uma lista de classes do Tailwind (`flex items-center gap-2 text-sm`) parecer uma frase em
 * inglês, e a varredura afoga em ruído exatamente o que ela existe para achar.
 */
/** Uma propriedade, um identificador solto, a continuação de uma expressão. Não é frase. */
function ehCodigo(texto: string): boolean {
  return (
    /^[\w$.]+\s*[:,]/.test(texto) ||
    /^[a-z_]+,?$/.test(texto) ||
    texto.startsWith(":") ||
    texto.startsWith(".")
  );
}

function textosJsxDe(linha: string): string[] {
  const pedacos: string[] = [];

  /*
   * Uma linha que é só texto.
   *
   * Um parágrafo JSX quebrado em várias linhas tem linhas do meio sem uma tag sequer: a frase começa
   * numa e termina noutra, e nenhuma delas casa com "algo depois de um `>`". Uma linha sem nenhuma
   * pontuação de programa e com três palavras é texto que alguém lê, não código.
   */
  const inteira = linha.trim();
  /*
   * `!ehCodigo` porque nem toda linha sem tag é uma frase. Uma propriedade de objeto
   * (`name: profile.name,`) e um identificador solto numa chamada quebrada em linhas (`disabled`,
   * `failed,`) também não têm pontuação de programa nenhuma na própria linha, e passariam por aqui
   * como se fossem texto que alguém lê.
   */
  if (
    inteira.length > 3 &&
    !/[=;(){}[\]"`|<>]/.test(inteira) &&
    !ehCodigo(inteira)
  ) {
    pedacos.push(inteira.replace(/\s+/g, " "));
  }

  for (const encontrado of linha.matchAll(/>([^<>{}]+)(?:<|$)/g)) {
    const texto = (encontrado[1] ?? "").replace(/\s+/g, " ").trim();
    /*
     * O `>` de `=>`, de `===` e de um seletor CSS não fecha tag nenhuma, e o que vem depois dele é
     * código. Em vez de tentar reconhecer cada uma dessas formas, esta linha reconhece o que texto
     * de interface NÃO tem: pontuação de programa. Uma frase que alguém lê na tela não traz `=`,
     * `;`, parênteses ou aspas.
     */
    if (texto.length > 3 && !/[=;(){}[\]"`|]/.test(texto)) pedacos.push(texto);
  }
  return pedacos;
}

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
      /*
       * Um comentário de bloco só é reconhecível linha a linha se alguém contar as aberturas e os
       * fechamentos. A linha do meio de um comentário longo, sem `*` na margem, é indistinguível de
       * um parágrafo — e comentário é para quem lê o código, não para quem usa a tela.
       */
      let dentroDeComentario = false;
      linhas.forEach((linha, indice) => {
        const abre = linha.includes("/*");
        const fecha = linha.includes("*/");
        if (dentroDeComentario) {
          if (fecha) dentroDeComentario = false;
          return;
        }
        if (abre && !fecha) dentroDeComentario = true;
        if (abre) return;
        if (/^\s*(\/\/|\*)/.test(linha)) return;
        const candidatos = [
          ...[...linha.matchAll(ATRIBUTOS)].map((m) => m[2] as string),
          ...[...linha.matchAll(TEXTO_SOLTO)].map((m) => m[1] as string),
        ];
        candidatos.push(...textosJsxDe(linha));

        for (const texto of candidatos) {
          const suspeito =
            pareceIngles(texto) ||
            (DENUNCIAM.test(texto) && !EXEMPLOS.test(texto.trim()));
          if (!suspeito) continue;
          encontrados.push(
            `${path.slice(ROOT.length + 1)}:${indice + 1}  ${texto.trim()}`,
          );
        }
      });
    }

    expect(encontrados).toEqual([]);
  });
});
