import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { readKeyFile, sealSecret } from "../../../../../../libs/kernel/src/infrastructure/keys";
import { systemClock, uuidGenerator } from "../../../../../../libs/kernel/src/infrastructure/system";
import type { Env } from "../../../config/env";
import { IdentityModule } from "../identity/identity.module";
import { PlatformDatabaseModule } from "../infrastructure/platform-database.module";
import { PlatformPrismaService } from "../infrastructure/platform-prisma.service";
import { DatabasePlacement } from "./application/DatabasePlacement";
import { DatabaseRegistry } from "./application/DatabaseRegistry";
import { type CredentialSealer, DATABASE_TOKENS as T, type PlacementStore } from "./application/ports";
import { assignOnActivation, PrismaPlacementStore } from "./infrastructure/placement-sql";
import { PrismaDatabaseServerRepository } from "./infrastructure/PrismaDatabaseServerRepository";
import { DatabasePlacementController, DatabaseServersController } from "./presentation/http/database.controller";

/** Gancho usado pelo contexto "schools" na transação de ativação do colégio. */
export const ACTIVATION_PLACEMENT = Symbol("ActivationPlacement");
export type ActivationPlacement = typeof assignOnActivation;

/**
 * Contexto "Databases": servidores/BDs onde vivem os colégios, reservas e
 * atribuições. Só conhece a chave PÚBLICA do provisioner (sela os URLs).
 */
@Module({
  imports: [PlatformDatabaseModule, IdentityModule],
  controllers: [DatabaseServersController, DatabasePlacementController],
  providers: [
    {
      provide: T.Sealer,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): CredentialSealer => {
        const publicKey = readKeyFile(config.get("SERVER_CREDENTIALS_PUBLIC_KEY_FILE", { infer: true }));
        return { seal: (url) => sealSecret(publicKey, url) };
      },
    },
    {
      provide: PrismaDatabaseServerRepository,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaDatabaseServerRepository(prisma),
    },
    {
      provide: T.PlacementStore,
      inject: [PlatformPrismaService],
      useFactory: (prisma: PlatformPrismaService) => new PrismaPlacementStore(prisma),
    },
    {
      provide: DatabaseRegistry,
      inject: [PrismaDatabaseServerRepository, T.Sealer],
      useFactory: (repo: PrismaDatabaseServerRepository, sealer: CredentialSealer) =>
        new DatabaseRegistry(repo, repo, sealer, uuidGenerator, systemClock),
    },
    {
      provide: DatabasePlacement,
      inject: [T.PlacementStore],
      useFactory: (store: PlacementStore) => new DatabasePlacement(store, systemClock),
    },
    { provide: ACTIVATION_PLACEMENT, useValue: assignOnActivation },
  ],
  exports: [DatabasePlacement, ACTIVATION_PLACEMENT],
})
export class DatabasesModule {}
