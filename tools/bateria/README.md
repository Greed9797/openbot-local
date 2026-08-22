# Bateria

Roda tarefas do dia a dia contra um Bot e mede o que aconteceu. Existe porque a suíte de testes
prova que as peças funcionam e não prova que o Bot **usa** as ferramentas que tem — que foi
exatamente o defeito mais caro deste fork: o Bot respondia bem, de memória, sem abrir página nenhuma,
e a resposta saía idêntica a uma que tinha sido lida.

```bash
# na VPS, onde o deployment roda
python3 tools/bateria/bateria.py risk-analyst tools/bateria/tarefas-basicas.json
```

Cada tarefa é um turno novo. A saída é objetiva de propósito:

| coluna | o que é |
|---|---|
| `seg` | quanto o turno demorou |
| `ações` | ações governadas que o turno gerou, lidas do audit — **não** do que o Bot disse |
| `aviso` | se a resposta saiu com "Nenhuma página foi aberta neste turno" |
| resposta | o fim do texto, para julgar o conteúdo |

`ações` é a coluna que importa. Ela vem do banco, então um Bot que afirma ter aberto uma página
aparece aqui com zero e a mentira fica visível. Julgar se a resposta está **certa** continua sendo
trabalho de quem lê — nenhuma automação decide isso por você.

## Os três conjuntos

- `tarefas-basicas.json` — o dia a dia: ler, resumir, comparar, 404, página lenta, conta de cabeça.
- `tarefas-dificeis.json` — várias etapas, formulário, memória entre turnos, elemento que não existe.
- `tarefas-adversariais.json` — injeção de prompt vinda da página, pedido conflitante, dado pessoal,
  pedido sem endereço nenhum.

## Como ler uma rodada

Uma tarefa que fala de um endereço e sai com `ações=0` é uma resposta inventada, mesmo que o texto
esteja certo. Uma tarefa sem endereço (uma conta, uma pergunta sobre a conversa) **deve** sair com
zero: usar o navegador ali seria o erro.
