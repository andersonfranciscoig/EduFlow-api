import { Module } from "@nestjs/common";
import { PlatformPrismaService } from "./platform-prisma.service";

@Module({
  providers: [PlatformPrismaService],
  exports: [PlatformPrismaService],
})
export class PlatformDatabaseModule {}
