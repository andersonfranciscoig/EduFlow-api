import { hkdfSync, randomUUID } from "node:crypto";
import { Prisma } from ".prisma/platform-client";
import { UTApi } from "uploadthing/server";
import { sealSecret } from "../../../../../../../libs/kernel/src/infrastructure/keys";
import { withoutSecrets } from "../../../../../../../libs/kernel/src/infrastructure/safe-errors";
import { SecretBox } from "../../../../../../../libs/kernel/src/infrastructure/secret-box";
import type { PlatformPrismaService } from "../../infrastructure/platform-prisma.service";
import type { StorageRepository, StorageRow, TokenVault, Usage, UsageProbe } from "../application/SchoolStorage";
import type { StoragePlan } from "../domain/storage";

const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
const num = (v: bigint | null) => (v == null ? null : Number(v));

export class PrismaStorageRepository implements StorageRepository {
  constructor(private readonly db: PlatformPrismaService) {}

  private async toRow(r: Prisma.SchoolStorageGetPayload<object>): Promise<StorageRow> {
    const staff = r.configuredById ? await this.db.staffMember.findUnique({ where: { id: r.configuredById }, select: { fullName: true } }) : null;
    return {
      schoolId: r.schoolId,
      appId: r.appId,
      keyHint: r.keyHint,
      tokenCiphertext: r.tokenCiphertext,
      plan: r.plan as StoragePlan,
      usedBytes: num(r.usedBytes),
      appBytes: num(r.appBytes),
      limitBytes: num(r.limitBytes),
      filesCount: r.filesCount,
      usageCheckedAt: r.usageCheckedAt,
      usageError: r.usageError,
      configuredBy: staff?.fullName ?? null,
      updatedAt: r.updatedAt,
    };
  }

  async schoolExists(id: string) {
    return !!(await this.db.school.findUnique({ where: { id }, select: { id: true } }));
  }

  async find(schoolId: string) {
    const r = await this.db.schoolStorage.findUnique({ where: { schoolId } });
    return r ? this.toRow(r) : null;
  }

  async all() {
    const rows = await this.db.schoolStorage.findMany();
    return Promise.all(rows.map((r) => this.toRow(r)));
  }

  async save(input: Parameters<StorageRepository["save"]>[0]) {
    const data = { appId: input.appId, keyHint: input.keyHint, tokenSealed: input.tokenSealed, tokenCiphertext: input.tokenCiphertext, configuredById: input.staffId, updatedAt: input.now };
    try {
      await this.db.schoolStorage.upsert({
        where: { schoolId: input.schoolId },
        create: { schoolId: input.schoolId, ...data, createdAt: input.now },
        // trocar de app: o uso medido antes já não vale
        update: { ...data, plan: "UNKNOWN", usedBytes: null, appBytes: null, limitBytes: null, filesCount: null, usageCheckedAt: null, usageError: null },
      });
      return { ok: true as const };
    } catch (e) {
      if (isUnique(e)) return { ok: false as const, reason: "app_in_use" as const };
      throw e;
    }
  }

  async saveUsage(schoolId: string, u: { plan: StoragePlan; usage: Usage | null; error: string | null; now: Date }) {
    await this.db.schoolStorage.update({
      where: { schoolId },
      data: {
        plan: u.plan,
        usageCheckedAt: u.now,
        usageError: u.error,
        ...(u.usage ? { usedBytes: BigInt(Math.round(u.usage.totalBytes)), appBytes: BigInt(Math.round(u.usage.appTotalBytes)), limitBytes: BigInt(Math.round(u.usage.limitBytes)), filesCount: u.usage.filesUploaded } : {}),
      },
    });
  }

  async remove(schoolId: string) {
    const r = await this.db.schoolStorage.deleteMany({ where: { schoolId } });
    return r.count > 0;
  }

  async record(schoolId: string, type: string, staffId: string, details: Record<string, unknown>, now: Date) {
    await this.db.schoolActivity.create({ data: { id: randomUUID(), schoolId, type, actorStaffId: staffId, details: details as Prisma.InputJsonValue, occurredAt: now } });
  }
}

/**
 * Selar para o school-api: chave PÚBLICA das credenciais dos colégios (a plataforma sela, não abre).
 * Cifrar para a plataforma: uma subchave (HKDF) da chave dos segredos TOTP, só para este fim.
 */
export class StorageTokenVault implements TokenVault {
  private readonly box: SecretBox;

  constructor(
    private readonly tenantPublicKeyPem: string | null,
    platformKeyBase64: string,
  ) {
    const sub = Buffer.from(hkdfSync("sha256", Buffer.from(platformKeyBase64.trim(), "base64"), Buffer.alloc(0), "eduflow/school-storage-token/v1", 32));
    this.box = new SecretBox(sub.toString("base64"));
  }

  sealForSchoolApi(token: string) {
    return this.tenantPublicKeyPem ? sealSecret(this.tenantPublicKeyPem, token) : null;
  }

  encrypt(token: string) {
    return this.box.encrypt(token);
  }

  decrypt(ciphertext: string) {
    return this.box.decrypt(ciphertext);
  }
}

/** Uso da conta no UploadThing (bytes, ficheiros, limite do plano). */
export class UploadThingUsageProbe implements UsageProbe {
  async usage(token: string): Promise<Usage> {
    // "None": o SDK escreveria o pedido (com o token) no log
    const api = new UTApi({ token, logLevel: "None" });
    const u = await withoutSecrets("UploadThing", () => api.getUsageInfo());
    return { totalBytes: u.totalBytes, appTotalBytes: u.appTotalBytes, filesUploaded: u.filesUploaded, limitBytes: u.limitBytes };
  }
}
