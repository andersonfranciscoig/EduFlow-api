// Desenvolvimento: compila em modo watch e arranca os 3 serviços, cada um no
// seu processo (com recarregamento automático). Uso: pnpm dev [nome…]
//   pnpm dev                    → platform-api, school-api e provisioner
//   pnpm dev platform-api       → só um
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";

const ALL = ["platform-api", "school-api", "provisioner"];
const selected = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const COLORS = { tsc: 90, "platform-api": 36, "school-api": 35, provisioner: 33 };
const children = [];

const prefix = (name, data) => {
  const tag = `\x1b[${COLORS[name] ?? 37}m[${name}]\x1b[0m `;
  return data.toString().split("\n").filter(Boolean).map((l) => tag + l).join("\n") + "\n";
};

function run(name, cmd, args, onLine) {
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (d) => {
      process.stdout.write(prefix(name, d));
      onLine?.(d.toString());
    });
  }
  children.push(child);
  return child;
}

rmSync("dist", { recursive: true, force: true });
let started = false;
run("tsc", "node_modules/.bin/tsc", ["-p", "tsconfig.json", "--watch", "--preserveWatchOutput"], (out) => {
  if (started || !/Found \d+ errors?/.test(out)) return;
  started = true;
  for (const app of selected) {
    const main = `dist/apps/${app}/src/main.js`;
    if (!existsSync(main)) {
      console.error(`Serviço desconhecido ou sem build: ${app}`);
      continue;
    }
    run(app, process.execPath, ["--enable-source-maps", "--watch", main]);
  }
});

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
