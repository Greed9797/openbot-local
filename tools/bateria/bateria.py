#!/usr/bin/env python3
"""Bateria de tarefas do dia a dia contra o Bot. Mede, não interpreta.

Cada tarefa vira um turno novo. O que sai é objetivo: quanto demorou, quantas ações governadas o
turno gerou (delta do audit), se a resposta veio com o aviso de "nada foi aberto", e o fim do texto.
Julgar se a resposta está certa é trabalho de quem lê a tabela.
"""
import json, subprocess, sys, time, urllib.request

AGENTE = sys.argv[1] if len(sys.argv) > 1 else "risk-analyst"
URL = f"http://127.0.0.1:3001/api/copilotkit/agent/{AGENTE}/run"

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

def turno(ident, texto, historico=None):
    corpo = {
        "threadId": f"bat-{ident}-{int(time.time())}",
        "runId": ident,
        "messages": (historico or []) + [{"id": "u9", "role": "user", "content": texto}],
        "tools": [], "context": [], "state": {}, "forwardedProps": {},
    }
    pedido = urllib.request.Request(
        URL, data=json.dumps(corpo).encode(), headers={"content-type": "application/json"})
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

TAREFAS = json.load(open(sys.argv[2])) if len(sys.argv) > 2 else []

print(f"agente={AGENTE}  tarefas={len(TAREFAS)}\n")
print(f"{'tarefa':<16}{'seg':>5}{'ações':>7}{'aviso':>7}  resposta (fim)")
for tarefa in TAREFAS:
    antes = audit()
    inicio = time.time()
    texto = turno(tarefa["id"], tarefa["pedido"], tarefa.get("historico"))
    duracao = round(time.time() - inicio)
    acoes = audit() - antes
    aviso = "SIM" if "Nenhuma página foi aberta" in texto else "-"
    fim = texto.replace("\n", " ")[-110:]
    print(f"{tarefa['id']:<16}{duracao:>5}{acoes:>7}{aviso:>7}  {fim}")
