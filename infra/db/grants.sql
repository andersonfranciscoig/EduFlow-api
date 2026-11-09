-- =============================================================================
--  Permissões por tabela (executar como eduflow_migrator após cada migração).
--  Regra: cada serviço só toca no que precisa.
-- =============================================================================

-- platform-api: dados da plataforma…
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO eduflow_platform_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO eduflow_platform_app;
-- …mas não as credenciais (cifradas) das BDs dos colégios nem o histórico de migrações
REVOKE ALL ON public.tenant_databases FROM eduflow_platform_app;
REVOKE ALL ON public._prisma_migrations FROM eduflow_platform_app;

-- provisioner: só a fila de provisionamento e o diretório
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eduflow_provisioner;
GRANT SELECT, UPDATE ON public.tenant_provisioning_jobs TO eduflow_provisioner;
GRANT SELECT, INSERT, UPDATE ON public.tenant_databases TO eduflow_provisioner;

-- school-api: só lê o diretório
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM eduflow_school_directory;
GRANT SELECT ON public.tenant_databases TO eduflow_school_directory;
