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
  // O frontend (Next.js) chama a API a partir do servidor e reencaminha o IP real
  // em X-Forwarded-For — confiamos apenas em proxies da rede local/loopback.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  app.disable("x-powered-by");
  app.enableCors({ origin: config.get("FRONTEND_URL", { infer: true }), credentials: true });
  app.enableShutdownHooks();

  // Documentação OpenAPI (Swagger) — desligada em produção.
  if (config.get("NODE_ENV", { infer: true }) !== "production") {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("EduFlow · Platform API")
        .setDescription(
          "**Módulo 1 · Plataforma** — equipa interna da EduFlow, colégios clientes (registo, validação, pagamentos) e faturação.\n\n" +
            "Serviço isolado: tem a sua própria base de dados, o seu utilizador PostgreSQL de privilégios mínimos e as suas chaves de tokens.\n\n" +
            "Erros seguem sempre o formato `{ code, message, meta }`.",
        )
        .setVersion("0.2.0")
        .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
        .build(),
    );
    SwaggerModule.setup("api/docs", app, document, {
      customSiteTitle: "EduFlow API · Docs",
      jsonDocumentUrl: "api/docs/openapi.json",
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tagsSorter: "alpha" },
    });
  }

  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  Logger.log(`platform-api a correr em http://localhost:${port}/api`, "Bootstrap");
  Logger.log(`Documentação em http://localhost:${port}/api/docs`, "Bootstrap");
}

void bootstrap();
