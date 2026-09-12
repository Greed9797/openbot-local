# Estado do projeto

## Feature ativa

`runtime-quality` — implementação integral P0–P2 autorizada, com delegação de partes independentes. Validação independente final ainda pendente. Base: `824893b`.

## Decisões

- **RQ-AD-01 — Isolamento local de validação.** PostgreSQL descartável em `127.0.0.1:55439`; Chromium, Lightpanda e página de teste separados dos serviços operacionais. Nenhum push, deploy, chamada paga ou alteração do banco operacional.
- **RQ-AD-02 — Autoridade e efeitos.** Identidade da auditoria vem da declaração assinada; humanos não recebem run inventado. Conclusão exige condição observada pelo host quando houver efeito externo possível. Artefato exige propriedade do run, retenção válida e bytes existentes, não apenas linha de banco.
- **RQ-AD-03 — Memória conservadora.** CLI: envelope de 48.000 caracteres e fila FIFO por processo. Runtime: instruções humanas inteiras, inclusive mais de cinco mensagens e mais de dez pendências; excedente de 48.000 caracteres interrompe explicitamente antes do modelo. Não resumir ou esquecer restrições silenciosamente.
- **RQ-AD-04 — Roteamento voluntário.** Política opcional registra `routed`; não altera Bots ou padrão. Um fallback autorizado, com tentativas efetivas persistidas. O loop não adiciona retries ao roteador. Modelo explicitamente fixado não autoriza substituição.
- **RQ-AD-05 — Paralelismo e integração.** Autorização do usuário substituiu dependências de pesquisa artificiais para T1/T4/T8; arquivos compartilhados foram integrados pelo executor principal. Subagentes não forneceram prova de aceitação: imports, argumentos e limites perdidos foram corrigidos pelos gates do principal.
- **RQ-AD-06 — Origem da escolha preservada.** Revisão independente encontrou pin explícito perdido quando igual ao padrão. `createRun` agora grava `modelPinned` a partir da tarefa/Bot, sobrescrevendo metadata arbitrário; executor conserva a escolha após retomada. Política com modos incompatíveis recusa construção, não desativa fallback silenciosamente.

## Evidência já observada

- `5ae73f1`: contexto CLI, gate 20 testes sem falha.
- `fa896e9`: fila CLI, gate 21 testes sem falha com executável local e arquivos reais.
- Gate amplo anterior: typecheck/build passaram; 1.281 testes passaram, zero falhas. Lint bloqueou por optional chaining inseguro de um teste; corrigido.
- Formulário real: dois campos preenchidos via gateway com auditoria e sem submit; estrutura alterada e takeover interrompem segundo campo, com parcial correto.
- Lightpanda real: leu página local sem sessão através de `fetch_page`, gateway e auditoria.
- Endurecimento posterior da memória encontrou lote de dez mensagens omitindo pendências; corrigido para ler estado canônico completo antes de aplicar limite explícito. Gates definitivos e relatório do Verifier registrarão resultado final, sem reaproveitar contagens antigas.

## Próximo passo

Concluir gates após correção do lote de mensagens, registrar tarefas verificadas, realizar revisão independente e sensor em cópia isolada, executar `validate_state.py`. Não declarar feature concluída antes do relatório PASS.
