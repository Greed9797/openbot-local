#!/usr/bin/env python3
"""Conversas de vários turnos contra o Bot. Mede o que a bateria de turno único não alcança.

A bateria manda um pedido e lê a resposta. Isso prova que o Bot faz uma tarefa, e não prova nada
sobre a segunda pergunta sobre a mesma coisa — que é onde a queixa real aparece: "ele esquece o que
eu disse". Aqui cada conversa é uma thread só, e o histórico vai crescendo turno a turno exatamente
como a interface manda.

O que dá para julgar por máquina:
  espera.acoes / .contem / .nao_contem   iguais aos da bateria
  espera.igual_ao_turno                  o valor que ele LEU num turno anterior sobreviveu até aqui

O último é o que separa "a conversa continua" de "a conversa continua e ele ainda sabe o número".
"""
import json, re, sys, time

from bateria import audit, julgar, qual_container, turno, url_do

AGENTE = sys.argv[1] if len(sys.argv) > 1 else "general-assistant"
ARQUIVO = next((a for a in sys.argv[2:] if not a.startswith("--")), None)
SO = next((a.split("=")[1] for a in sys.argv if a.startswith("--so=")), None)
URL = url_do(AGENTE)


def conferir_lembranca(espera, texto, respostas):
    """O valor que apareceu num turno antigo ainda está aqui?

    Existe porque um literal na lista de tarefas não serve: o uuid que o Bot leu muda a cada corrida.
    A regra aponta para o turno de origem e diz que forma o valor tem; a conferência é entre duas
    respostas da MESMA corrida.
    """
    ref = espera.get("igual_ao_turno")
    if not ref:
        return None
    origem = respostas.get(ref["turno"], "")
    achado = re.search(ref["padrao"], origem, re.I)
    if not achado:
        # Não é falha de memória: o turno de origem já não trouxe o valor. Dizer qual dos dois é.
        return f"o turno {ref['turno']} não produziu nada com a forma {ref['padrao']!r}"
    if achado.group(0).lower() not in texto.lower():
        return f"perdeu {achado.group(0)!r}, que ele mesmo disse no turno {ref['turno']}"
    return ""


def rodar(conversa):
    print(f"\n### {conversa['id']} — {conversa.get('porque', '')}")
    print(f"{'turno':<7}{'seg':>5}{'ações':>7}{'':>8}  resposta (fim)")

    thread = f"conv-{conversa['id']}-{int(time.time())}"
    historico, respostas, falhas = [], {}, []

    for numero, passo in enumerate(conversa["turnos"], 1):
        antes = audit()
        inicio = time.time()
        texto = turno(
            f"{conversa['id']}t{numero}", passo["diz"],
            historico=historico, thread=thread, url=URL,
        )
        duracao = round(time.time() - inicio)
        acoes = audit() - antes
        respostas[numero] = texto

        veredito, motivo = julgar(passo, acoes, texto)
        perdido = conferir_lembranca(passo.get("espera") or {}, texto, respostas)
        if perdido:
            veredito, motivo = "FALHA", perdido
        elif perdido == "" and not veredito:
            veredito = "passa"

        if veredito == "FALHA":
            falhas.append(f"{conversa['id']} turno {numero}: {motivo}")
        print(f"{numero:<7}{duracao:>5}{acoes:>7}{veredito:>8}  {texto.replace(chr(10), ' ')[-90:]}")

        historico = historico + [
            {"id": f"u{numero}", "role": "user", "content": passo["diz"]},
            {"id": f"a{numero}", "role": "assistant", "content": texto},
        ]

    return falhas


CONVERSAS = [c for c in json.load(open(ARQUIVO)) if not SO or c["id"] == SO]
INICIO = qual_container()
print(f"agente={AGENTE}  conversas={len(CONVERSAS)}  turnos={sum(len(c['turnos']) for c in CONVERSAS)}")
print(f"container do serviço: {INICIO[:12] or '(não encontrado)'}")

todas = []
for conversa in CONVERSAS:
    todas += rodar(conversa)

FIM = qual_container()
if INICIO and FIM and INICIO != FIM:
    print(f"\nATENÇÃO: o serviço foi recriado durante a corrida ({INICIO[:12]} -> {FIM[:12]})."
          f" Turnos da janela de reinício voltam sem ferramenta. Rode de novo antes de concluir.")

if todas:
    print(f"\n{len(todas)} falha(s):")
    for falha in todas:
        print(f"  - {falha}")
    sys.exit(1)
print("\nNenhuma falha automática.")
