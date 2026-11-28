# Módulo de Comunicação

Avisos institucionais, mensagens individuais e grupos, com permissões configuráveis por colégio. Faseado:

| Fase | Estado | O que entrega |
|---|---|---|
| C1 | feito | Avisos: publicação por permissão (toda a comunidade ou só a equipa) e pelo diretor de turma (configuração do colégio), destinatários sem repetidos, rascunho/agendado/publicado/arquivado, expiração, fixar, confirmação de leitura, anexos, indicadores de leitura, categorias, notificações, auditoria |
| C2 | por fazer | Mensagens individuais (encarregado ↔ professores e diretor de turma dos educandos, e as outras relações configuradas), anexos, notificações |
| C3 | por fazer | Grupos (manuais e ligados a turmas, classes e departamentos), permissões e sincronização dos participantes |
| C4 | por fazer | Tempo real por consulta curta (atrás de uma interface, para mais tarde trocar por SSE/WebSocket), configuração da comunicação, testes finais e relatório |

## Decisões

- **Tempo real:** o projeto não tinha WebSocket nem SSE. Escolha: consulta curta (4 s na conversa aberta, 30 s para os contadores), sem dependências novas e compatível com a Vercel. As mensagens guardam-se sempre na BD, independentemente da ligação.
- **Diretor de turma:** o papel Professor não recebe permissões (só as rotas do professor). A autorização é da configuração do colégio ("os diretores de turma podem publicar para as suas turmas"), e a relação com a turma confirma-se no backend em cada gravação e na publicação (`class_groups.coordinator_id` → `employees.user_id`).
- **Estudantes:** só os alunos maiores têm conta (`family_accounts.kind = STUDENT`); os menores recebem os avisos pelos encarregados.
- **Departamentos:** os das fichas e contratos dos funcionários (texto livre).

## C1 · Avisos

### Entidades (migração `0054_communication_announcements`)

| Tabela | Conteúdo |
|---|---|
| `communication_settings` | uma linha: os diretores de turma podem publicar (por omissão, sim) |
| `announcement_categories` | as do colégio; entram Geral, Académico, Administrativo, Financeiro, Eventos, Reuniões e Urgente; arquivam-se, não se apagam |
| `announcements` | título, texto, categoria, prioridade (Normal, Alta, Urgente), estado, autoridade usada (ALL, STAFF, CLASS), publicação agendada, expiração, fixar, confirmação de leitura, revisão |
| `announcement_targets` | os destinatários escolhidos: toda a instituição, alunos, encarregados, professores, funcionários, classe, turma (alunos, encarregados ou ambos), departamento, pessoa |
| `announcement_recipients` | quem recebe, calculado na publicação e sem repetidos, com a razão (via), entregue (a notificação chegou de facto), visto e confirmado |
| `announcement_files` | anexos (PDF, JPG ou PNG até 10 MB, até 5), cifrados no armazenamento do colégio |

### Permissões

`communication.access`, `communication.announcements.publish` (toda a comunidade), `communication.announcements.staff` (só a equipa: professores, funcionários, departamentos, pessoas da equipa), `communication.announcements.manage` (todos os avisos e indicadores; sem ela, só os próprios), `communication.settings.manage`. Nenhuma é atribuída automaticamente. Receber e ler avisos não pede permissão.

### API

- Equipa (`/api/v1/communication`, também professores e RH): `GET announcements` (?categoria, q, porLer), `GET announcements/unread`, `GET announcements/:id` (fica visto), `POST announcements/:id/ack`, `GET announcements/:id/files/:fileId`.
- Gestão: `GET announcements/manage/options`, `GET announcements/manage/people?q=`, `GET/POST announcements/manage`, `GET/PUT/PATCH/DELETE announcements/manage/:id` (?leitura=VIEWED|NOT_VIEWED|ACK|NOT_ACK), `POST announcements/manage/:id/publish`, `POST announcements/manage/:id/archive`, `POST/DELETE announcements/manage/:id/files[/:fileId]`.
- Configuração: `GET/PUT settings`, `POST settings/categories`, `PUT settings/categories/:id`.
- Família (`/api/v1/family/announcements`): `GET /`, `GET unread`, `GET :id`, `POST :id/ack`, `GET :id/files/:fileId`.

### Regras

- A autoridade escolhe-se no backend: a mais estreita que cobre todos os destinatários (diretor de turma → equipa → toda a comunidade). O diretor de turma só escolhe as turmas que dirige; outra turma ou outro destinatário → 403.
- Publicado não se altera (arquiva-se e publica-se outro); só fixar e a expiração. Rascunhos apagam-se; os outros arquivam-se.
- Agendados publicam-se no ciclo das tarefas automáticas e, por precaução, ao abrir as listas. Um agendado cuja expiração já passou volta a rascunho.
- Notificações pelo sistema existente: `ANNOUNCEMENTS` e `URGENT_ANNOUNCEMENTS` (equipa; os urgentes também por email por omissão) e `FAMILY_ANNOUNCEMENTS`. Uma por pessoa e aviso. "Entregue" só quando a notificação chegou de facto (o colégio pode desligar o tipo); "visto" só ao abrir o aviso.
- Anexos só pela API, para quem gere o aviso ou o recebeu. Retirar um anexo não apaga o ficheiro.
- Auditoria em `school_activity` (criar, alterar, publicar, arquivar, apagar rascunho, anexos, categorias e configuração), sem o texto dos avisos.

### Portal

- Equipa: `/comunicacao/avisos` (Recebidos · Gerir e publicar), `/comunicacao/avisos/[id]`, `/comunicacao/avisos/novo`, `/comunicacao/avisos/gerir/[id]` (+ `/editar`), `/comunicacao/configuracao`.
- Família: `/familia/avisos` (+ `/[id]`).
- Utilizadores: atalhos da comunicação (só recebe, publicar para a equipa, para toda a comunidade, tudo).

### Testes (E2E, BD local isolada, bloco `cm`)

Publicação sem permissão (403); só para a equipa; vários destinatários sem repetidos; notificação e entrega; leitura e confirmação; isolamento (outra família, outro professor, outro colégio); agendado; diretor de turma para a sua turma, para outra turma (403) e com a configuração desligada (403); anexos (tipo real, acesso só a quem recebe); arquivo; gestão só dos próprios; categorias e auditoria.
