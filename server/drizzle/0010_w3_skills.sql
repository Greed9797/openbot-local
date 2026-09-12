INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('research-prospect', 'research-prospect', NULL, 'Research Prospect', 'Pesquisar contas e contatos aderentes ao ICP da W3 e preparar abordagem fundamentada. Usar para prospecção, preparação de reunião, enriquecimento de lead ou pesquisa de uma conta específica.', '# research-prospect

## Entradas

- ICP ou critérios de conta
- Região e segmento
- Oferta relevante
- Fontes permitidas
- CRM/lista de exclusão

## Processo

1. Validar ICP e critérios de exclusão.
2. Pesquisar sinais recentes em fontes públicas e registros autorizados.
3. Deduplicar por domínio, empresa e contato; preservar ownership existente.
4. Classificar aderência e timing com evidência.
5. Preparar ângulo de contato e rascunho sem enviar.

## Saída esperada

Lista priorizada ou brief de conta com sinais, fontes datadas, lacunas, hipótese de dor e rascunho de abordagem.

## Critérios de qualidade

- Nenhuma empresa entra sem evidência de fit.
- Fato, inferência e dado fornecido pelo usuário estão separados.
- Lead já tocado é sinalizado, não sobrescrito.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper quando não houver ICP suficiente, fonte verificável ou permissão para consultar dados privados.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('qualify-sales-opportunity', 'qualify-sales-opportunity', NULL, 'Qualify Sales Opportunity', 'Qualificar oportunidades comerciais da W3 com critérios consistentes e evidência de conversas. Usar em diagnóstico comercial, mudança de estágio, revisão de proposta ou decisão de avançar, nutrir ou encerrar.', '# qualify-sales-opportunity

## Entradas

- Critérios de qualificação
- Transcrição/notas
- Registro da oportunidade
- Estágio atual
- Próximo passo alegado

## Processo

1. Mapear cada critério para citação, timestamp ou dado verificável.
2. Marcar critério ausente como missing; nunca completar por suposição.
3. Avaliar problema, autoridade, urgência, capacidade de investimento e próximo compromisso.
4. Emitir veredito advance, nurture, close ou insufficient_data.
5. Preparar diff de CRM e perguntas de descoberta para aprovação.

## Saída esperada

Scorecard evidenciado, lacunas, veredito, riscos, perguntas e diff proposto de CRM.

## Critérios de qualidade

- Cada critério contém evidência ou missing.
- O veredito é reproduzível a partir dos critérios.
- Nenhum writeback ocorre sem aprovação humana específica.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se a evidência principal não estiver disponível ou se os critérios de estágio não tiverem sido definidos pela W3.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('close-customer-loop', 'close-customer-loop', NULL, 'Close Customer Loop', 'Detectar compromissos e informações sem destino concluído e preparar o fechamento do loop. Usar após reuniões, em follow-ups, pendências de cliente, CRM e gestão de tarefas.', '# close-customer-loop

## Entradas

- Transcrições, emails ou notas
- CRM e tarefas
- Janela temporal
- Owners
- Canais permitidos

## Processo

1. Extrair apenas compromissos explícitos e pedidos verificáveis.
2. Deduplicar por conta, compromisso, owner e prazo.
3. Verificar se já existe entrega, resposta ou tarefa concluída.
4. Definir owner, próximo passo e destino correto.
5. Preparar mensagem, tarefa ou atualização e aguardar aprovação quando houver ação externa.

## Saída esperada

Fila de loops abertos com evidência, owner, prazo, artefato preparado e recibo de fechamento.

## Critérios de qualidade

- Não inventar compromissos implícitos.
- Cada loop possui origem e condição clara de fechamento.
- Mensagens preservam fatos e incertezas.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper quando o compromisso estiver ambíguo, sem owner legítimo ou depender de decisão comercial.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('monitor-sales-pipeline', 'monitor-sales-pipeline', NULL, 'Monitor Sales Pipeline', 'Monitorar saúde do pipeline da W3 e preparar correções. Usar em revisão de funil, previsão, leads parados, higiene de CRM e identificação de risco comercial.', '# monitor-sales-pipeline

## Entradas

- Snapshot do CRM
- Histórico de atividades
- Regras de estágio
- Metas e período
- Owners

## Processo

1. Comparar o snapshot atual com o anterior.
2. Detectar ausência de próxima ação, aging, estágio sem evidência e forecast inconsistente.
3. Separar risco de dados incompletos de risco real do negócio.
4. Priorizar exceções por receita, probabilidade e urgência.
5. Preparar mudanças de CRM e cobranças de owner sem executá-las.

## Saída esperada

Pulse do pipeline com mudanças, riscos, oportunidades paradas, lacunas de CRM e ações propostas.

## Critérios de qualidade

- Forecast informa período e critério.
- Nenhuma atividade é inferida sem registro.
- Execuções sem mudança material produzem quiet result.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se o snapshot não tiver data, owner ou estágio comparável.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('prepare-shopify-proposal', 'prepare-shopify-proposal', NULL, 'Prepare Shopify Proposal', 'Preparar proposta Shopify da W3 a partir do diagnóstico, escopo e restrições comerciais. Usar após qualificação suficiente e antes de apresentar ou enviar uma proposta ao cliente.', '# prepare-shopify-proposal

## Entradas

- Diagnóstico validado
- Objetivos e métricas
- Escopo e exclusões
- Prazo/capacidade
- Preço, custos e premissas aprovados

## Processo

1. Confirmar problema, resultado e critérios de sucesso.
2. Mapear escopo às fases Diagnóstico, Direção, Construção e Virada.
3. Registrar dependências do cliente, exclusões e riscos.
4. Calcular esforço, custo e margem com premissas explícitas.
5. Gerar proposta e checklist de revisão; nunca enviar.

## Saída esperada

Proposta em draft com diagnóstico, direção, entregáveis, cronograma, responsabilidades, investimento, premissas, riscos e próximos passos.

## Critérios de qualidade

- Nenhum entregável é prometido sem capacidade e owner.
- Preço e margem têm base rastreável.
- Exclusões e dependências estão visíveis.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se preço, escopo, prazo ou regra de margem dependerem de decisão comercial não aprovada.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('manage-shopify-project', 'manage-shopify-project', NULL, 'Manage Shopify Project', 'Coordenar projetos Shopify da W3 sem executar trabalho especialista. Usar para planejar fases, distribuir tarefas, acompanhar dependências, bloquear riscos e preparar handoffs.', '# manage-shopify-project

## Entradas

- Contrato e escopo
- Cronograma
- Equipe e capacidade
- Backlog
- Aprovações do cliente

## Processo

1. Criar uma fonte de verdade por projeto.
2. Decompor o escopo em marcos e tarefas com owner e critério de aceite.
3. Encaminhar trabalho a especialistas apropriados.
4. Monitorar dependências, bloqueios e mudanças de escopo.
5. Preparar status, decisões e handoff entre fases.

## Saída esperada

Plano de projeto, backlog, status executivo, registro de decisões, bloqueios e próximos handoffs.

## Critérios de qualidade

- Cada tarefa tem owner e done criteria.
- Mudança de escopo vira decisão registrada.
- O coordenador não mascara execução especialista.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper em conflito de escopo, ausência de owner ou decisão que altere preço/prazo.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('audit-shopify-store', 'audit-shopify-store', NULL, 'Audit Shopify Store', 'Auditar loja Shopify em UX, conversão, conteúdo, SEO, acessibilidade, performance e configuração. Usar em diagnóstico inicial, revisão pré-projeto ou auditoria periódica.', '# audit-shopify-store

## Entradas

- URL e ambiente
- Objetivo comercial
- Acessos permitidos
- Dispositivos prioritários
- Baseline disponível

## Processo

1. Confirmar escopo e não executar alterações.
2. Coletar evidências reproduzíveis por página e dispositivo.
3. Avaliar UX/CRO, conteúdo, SEO/schema, acessibilidade e performance sem inventar métricas.
4. Classificar achados P0/P1/P2 por impacto e esforço.
5. Propor correções, dependências e critério de verificação.

## Saída esperada

Relatório priorizado com evidência, impacto, recomendação, owner sugerido e teste de aceite.

## Critérios de qualidade

- Todo achado possui URL ou screenshot.
- Métricas informam ferramenta e timestamp.
- Preferências estéticas não são tratadas como defeitos.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se o alvo não estiver autorizado, protegido por autenticação não fornecida ou exigir contornar controles.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('validate-shopify-launch', 'validate-shopify-launch', NULL, 'Validate Shopify Launch', 'Validar lançamento de loja Shopify com gates técnicos, comerciais e operacionais. Usar antes de publicar, trocar domínio, liberar checkout ou concluir a fase Virada.', '# validate-shopify-launch

## Entradas

- Release candidate
- Escopo contratado
- Critérios de aceite
- Configurações de pagamento/frete/pixels
- Plano de rollback

## Processo

1. Executar checklist funcional e visual em breakpoints prioritários.
2. Validar catálogo, preços, estoque, frete, pagamento e mensagens críticas com dados seguros.
3. Verificar SEO técnico, analytics/pixels, performance e acessibilidade.
4. Separar blockers, riscos aceitos e follow-ups.
5. Produzir go/no-go; publicação permanece sob aprovação humana.

## Saída esperada

Matriz de validação, evidências, blockers, riscos, rollback e recomendação go/no-go.

## Critérios de qualidade

- Cada gate possui resultado e evidência.
- Falha crítica implica no-go.
- Nenhum teste cria compra real ou altera produção sem aprovação.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper diante de risco de cobrança real, dados de cliente, alteração de produção ou ausência de rollback.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('review-design', 'review-design', NULL, 'Review Design', 'Revisar design de sites e lojas com critérios acionáveis. Usar para screenshots, Figma, layouts, componentes, identidade aplicada, responsividade e acessibilidade.', '# review-design

## Entradas

- Screenshot ou Figma autorizado
- Objetivo da tela
- Público e contexto
- Brand guidelines
- Breakpoint

## Processo

1. Confirmar objetivo e estado avaliado.
2. Avaliar hierarquia, tipografia, cor, espaçamento, conteúdo, conversão, consistência e acessibilidade.
3. Separar defeitos, riscos e preferências.
4. Priorizar correções por impacto e esforço.
5. Descrever correção e critério visual/funcional de aceite.

## Saída esperada

Crítica priorizada com evidência visual, impacto, correção concreta e critério de aceite.

## Critérios de qualidade

- Feedback é específico e localizável.
- Não editar arquivos sem solicitação explícita.
- Acessibilidade e responsividade são verificadas, não presumidas.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se faltar o artefato, o estado correto ou o objetivo da tela.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('plan-seo-aeo-content', 'plan-seo-aeo-content', NULL, 'Plan SEO AEO Content', 'Planejar conteúdo e melhorias SEO/AEO para a W3 ou clientes. Usar para pesquisa de temas, mapa de perguntas, brief de página, revisão de queda e relatório de visibilidade.', '# plan-seo-aeo-content

## Entradas

- Site e oferta
- Público
- Temas/keywords
- Concorrentes
- Dados de Search Console ou fontes públicas

## Processo

1. Mapear perguntas e intenção do público.
2. Combinar demanda, autoridade possível e valor comercial.
3. Identificar lacunas de citação para buscadores e assistentes de IA.
4. Priorizar ideias no board e gerar brief de escritor, não artigo final.
5. Definir medição e próxima revisão.

## Saída esperada

Board priorizado, mapa de perguntas, brief de conteúdo e plano de mensuração.

## Critérios de qualidade

- Cada claim externo tem fonte e data.
- Brief distingue evidência disponível de pesquisa pendente.
- Não prometer ranking ou tráfego.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper quando site, oferta ou público não forem conhecidos o bastante para evitar pauta genérica.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('monitor-competitors', 'monitor-competitors', NULL, 'Monitor Competitors', 'Monitorar mudanças materiais de concorrentes da W3 ou de clientes. Usar para pricing, posicionamento, produto, portfólio, contratação e sinais de mercado.', '# monitor-competitors

## Entradas

- Watchlist aprovada
- URLs e aspectos monitorados
- Snapshot anterior
- Materiality threshold
- Destino privado

## Processo

1. Capturar páginas públicas sem contornar barreiras.
2. Comparar com o snapshot anterior.
3. Eliminar mudanças cosméticas e ruído.
4. Classificar impacto provável e confiança.
5. Gerar brief apenas quando a mudança superar o threshold.

## Saída esperada

Diff datado com evidências, interpretação marcada, impacto potencial e ação recomendada.

## Critérios de qualidade

- Todo fato cita URL e timestamp.
- A inferência não é apresentada como intenção do concorrente.
- Sem mudança material, emitir quiet result.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper em paywall, autenticação, bloqueio anti-bot ou ausência de baseline comparável.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('analyze-project-margin', 'analyze-project-margin', NULL, 'Analyze Project Margin', 'Analisar margem de projetos e serviços da W3 com dados rastreáveis. Usar em precificação, revisão de rentabilidade, controle de escopo, capacidade e análise mensal.', '# analyze-project-margin

## Entradas

- Receita contratada
- Horas/custos
- Terceiros e ferramentas
- Mudanças de escopo
- Método contábil e período

## Processo

1. Validar período, moeda e fonte de cada valor.
2. Separar custo direto, alocação e estimativa.
3. Calcular margem bruta e cenários com fórmulas explícitas.
4. Identificar variação por escopo, retrabalho, atraso e capacidade.
5. Preparar ações e decisões financeiras sem alterar preço ou orçamento.

## Saída esperada

Painel de margem por projeto/tipo, drivers, cenários, riscos e decisões recomendadas.

## Critérios de qualidade

- Nenhum valor é inventado.
- Estimativas estão marcadas e acompanhadas de sensibilidade.
- A fórmula é reproduzível.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper quando dados de custo/receita forem incompatíveis ou a regra de reconhecimento não estiver definida.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('research-product-opportunity', 'research-product-opportunity', NULL, 'Research Product Opportunity', 'Investigar oportunidades de produto e SaaS para a W3. Usar para MCRM, Influencer HUB/ROIs, Sports VTON, Meta Ads ou novas ideias antes de investir em construção.', '# research-product-opportunity

## Entradas

- Problema e usuário
- Hipótese de valor
- Mercado/alternativas
- Restrições
- Sinais existentes

## Processo

1. Escrever o que precisa ser verdade para a ideia funcionar.
2. Buscar evidência a favor e contra em fontes recentes.
3. Mapear alternativas, switching costs e distribuição.
4. Identificar a premissa mais provável de invalidar a ideia.
5. Propor o menor teste reversível com métrica e stop condition.

## Saída esperada

Opportunity brief com tese, evidências, contradições, riscos, premissa fatal, teste e decisão recomendada.

## Critérios de qualidade

- A pesquisa procura desconfirmar a tese.
- Tamanho de mercado informa método e incerteza.
- O MVP testa risco, não quantidade de features.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper quando a decisão exigir orçamento, acesso sensível ou uma regra de negócio ainda não definida.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;--> statement-breakpoint
INSERT INTO "skills" ("id", "slug", "owner_user_id", "title", "summary", "instructions", "origin", "installed_by")
VALUES ('run-executive-review', 'run-executive-review', NULL, 'Run Executive Review', 'Conduzir revisão executiva da W3 com prioridades, bloqueios, decisões e responsáveis. Usar em reviews diários ou semanais, pedidos de priorização e preparação de pauta para direção.', '# run-executive-review

## Entradas

- Período e objetivos
- Pipeline comercial
- Projetos e bloqueios
- Margem/capacidade
- Decisões e aprovações pendentes

## Processo

1. Consolidar somente dados do período solicitado.
2. Separar sinais, riscos e decisões; eliminar atualizações sem consequência.
3. Ordenar por impacto, urgência, reversibilidade e dependências.
4. Propor no máximo cinco prioridades com owner e próximo marco.
5. Preparar as decisões para o humano; não executá-las.

## Saída esperada

Brief executivo: placar, mudanças relevantes, riscos, decisões requeridas, cinco prioridades e responsáveis.

## Critérios de qualidade

- Cada prioridade possui resultado esperado, owner e prazo.
- Todo número informa fonte e período.
- Itens sem novidade ficam em quiet mode.

## Evidência

- Rotular fatos como observed, inferências como inference e propostas como recommendation.
- Citar URL, documento ou registro de origem e data para afirmações externas.
- Diante de conflito entre fontes, mostrar o conflito e não consolidar silenciosamente.

## Aprovação humana

Produzir `waiting_human_approval` antes de:

- Enviar email, WhatsApp, DM ou proposta.
- Alterar CRM, orçamento, anúncio, produção, permissões ou dados persistentes.
- Publicar loja, conteúdo ou campanha; comprar, contratar, demitir, assinar ou excluir.

Incluir ação pretendida, motivo, impacto, evidência e rollback quando aplicável.

## Quando interromper

Interromper se faltarem os sistemas de origem ou se duas prioridades críticas exigirem uma escolha de negócio não documentada.', 'catalogue', 'marketplace-seed')
ON CONFLICT (slug) DO NOTHING;;
