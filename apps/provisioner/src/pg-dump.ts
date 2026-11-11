import { spawn } from "node:child_process";
import type { PostgresUrl } from "../../../libs/kernel/src/domain/postgres-url";

const MAX_BYTES = 1024 * 1024 * 1024; // 1 GB por cópia (em memória) — acima disso, passar a streaming

/**
 * Neon: o "pooler" (PgBouncer em modo transação) não serve para pg_dump —
 * usa-se o endpoint direto (o mesmo nome sem "-pooler").
 */
export function directHost(host: string) {
  return /\.neon\.tech$/i.test(host) ? host.replace(/-pooler(?=\.)/i, "") : host;
}

/**
 * pg_dump (formato "custom", já comprimido) de UMA base de dados.
 *  - `role`: SET ROLE depois de ligar (servidor partilhado: o provisioner usa a
 *    sua ligação de administração e age como o colégio, com acesso temporário).
 * A senha vai por variável de ambiente (nunca na linha de comandos).
 */
export function pgDump(input: { url: PostgresUrl; database: string; role?: string; dockerImage?: string }): Promise<Buffer> {
  const args = ["--format=custom", "--compress=6", ...connection(input)];
  return runPgTool("pg_dump", args, input);
}

type Target = { url: PostgresUrl; database: string; role?: string; dockerImage?: string };

function connection(input: Target) {
  const args = ["--no-password", "-h", directHost(input.url.host), "-p", String(input.url.port), "-U", input.url.user, "-d", input.database];
  if (input.role) args.push(`--role=${input.role}`);
  return args;
}

/**
 * Restaura uma cópia "custom" na BD (já preparada — schema vazio):
 *   pg_restore → SQL (sem ligação)  →  psql numa só transação, a parar no 1.º erro.
 * Porquê em dois passos: o pg_restore recente (17+) escreve `SET transaction_timeout`,
 * que servidores mais antigos (≤ 16) não conhecem — retira-se essa linha.
 *  - --no-owner/--no-privileges: os objetos ficam de quem restaura (o colégio);
 *  - `role`: SET ROLE no início (servidor partilhado).
 */
export async function pgRestore(input: Target & { dump: Buffer }): Promise<void> {
  const sql = (await runPgTool("pg_restore", ["--no-owner", "--no-privileges", "-f", "-"], { dockerImage: input.dockerImage }, input.dump, {}))
    .toString("utf8")
    .replace(/^SET transaction_timeout = .*$/gm, "")
    // o schema public é criado pelo provisioner antes (não pode vir duplicado)
    .replace(/^CREATE SCHEMA public;$/gm, "");
  const script = (input.role ? `SET ROLE "${input.role}";\n` : "") + sql;
  await runPgTool("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "--single-transaction", "-f", "-", ...connection({ ...input, role: undefined })], input, Buffer.from(script, "utf8"));
}

/** Índice (TOC) da cópia — sem ligação a nenhuma BD. */
export async function pgRestoreList(dump: Buffer, dockerImage?: string): Promise<string> {
  return (await runPgTool("pg_restore", ["--list"], { dockerImage }, dump, {})).toString("utf8");
}

function runPgTool(
  tool: "pg_dump" | "pg_restore" | "psql",
  args: string[],
  input: { url?: PostgresUrl; dockerImage?: string },
  stdin?: Buffer,
  envOverride?: Record<string, string>,
): Promise<Buffer> {
  const env: Record<string, string> =
    envOverride ??
    (input.url ? { PGPASSWORD: input.url.password, PGSSLMODE: input.url.sslMode, PGCONNECT_TIMEOUT: "10", PGCHANNELBINDING: input.url.channelBinding } : {});

  const [cmd, cmdArgs] = input.dockerImage
    ? ["docker", ["run", "--rm", "-i", "--network", "host", ...Object.keys(env).flatMap((k) => ["-e", k]), input.dockerImage, tool, ...args]]
    : [tool, args];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs as string[], { env: { ...process.env, ...env }, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    if (stdin) {
      child.stdin!.on("error", () => undefined); // o processo pode terminar antes de ler tudo (o erro vem pelo código de saída)
      child.stdin!.end(stdin);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill("SIGKILL");
        return reject(new Error("A cópia passa de 1 GB — é preciso o modo streaming."));
      }
      chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => reject(new Error(`${tool} não arrancou: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${tool} terminou com erro (${code}): ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 400)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}
