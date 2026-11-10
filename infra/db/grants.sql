-- =============================================================================
--  Permissões por tabela (executar como eduflow_migrator após cada migração).
--  Regra: cada serviço só toca no que precisa.
-- =============================================================================

-- platform-api: dados da plataforma…
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eduflow_platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eduflow_platform_app;
-- …mas não as credenciais (cifradas) das BDs dos colégios nem o histórico de migrações
REVOKE ALL ON public.tenant_databases FROM eduflow_platform_app;
-- …exceto ligar/desligar o portal de um colégio (desativar/reativar): só a coluna "active"
GRANT SELECT (school_id), UPDATE (active) ON public.tenant_databases TO eduflow_platform_app;
REVOKE ALL ON public._prisma_migrations FROM eduflow_platform_app;
-- URLs dos servidores de BD: a plataforma ESCREVE mas não LÊ (write-only).
-- (SELECT só na chave, necessário para UPDATE/DELETE … WHERE server_id = …)
REVOKE ALL ON public.database_server_secrets FROM eduflow_platform_app;
GRANT INSERT ON public.database_server_secrets TO eduflow_platform_app;
GRANT SELECT (server_id), UPDATE (url_ciphertext, updated_at) ON public.database_server_secrets TO eduflow_platform_app;
GRANT DELETE ON public.database_server_secrets TO eduflow_platform_app;

-- provisioner: fila de provisionamento, diretório e servidores de BD
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eduflow_provisioner;
GRANT SELECT, UPDATE ON public.tenant_provisioning_jobs TO eduflow_provisioner;
GRANT SELECT, INSERT, UPDATE ON public.tenant_databases TO eduflow_provisioner;
GRANT SELECT ON public.database_server_secrets TO eduflow_provisioner;
GRANT SELECT (id, kind, status, host, port, database, ssl_mode, health, server_version, tls_active, consecutive_failures),
      UPDATE (health, last_checked_at, last_latency_ms, server_version, tls_active, last_error, consecutive_failures, updated_at)
  ON public.database_servers TO eduflow_provisioner;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.database_server_checks TO eduflow_provisioner;

-- school-api: só lê o diretório
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eduflow_school_directory;
GRANT SELECT ON public.tenant_databases TO eduflow_school_directory;
