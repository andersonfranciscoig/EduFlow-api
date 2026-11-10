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
pnpm run setup  # chaves, senhas, .env de cada serviço, utilizadores PostgreSQL, migrações, permissões
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
| provisioner | `eduflow_provisioner` | ler a fila e o diretório; abrir os URLs dos servidores; escrever a saúde dos servidores | ler dados da plataforma (equipa, colégios, reservas, nomes dos servidores); mudar a capacidade; ler dados dos colégios (o acesso temporário é retirado no fim de cada criação) |
| migrações | `eduflow_migrator` | alterar a estrutura | — (nunca usado pelas apps) |
| cada colégio | `tenant_<id>` | a sua própria BD | ligar-se à BD da plataforma ou de outro colégio |

### Chaves

| Chave | Tipo | Quem tem |
| --- | --- | --- |
| `staff-jwt` | ES256 | platform-api (tokens da equipa) |
| `customer-jwt` | ES256 | platform-api (tokens dos responsáveis dos colégios) |
| `mfa` | AES-256 | platform-api (cifra os segredos da 2FA guardados na BD) |
| `server-credentials` | RSA-3072 + AES-256-GCM | **pública** no platform-api (sela os URLs dos servidores), **privada** só no provisioner |
| `tenant-credentials` | RSA-3072 | **pública** no provisioner (cifra), **privada** só no school-api (decifra) |
| `school-jwt` | ES256 | school-api (tokens do portal dos colégios) |
| `school-mfa` | AES-256 | school-api (segredos da 2FA guardados nas BDs dos colégios) |
| `email-api` | chave Brevo | school-api (códigos por email). Opcional em dev: sem ela os emails vão para a consola |

Tokens com chave errada, de outro tipo (equipa ↔ responsável ↔ portal) ou assinados com o antigo segredo partilhado são rejeitados.

### Portal do colégio (Módulo 2 · school-api + EduFlow-portal)

- **Contas vivem na BD do colégio** (`school_users`), nunca na plataforma.
- **Primeiro acesso:** ao criar a BD, o provisioner cria a conta do responsável (DIRETOR) **por ativar e sem senha**.
  Ele ativa-a no portal: identifica-se → recebe um código de 6 dígitos por email → define a senha → configura a 2FA.
- **Login em 3 passos** (igual à equipa): identificar → senha → código da app. 2FA obrigatória.
- **Recuperar a senha:** código por email → nova senha → **continua a pedir a 2FA** (quem só controla o email não entra)
  e todas as sessões anteriores são terminadas.
- **Códigos por email:** só o hash é guardado; 15 min; 5 tentativas; 1 por minuto; só vale o mais recente.
- **Um token nunca serve noutro colégio:** leva `tid` (colégio) e `sid` (sessão); o `SchoolAuthGuard` compara o `tid`
  com o colégio do pedido e confirma a sessão na BD do colégio a cada pedido.
- **Que colégio é?** `X-Tenant` (enviado pelo servidor do portal) ou o subdomínio de `TENANT_BASE_DOMAIN`; se vierem os dois
  e forem diferentes, o pedido é recusado. Escolher o colégio não dá acesso a nada sem um token desse colégio.
- **Ligações às BDs dos colégios** com o TLS registado para o servidor; trocam-se sozinhas quando o provisioner roda a senha.

### Ciclo de criação da BD de um colégio

```text
platform-api: colégio ativado ──(mesma transação)──▶ tenant_provisioning_jobs (outbox)
provisioner:  reserva o pedido → cria utilizador + BD (só o colégio lhe acede) → aplica migrações
              → cifra a senha com a chave PÚBLICA → regista em tenant_databases
school-api:   pedido com "X-Tenant: slug" (produção: subdomínio) → lê o diretório
              → decifra a senha com a chave PRIVADA → liga-se à BD do colégio como o próprio colégio
```

### Contas da equipa (fase 2)

- **Verificação em dois passos obrigatória para toda a equipa** (TOTP, compatível com Google/Microsoft
  Authenticator, Authy…). Quem ainda não a tem é obrigado a configurá-la no próximo login.
  Segredos cifrados na BD com AES-256-GCM (`secrets/mfa.key`, só no platform-api); proteção contra reutilização
  do mesmo código; 10 códigos de recuperação de uso único (guardados como hash). Códigos errados contam para o bloqueio.
- **Login em 3 passos**: identificar → senha (devolve só um "bilhete" de 10 min, que não dá acesso) → código.
  Só depois da 2FA é criada a sessão.
- **Sessões revogáveis** (`staff_sessions`): o token transporta o id da sessão e cada pedido confirma que ela
  está ativa. "Sair", "terminar as outras sessões", desativar um membro ou repor-lhe a 2FA invalidam os tokens de imediato.
- **Ações sensíveis** (`@RequireRecentMfa()`: mudar papel/permissões, desativar, repor 2FA, terminar sessões de outros,
  novos códigos de recuperação) exigem 2FA verificada há menos de 10 minutos; caso contrário a API responde
  `403 MFA_STEP_UP_REQUIRED` e o painel pede o código e repete a ação.

### Servidores de bases de dados (fase 3)

A equipa regista no painel (**Bases de dados**) onde vivem os colégios:

- **Servidor partilhado:** um PostgreSQL onde o provisioner cria uma BD e um utilizador por colégio.
  O utilizador registado precisa de `CREATEDB` e `CREATEROLE` (não deve ser superutilizador).
- **BD dedicada:** uma base já criada e vazia, só para um colégio.

Regras de segurança:

- **URLs write-only:** são selados com a chave pública do provisioner e guardados em `database_server_secrets`.
  O `eduflow_platform_app` tem `INSERT`/`UPDATE` nessa tabela mas **não** `SELECT`. A API nunca devolve o URL.
- **Validação do URL:** só PostgreSQL ≥ 14. Fora de localhost é obrigatório TLS (`sslmode=require|verify-ca|verify-full`).
  Só se aceitam os parâmetros `sslmode`, `connect_timeout` e `application_name`.
- **Testes de ligação feitos pelo provisioner** (o único que abre o URL):
  - mede o tempo de ligação e a latência (mediana de 3 pedidos);
  - verifica a versão e o TLS;
  - verifica as permissões necessárias e se a BD dedicada está vazia.
  - Corre ao registar, a pedido da equipa e automaticamente a cada 5 minutos, com 7 dias de histórico.
  - Um servidor que falha o teste deixa de receber colégios.
- **Reserva → atribuição:** na validação do colégio, a equipa escolhe um servidor (automático, um específico ou
  "decidir depois") e fica uma **reserva de 7 dias**. A atribuição acontece na **mesma transação** que confirma o
  pagamento, e o pedido de criação da BD já leva o servidor. Uma reserva expirada só é honrada se ainda houver espaço;
  caso contrário, a escolha é automática. Sem nenhum servidor, o colégio fica "à espera de servidor" e a equipa
  atribui-o depois.
- **Capacidade garantida pela BD:** bloqueio da linha do servidor (`FOR UPDATE`) e um índice único parcial impedem
  ultrapassar a capacidade ou ter duas reservas ativas para o mesmo colégio.
- **Ações sensíveis com 2FA recente:** registar, substituir o URL, mudar definições, desativar, apagar, libertar
  reservas e atribuir servidores.
- **Credenciais substituídas:** com colégios num servidor, só se pode mudar o utilizador e a senha. Numa BD dedicada,
  o provisioner atualiza o diretório do colégio.
- Desenvolvimento: `pnpm run setup` cria o utilizador `eduflow_tenant_admin` e escreve o URL de um "servidor
  partilhado" local em `secrets/dev-tenant-server.url`, pronto a registar no painel. Com `LOCAL_FALLBACK_SERVER=true`
  (proibido em produção), os colégios sem servidor usam o cluster local.

### Equipa só por convite

- O painel da equipa não está aberto ao público: só o **primeiro membro** cria conta sozinho (fica ADMIN).
  Depois disso, um admin/gestor com `staff.manage` **convida** pelo email (`POST /v1/platform/staff-invitations`, 2FA recente).
- A pessoa recebe um email com o link `…/criar-conta?convite=<token>` (7 dias, uso único; na BD só o hash).
  O link prova o email → cria a conta sem código, já **ativa** com o papel do convite, e segue para a 2FA.
- Quem escrever um email sem convite recebe `403 STAFF_NOT_INVITED` ("Apenas pessoas autorizadas…").
- No frontend, a raiz `/` sem sessão abre o registo de colégios (o painel da equipa não é anunciado).

### Códigos por email (OTP)

- **Criar conta** (equipa e colégios): o email é confirmado com um código de 6 dígitos ANTES de a conta existir
  (`sign-up/code` → `sign-up/code/verify` → prova de uso único, 30 min → `sign-up`). A equipa só cria conta com email.
- **Esqueci a senha** (equipa, responsáveis, portal): código → nova senha. Na equipa e no portal **continua a pedir a 2FA**
  e as sessões antigas terminam.
- **Limites por conta** (não dependem do IP — `libs/kernel/src/domain/email-otp.ts`): 1 código/min, 5 por dia,
  10 tentativas erradas por dia; cada código: 15 min, 5 tentativas, uso único. Só se guardam hashes.

### Colégios com email pessoal

- O registo aceita email pessoal (gmail, hotmail…), com **30 dias** para passar a um email corporativo
  (`POST /v1/schools/me/email/code` + `/email`, com código enviado para o novo email).
- O platform-api verifica de hora a hora: prazo ultrapassado → colégio **desativado** (`SUSPENDED`), portal fechado
  (`tenant_databases.active = false`; a plataforma só pode escrever essa coluna) e pagamentos bloqueados.
- A equipa pode **desativar** e **reativar** (2FA recente). Reativar repõe o estado anterior e, se ainda for email
  pessoal, dá novo prazo de 30 dias.

### Antes de produção

- **nginx à frente dos frontends** a acrescentar o IP real (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`)
  e `TRUSTED_PROXY_HOPS=1` nos dois Next. Sem isso não se reencaminha IP (o cliente podia falsificá-lo).
  As APIs nunca acessíveis diretamente da internet.
- Portal: `PORTAL_BASE_DOMAIN` obrigatório (o servidor não arranca sem ele).
- Remetente dos emails num domínio próprio verificado no Brevo (não um Gmail).

- Cluster PostgreSQL separado para as BDs dos colégios; nenhuma porta de BD exposta.
- Chaves e senhas num gestor de segredos (Vault, Docker secrets…) em vez de `secrets/` e `.env`.
- Painel da equipa só acessível por VPN/lista de IPs; contentores sem root e com sistema de ficheiros só de leitura.
- Rede do provisioner limitada aos servidores de BD (ele liga-se aos endereços registados pela equipa).

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
| `databases` | Servidores/BDs dos colégios, testes de ligação, reservas e atribuições |

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
