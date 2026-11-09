// Garante as fronteiras do monorepo (corre antes de cada build):
//   - uma app NUNCA importa código de outra app;
//   - libs/ nunca importa código de apps/.
// Assim, um serviço comprometido não arrasta código nem segredos dos outros,
// e cada app pode ser extraída para o seu próprio repositório.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

const zone = (file) => {
  const rel = path.relative(ROOT, file).split(path.sep);
  return rel[0] === "apps" ? `apps/${rel[1]}` : rel[0] === "libs" ? `libs/${rel[1]}` : rel[0];
};

const violations = [];
for (const file of [...walk(path.join(ROOT, "apps")), ...walk(path.join(ROOT, "libs"))]) {
  const from = zone(file);
  const code = readFileSync(file, "utf8");
  for (const [, spec] of code.matchAll(/(?:from\s+|import\s*\()["'](\.{1,2}\/[^"']+)["']/g)) {
    const to = zone(path.resolve(path.dirname(file), spec));
    const crossesApps = from.startsWith("apps/") && to.startsWith("apps/") && from !== to;
    const libToApp = from.startsWith("libs/") && to.startsWith("apps/");
    if (crossesApps || libToApp) violations.push(`${path.relative(ROOT, file)} → ${spec}  (${from} ✗ ${to})`);
  }
}

if (violations.length) {
  console.error("✗ Fronteiras violadas:\n  " + violations.join("\n  "));
  process.exit(1);
}
console.log("✓ fronteiras entre serviços respeitadas");
