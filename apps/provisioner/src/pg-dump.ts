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
  const host = directHost(input.url.host);
  const args = ["--format=custom", "--compress=6", "--no-password", "-h", host, "-p", String(input.url.port), "-U", input.url.user, "-d", input.database];
  if (input.role) args.push(`--role=${input.role}`);
  const env: Record<string, string> = { PGPASSWORD: input.url.password, PGSSLMODE: input.url.sslMode, PGCONNECT_TIMEOUT: "10", PGCHANNELBINDING: input.url.channelBinding };

  const [cmd, cmdArgs] = input.dockerImage
    ? ["docker", ["run", "--rm", "-i", "--network", "host", ...Object.keys(env).flatMap((k) => ["-e", k]), input.dockerImage, "pg_dump", ...args]]
    : ["pg_dump", args];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs as string[], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        child.kill("SIGKILL");
        return reject(new Error("A cópia passa de 1 GB — é preciso o modo streaming."));
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (error) => reject(new Error(`pg_dump não arrancou: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`pg_dump terminou com erro (${code}): ${stderr.trim().split("\n").slice(-2).join(" ").slice(0, 400)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}
