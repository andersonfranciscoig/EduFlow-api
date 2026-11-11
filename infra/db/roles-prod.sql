-- =============================================================================
--  EduFlow — utilizadores PostgreSQL de PRODUÇÃO (Neon, RDS…), privilégios mínimos.
--  Executar com o utilizador dono da BD (ex.: neondb_owner). Idempotente.
--  Variáveis psql: dbname, migrator_pw, platform_pw, provisioner_pw, directory_pw
--
--  Diferenças em relação ao roles.sql de desenvolvimento:
--   - sem eduflow_tenant_admin (só servia para simular um servidor de colégios);
--   - o provisioner NÃO cria BDs/utilizadores aqui: as BDs dos colégios vivem nos
--     servidores registados no painel (com as credenciais desses servidores);
--   - não mexe nas BDs "postgres"/"template1" (num serviço gerido não se pode).
-- =============================================================================

SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY[
  'eduflow_migrator', 'eduflow_platform_app', 'eduflow_provisioner', 'eduflow_school_directory'
]) AS r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- Sem NOSUPERUSER/NOCREATEDB/NOCREATEROLE: num serviço gerido o dono não é superutilizador
-- e não pode escrever esses atributos (nem para os desligar). Um CREATE ROLE já os cria
-- desligados — o passo seguinte do script confirma-o.
ALTER ROLE eduflow_migrator         LOGIN PASSWORD :'migrator_pw';
ALTER ROLE eduflow_platform_app     LOGIN PASSWORD :'platform_pw';
ALTER ROLE eduflow_provisioner      LOGIN PASSWORD :'provisioner_pw';
ALTER ROLE eduflow_school_directory LOGIN PASSWORD :'directory_pw';

-- verificação: nenhum utilizador DA APLICAÇÃO pode ter poderes de administração.
-- (pelo nome exato — o dono do Neon também pode chamar-se eduflow_…, ex.: eduflow_platform_owner)
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
  WHERE rolname IN ('eduflow_migrator', 'eduflow_platform_app', 'eduflow_provisioner', 'eduflow_school_directory')
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Com SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS: % — corrija à mão antes de continuar.', bad;
  END IF;
END $$;

-- ligação à BD: só estes utilizadores
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO eduflow_migrator, eduflow_platform_app, eduflow_provisioner, eduflow_school_directory;

-- o dono atual precisa de poder "ser" o migrator para lhe passar o esquema (PG16+)
GRANT eduflow_migrator TO CURRENT_USER WITH SET TRUE;
ALTER SCHEMA public OWNER TO eduflow_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO eduflow_platform_app, eduflow_provisioner, eduflow_school_directory;

-- tabelas futuras (novas migrações) ficam logo acessíveis à app da plataforma;
-- as exceções (credenciais, segredos…) são aplicadas depois por infra/db/grants.sql
ALTER DEFAULT PRIVILEGES FOR ROLE eduflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eduflow_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eduflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eduflow_platform_app;

-- o dono deixa de poder agir como migrator (fica só com a gestão do utilizador)
REVOKE eduflow_migrator FROM CURRENT_USER;
