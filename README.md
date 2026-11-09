# EduFlow API

Backend da plataforma EduFlow — gestão de múltiplos colégios.
NestJS + TypeScript, **Clean Architecture** e **DDD**, organizado como **monorepo de serviços isolados**:
o código vive num só repositório, mas cada módulo corre como um serviço próprio, com as suas
credenciais e permissões. Uma invasão num serviço não compromete os outros.

## Arranque rápido

Requer Node ≥ 22.12 (`nvm use`), pnpm e Docker.

```bash
nvm use
pnpm install
pnpm setup      # chaves, senhas, .env de cada serviço, utilizadores PostgreSQL, migrações, permissões
pnpm dev        # compila e arranca os 3 serviços com recarregamento automático
```

| Serviço | Porta | Documentação |
| --- | --- | --- |
| `platform-api` | 4000 | <http://localhost:4000/api/docs> |
| `school-api` | 4001 | <http://localhost:4001/api/docs> |
| `provisioner` | — (não exposto) | — |

Só um serviço: `pnpm dev platform-api`.

## Estrutura

```text
apps/
├── platform-api/   Módulo 1 — equipa EduFlow, colégios clientes (registo, validação, pagamentos), faturação
├── school-api/     Módulo 2 — portal de cada colégio (BD própria por colégio)
└── provisioner/    worker — cria a base de dados de cada colégio ativado
libs/kernel/        partilhado e sem segredos (Result, erros, validação, cifragem…)
prisma/platform/    esquema + migrações da BD da plataforma
prisma/tenant/      esquema + migrações aplicadas a CADA BD de colégio
infra/db/           utilizadores PostgreSQL (roles.sql) e permissões por tabela (grants.sql)
secrets/            chaves e senhas de desenvolvimento (gerado; nunca no git)
```

Regra verificada em cada build (`pnpm lint:boundaries`): **uma app nunca importa código de outra**
e `libs/` nunca importa de `apps/`.

## Modelo de segurança

### Quem tem acesso a quê

| Serviço | Utilizador PostgreSQL | Pode | Não pode |
| --- | --- | --- | --- |
| platform-api | `eduflow_platform_app` | ler/escrever dados da plataforma | alterar a estrutura; ler as credenciais dos colégios; ligar-se às BDs dos colégios |
| school-api | `eduflow_school_directory` + 1 utilizador por colégio | ler o diretório; usar a BD de cada colégio com o utilizador **desse** colégio | ler equipa, faturação ou colégios na BD da plataforma |
| provisioner | `eduflow_provisioner` | criar BDs e utilizadores de colégios | ler dados da plataforma; ler dados dos colégios (o acesso temporário é retirado no fim de cada criação) |
| migrações | `eduflow_migrator` | alterar a estrutura | — (nunca usado pelas apps) |
| cada colégio | `tenant_<id>` | a sua própria BD | ligar-se à BD da plataforma ou de outro colégio |

### Chaves

| Chave | Tipo | Quem tem |
| --- | --- | --- |
| `staff-jwt` | ES256 | platform-api (tokens da equipa) |
| `customer-jwt` | ES256 | platform-api (tokens dos responsáveis dos colégios) |
| `tenant-credentials` | RSA-3072 | **pública** no provisioner (cifra), **privada** só no school-api (decifra) |

Tokens com chave errada, de outro tipo (equipa ↔ responsável) ou assinados com o antigo segredo partilhado são rejeitados.

### Ciclo de criação da BD de um colégio

```text
platform-api: colégio ativado ──(mesma transação)──▶ tenant_provisioning_jobs (outbox)
provisioner:  reserva o pedido → cria utilizador + BD (só o colégio lhe acede) → aplica migrações
              → cifra a senha com a chave PÚBLICA → regista em tenant_databases
school-api:   pedido com "X-Tenant: slug" (produção: subdomínio) → lê o diretório
              → decifra a senha com a chave PRIVADA → liga-se à BD do colégio como o próprio colégio
```

### Antes de produção (fase 3)

- Cluster PostgreSQL separado para as BDs dos colégios; nenhuma porta de BD exposta.
- Chaves e senhas num gestor de segredos (Vault, Docker secrets…) em vez de `secrets/` e `.env`.
- Painel da equipa só acessível por VPN/lista de IPs; contentores sem root e com sistema de ficheiros só de leitura.
- Fase 2: autenticação em dois passos para a equipa e revogação de sessões.

## Base de dados

```bash
pnpm db:migrate                 # nova migração da plataforma (como migrator) + permissões
pnpm db:tenant-sql              # SQL para uma nova migração dos colégios → prisma/tenant/migrations/<nome>/migration.sql
pnpm db:studio
```

As migrações dos colégios são aplicadas pelo provisioner a cada BD de colégio (tabela `_tenant_migrations`).

## Contextos do platform-api

| Contexto | O quê |
| --- | --- |
| `identity` | Equipa interna, autenticação, papéis e permissões, histórico |
| `billing` | Planos, preços (mensal/trimestral/anual/personalizado), descontos, referência, contas bancárias |
| `schools` | Colégios clientes: registo, validação pela equipa, subscrição e ciclo de pagamento |

`schools` fala com `billing` apenas pela porta `PlanCatalog`. Camadas por contexto:
`presentation → application → domain` (o domínio não conhece frameworks).

### Ciclo de adesão de um colégio

```text
registo ─▶ PENDING_REVIEW ─(equipa valida + escolhe pagamento)─▶ AWAITING_PAYMENT
                │                                                   │
             rejeitar                    referência paga (automático) │ comprovativo enviado
                ▼                                                   ▼
            REJECTED          ACTIVE ◀─(equipa confirma com o banco)── PAYMENT_UNDER_REVIEW
```

A confirmação por referência é hoje simulada (`POST /v1/schools/me/payment/simulate-reference`),
pronta para receber o webhook de um gateway real.
