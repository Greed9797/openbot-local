#!/usr/bin/env python3
"""Bateria de tarefas do dia a dia contra o Bot. Mede, não interpreta.

Cada tarefa vira um turno novo. O que sai é objetivo: quanto demorou, quantas ações governadas o
turno gerou (delta do audit), se a resposta veio com o aviso de "nada foi aberto", e o fim do texto.
Julgar se a resposta está certa é trabalho de quem lê a tabela.
"""
import json, subprocess, sys, time, urllib.request

AGENTE = sys.argv[1] if len(sys.argv) > 1 else "risk-analyst"
"""Quantas vezes repetir cada tarefa.

Uma passada não prova nada quando o defeito é intermitente, e o desta base era: o mesmo pedido
chamou a ferramenta uma vez em três, e a passada sortuda foi o que me fez procurar no lugar errado
por meia hora. Repetir é o que separa "funciona" de "funcionou daquela vez".
"""
REPETICOES = int(next((a.split("=")[1] for a in sys.argv if a.startswith("--repete=")), "1"))
def url_do(agente):
    return f"http://127.0.0.1:3001/api/copilotkit/agent/{agente}/run"


URL = url_do(AGENTE)

def qual_container(servico="agent-codex"):
    """O id do container, que muda quando ele é recriado.

    Uma bateria que roda enquanto alguém dá deploy reporta um bloco de falhas que não são do produto:
    os turnos da janela de reinício voltam sem ferramenta nenhuma. Aconteceu comigo, e eu quase tratei
    como regressão.

    O id, e não o texto do status: `Up 2 minutes` e `Up 25 minutes` são o MESMO container, e comparar
    a frase inteira acusava reinício em toda corrida — um alarme que dispara sempre é um alarme que
    se aprende a ignorar, que é pior do que não ter.
    """
    saida = subprocess.run(
        ["docker", "compose", "-f", "/opt/openbot-local/docker-compose.yml", "ps",
         "-q", servico],
        capture_output=True, text=True)
    return saida.stdout.strip()


def audit():
    saida = subprocess.run(
        ["docker", "compose", "-f", "/opt/openbot-local/docker-compose.yml", "exec", "-T",
         "postgres", "psql", "-U", "openbot", "-d", "openbot", "-tAc",
         "select count(*) from audit_events where event_type like 'computer.action%'"],
        capture_output=True, text=True)
    try:
        return int(saida.stdout.strip())
    except ValueError:
        return -1

def turno(ident, texto, historico=None, thread=None, url=None):
    corpo = {
        "threadId": thread or f"bat-{ident}-{int(time.time())}",
        "runId": ident,
        "messages": (historico or []) + [{"id": "u9", "role": "user", "content": texto}],
        "tools": [], "context": [], "state": {}, "forwardedProps": {},
    }
    pedido = urllib.request.Request(
        url or URL, data=json.dumps(corpo).encode(), headers={"content-type": "application/json"})
    partes = []
    try:
        with urllib.request.urlopen(pedido, timeout=300) as resposta:
            for linha in resposta:
                linha = linha.decode("utf8", "replace").strip()
                if not linha.startswith("data: "):
                    continue
                try:
                    evento = json.loads(linha[6:])
                except json.JSONDecodeError:
                    continue
                if evento.get("type") == "TEXT_MESSAGE_CONTENT":
                    partes.append(evento.get("delta", ""))
                if evento.get("type") == "RUN_ERROR":
                    partes.append(f"[RUN_ERROR {evento.get('message', '')}]")
    except Exception as erro:  # noqa: BLE001 - a falha do transporte é o resultado
        partes.append(f"[FALHOU {type(erro).__name__}: {erro}]")
    return "".join(partes)

def julgar(tarefa, acoes, texto):
    """Passa, falha, ou fica em branco quando a tarefa não declarou o que esperar.

    Só o que dá para decidir por máquina entra aqui: quantas ações governadas o turno gerou, e se o
    texto contém (ou não contém) algo. Se a resposta está CERTA continua sendo julgamento de quem lê
    — uma bateria que se declara verde sozinha é a mesma armadilha da tela que dizia "Configurado".
    """
    espera = tarefa.get("espera")
    if not espera:
        return "", ""

    if "acoes" in espera:
        regra = espera["acoes"]
        ok = acoes > 0 if regra == ">0" else acoes == int(regra)
        if not ok:
            return "FALHA", f"esperava ações {regra}, houve {acoes}"

    for trecho in espera.get("contem", []):
        if trecho.lower() not in texto.lower():
            return "FALHA", f"faltou {trecho!r} na resposta"

    for trecho in espera.get("nao_contem", []):
        if trecho.lower() in texto.lower():
            return "FALHA", f"apareceu {trecho!r} na resposta"

    return "passa", ""


if __name__ == "__main__":
    ARQUIVO = next((a for a in sys.argv[2:] if not a.startswith("--")), None)
    TAREFAS = json.load(open(ARQUIVO)) if ARQUIVO else []

    ESTADO_INICIAL = qual_container()
    print(f"agente={AGENTE}  tarefas={len(TAREFAS)}  repetições={REPETICOES}")
    print(f"container do serviço: {ESTADO_INICIAL[:12] or '(não encontrado)'}\n")
    print(f"{'tarefa':<16}{'seg':>5}{'ações':>7}{'aviso':>7}{'':>8}  resposta (fim)")
    falhas = []
    for tarefa in TAREFAS:
        for repeticao in range(1, REPETICOES + 1):
            rotulo = tarefa["id"] if REPETICOES == 1 else f"{tarefa['id']}#{repeticao}"
            antes = audit()
            inicio = time.time()
            texto = turno(rotulo, tarefa["pedido"], tarefa.get("historico"))
            duracao = round(time.time() - inicio)
            acoes = audit() - antes
            aviso = "SIM" if "Nenhuma página foi aberta" in texto else "-"
            veredito, motivo = julgar(tarefa, acoes, texto)
            if veredito == "FALHA":
                falhas.append(f"{rotulo}: {motivo}")
            fim = texto.replace("\n", " ")[-100:]
            print(f"{rotulo:<16}{duracao:>5}{acoes:>7}{aviso:>7}{veredito:>8}  {fim}")

    ESTADO_FINAL = qual_container()
    if ESTADO_INICIAL and ESTADO_FINAL and ESTADO_INICIAL != ESTADO_FINAL:
        # Antes de qualquer conclusão sobre as falhas, porque provavelmente elas não são do produto.
        print(
            f"\nATENÇÃO: o serviço foi recriado durante a bateria."
            f"\n  container no início: {ESTADO_INICIAL[:12]}"
            f"\n  container no fim:    {ESTADO_FINAL[:12]}"
            f"\n  Os turnos que caíram na janela de reinício voltam sem ferramenta nenhuma."
            f" Rode de novo sem deploy no meio antes de tratar qualquer falha como regressão."
        )

    if falhas:
        print(f"\n{len(falhas)} falha(s) automática(s):")
        for falha in falhas:
            print(f"  - {falha}")
        sys.exit(1)
    print("\nNenhuma falha automática. O conteúdo das respostas ainda precisa de olho humano.")
