# Estado do projeto

## Feature ativa

`runtime-quality` — implementação integral P0–P2 verificada localmente. Parecer independente PASS e sensor 7/7 contra `d29e339`. Base: `824893b`. Relatório: `.specs/features/runtime-quality/validation.md`.

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
- Gates finais em `d29e339`: typecheck/build/lint exit 0; 1.286 pass, 5 skips ambientais, zero falhas. Lint: 24 warnings e 1 informação; build: aviso de chunk acima de 500 kB.
- Formulário real: dois campos preenchidos via gateway com auditoria e sem submit; estrutura alterada e takeover interrompem segundo campo, com parcial correto.
- Lightpanda real: leu página local sem sessão através de `fetch_page`, gateway e auditoria.
- Cobertura medida: 1.394/1.637 = 85,16% das linhas executáveis novas instrumentadas; quatro arquivos não instrumentados, explicitados no relatório.
- Revisão independente encontrou F1/F2 de roteamento; correções verificadas em `d29e339`. Sensor independente final detectou sete mutações; primeira seleção inadequada de teste do sensor foi corrigida e preservada como evidência.
- Limpeza comprovada: banco e imagem Lightpanda descartáveis encerrados/removidos; snapshots, scripts e logs temporários removidos. Containers operacionais preservados. Evidência durável em `.specs/features/runtime-quality/evidence/`.

## Entrega local

Nenhum push, deploy ou chamada paga autorizado/executado. T3–T12 ficaram num único commit de integração (`3a94b94`), desvio de granularidade documentado. Relatório e gates estruturais finais encerram a entrega local; homologação externa e alegações de economia permanecem fora do escopo.
