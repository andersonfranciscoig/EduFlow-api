import { HttpStatus } from "@nestjs/common";
import { z } from "zod";
import type { DatabaseErrorCode } from "../../domain/errors";
import { MAX_SHARED_CAPACITY } from "../../domain/DatabaseServer";

export const DATABASE_HTTP: Partial<Record<DatabaseErrorCode, HttpStatus>> = {
  INVALID_SERVER: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_URL: HttpStatus.UNPROCESSABLE_ENTITY,
  ENDPOINT_TAKEN: HttpStatus.CONFLICT,
  SERVER_NOT_FOUND: HttpStatus.NOT_FOUND,
  CHECK_NOT_FOUND: HttpStatus.NOT_FOUND,
  ALLOCATION_NOT_FOUND: HttpStatus.NOT_FOUND,
  SCHOOL_NOT_FOUND: HttpStatus.NOT_FOUND,
  INVALID_STATE: HttpStatus.CONFLICT,
  NO_CAPACITY: HttpStatus.CONFLICT,
  SERVER_IN_USE: HttpStatus.CONFLICT,
};

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

const urlField = z
  .string({ error: "Indique o URL de ligação." })
  .trim()
  .min(1, "Indique o URL de ligação.")
  .max(2048)
  .meta({ description: "Write-only: é cifrado e nunca mais devolvido.", example: "postgresql://eduflow_admin:senha@db1.exemplo.ao:5432/postgres?sslmode=require" });

const settingsShape = {
  name: z.string({ error: "Dê um nome ao servidor." }).trim().min(2, "Dê um nome ao servidor.").max(80).meta({ example: "Luanda · cluster 1" }),
  capacity: z.coerce.number().int().min(1).max(MAX_SHARED_CAPACITY).default(1).meta({ description: "Nº máximo de colégios (dedicada = 1)" }),
  region: optionalText(60),
  notes: optionalText(500),
};

export const registerServerSchema = z
  .object({
    kind: z.enum(["SHARED_SERVER", "DEDICATED_DATABASE"], { error: "Escolha o tipo." }),
    url: urlField,
    ...settingsShape,
  })
  .meta({ title: "RegisterDatabaseServer" });

export const serverSettingsSchema = z.object(settingsShape).meta({ title: "DatabaseServerSettings" });
export const rotateCredentialsSchema = z.object({ url: urlField }).meta({ title: "RotateDatabaseCredentials" });

export const reserveSchema = z
  .object({ serverId: z.union([z.uuid(), z.literal("auto")], { error: "Escolha um servidor." }) })
  .meta({ title: "ReserveDatabase" });
export const assignSchema = z.object({ serverId: z.uuid({ error: "Escolha um servidor." }) }).meta({ title: "AssignDatabase" });

export type RegisterServerBody = z.infer<typeof registerServerSchema>;
export type ServerSettingsBody = z.infer<typeof serverSettingsSchema>;
