-- =============================================================================
--  EduFlow — utilizadores PostgreSQL com privilégios mínimos (executar como admin)
--  Idempotente: cria o que falta e sincroniza as senhas.
--  Variáveis psql: migrator_pw, platform_pw, provisioner_pw, directory_pw
-- =============================================================================

-- ---------------------------------------------------------------- utilizadores
SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY[
  'eduflow_migrator', 'eduflow_platform_app', 'eduflow_provisioner', 'eduflow_school_directory'
]) AS r WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec

-- migrator: dono do esquema; só usado pelas migrações (CREATEDB → shadow DB do prisma migrate dev)
ALTER ROLE eduflow_migrator LOGIN CREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'migrator_pw';
-- platform_app: só dados (sem DDL), sem acesso às credenciais dos colégios
ALTER ROLE eduflow_platform_app LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'platform_pw';
-- provisioner: cria BDs/utilizadores de colégios; não lê dados da plataforma
ALTER ROLE eduflow_provisioner LOGIN CREATEDB CREATEROLE NOSUPERUSER PASSWORD :'provisioner_pw';
-- PG16: o provisioner fica membro (SET, INHERIT) dos utilizadores que cria → pode atribuir-lhes BDs
ALTER ROLE eduflow_provisioner SET createrole_self_grant = 'set, inherit';
-- school_directory: só lê o diretório de colégios
ALTER ROLE eduflow_school_directory LOGIN NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD :'directory_pw';

-- ---------------------------------------------------------------- ligação às bases de dados
-- Por omissão qualquer utilizador pode ligar-se a qualquer BD — fechamos isso.
REVOKE ALL ON DATABASE eduflow_platform FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
GRANT CONNECT ON DATABASE eduflow_platform
  TO eduflow_migrator, eduflow_platform_app, eduflow_provisioner, eduflow_school_directory;

-- ---------------------------------------------------------------- esquema e objetos existentes
ALTER SCHEMA public OWNER TO eduflow_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO eduflow_platform_app, eduflow_provisioner, eduflow_school_directory;

-- objetos criados antes desta configuração passam para o migrator
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO eduflow_migrator', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO eduflow_migrator', r.sequence_name);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typtype = 'e' LOOP
    EXECUTE format('ALTER TYPE public.%I OWNER TO eduflow_migrator', r.typname);
  END LOOP;
END $$;

-- tabelas futuras (novas migrações) ficam logo acessíveis à app da plataforma
ALTER DEFAULT PRIVILEGES FOR ROLE eduflow_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eduflow_platform_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eduflow_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eduflow_platform_app;
