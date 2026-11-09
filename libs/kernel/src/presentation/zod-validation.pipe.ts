import { BadRequestException, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

/**
 * Valida o corpo do pedido com um schema zod.
 * Uso: @Body(new ZodValidationPipe(schema)) body: z.infer<typeof schema>
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        message: first?.message ?? "Dados inválidos.",
        meta: { issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      });
    }
    return result.data;
  }
}
