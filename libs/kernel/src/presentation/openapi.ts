import type { SchemaObject } from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { z } from "zod";

/**
 * Converte um schema zod em schema OpenAPI.
 * A mesma fonte valida o pedido e documenta-o no Swagger — nunca ficam dessincronizados.
 */
export function openApi(schema: z.ZodType, io: "input" | "output" = "input"): SchemaObject {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: "openapi-3.0",
    io,
    unrepresentable: "any",
  }) as Record<string, unknown>;
  return json as SchemaObject;
}

/** Formato único de erro da API. */
export const apiErrorSchema = z
  .object({
    code: z.string().meta({ example: "INVALID_CREDENTIALS" }),
    message: z.string().meta({ example: "Senha incorreta. Tente novamente." }),
    meta: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .meta({ description: "Erro da API" });
