import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import type { Env } from "./config/env";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.setGlobalPrefix("api");
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.disable("x-powered-by");
  app.enableShutdownHooks();

  if (config.get("NODE_ENV", { infer: true }) !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("EduFlow · School API")
        .setDescription(
          "**Módulo 2 · Portal do colégio** — cada colégio tem a sua própria base de dados e o seu utilizador PostgreSQL.\n\n" +
            "Serviço isolado da plataforma: só lê o diretório de colégios e não tem acesso à equipa nem à faturação.",
        )
        .setVersion("0.1.0")
        .build(),
    );
    SwaggerModule.setup("api/docs", app, document, {
      customSiteTitle: "EduFlow School API · Docs",
      jsonDocumentUrl: "api/docs/openapi.json",
    });
  }

  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  Logger.log(`school-api a correr em http://localhost:${port}/api`, "Bootstrap");
}

void bootstrap();
