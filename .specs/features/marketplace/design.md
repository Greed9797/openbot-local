# Marketplace — design

Aprovado em chat em 2026-09-12 (página `/marketplace`, 3 abas, seed via migration, fluxos de instalação existentes).

## Objetivo

Superfície de descoberta e instalação no estilo do Grok Marketplace (abas Plugins/Bots + busca + Adicionar), sobre a infra existente do OpenBot. Escopo v1: listar e instalar; nenhuma conexão externa nova, nenhuma rotina ativada.

## Abas e origem dos dados

- **Plugins**: `CATALOGUE` (`server/src/plugins/catalogue.ts`) + estado de `mcp_servers`. Adicionar abre o fluxo atual (`POST /servers`, `/servers/custom`). Integrações do `registry.yaml` W3 entram só como documentação de posture (read-only); nenhuma credencial é criada.
- **Bots**: 8 templates estáticos derivados de `COMPONENT_MAP.md` (Sales, Delivery, Shopify/QA, Design, Marketing, Finance/Ops, Product, Director: nome, descrição, skills e memórias sugeridas). Adicionar cria perfil via `store.create` (rota de agents existente), com memória inicial a partir de `memories/defaults.yaml`.
- **Skills W3**: 14 skills do pacote (`skills/*/SKILL.md`, validadas em `dist/*.skill`). Migration idempotente insere como deployment-owned na tabela `skills` (cópias versionadas em `server/data/w3-skills/`). Adicionar clona para o usuário (`POST /skills`) ou concede ao Bot (`POST /grants` `{kind:"skill", ref, agentId}`).

## Rota e UI

- Rota `/marketplace` (TanStack Router) + item na sidebar abaixo de Agentes; reutiliza padrões de `/skills` e `/agents` (cards, busca, chips de categoria).
- Busca filtra por nome/descrição; chips por categoria (Vendas, Marketing, Operação… derivadas do COMPONENT_MAP).
- Estado Adicionar/Adicionado lido de `mcp_servers`, perfis e `grants` existentes. Sem mocks: botão sem backend vira ausência, não clique morto.

## Fora da v1

Rotinas (`active: false`, sem scheduler), conexão de integrações, execução/pagamento, avaliações e modal global.

## Verificação

- Migration idempotente (re-run sem duplicar `skills_slug_key`).
- Render das 3 abas com dados reais; busca filtra.
- Instalar plugin/bot/skill chama os endpoints existentes e reflete estado.
- `typecheck`, `lint`, testes das rotas novas; sem segredo em log.
