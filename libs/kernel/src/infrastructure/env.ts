import type { z } from "zod";

/**
 * Validação do ambiente de cada serviço: o serviço não arranca se faltar
 * alguma variável (ou se tiver variáveis com formato inválido).
 */
export function envValidator<S extends z.ZodType>(schema: S, service: string) {
  return (config: Record<string, unknown>): z.infer<S> => {
    const parsed = schema.safeParse(config);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
      throw new Error(`[${service}] Configuração inválida (apps/${service}/.env):\n${issues}`);
    }
    return parsed.data;
  };
}
