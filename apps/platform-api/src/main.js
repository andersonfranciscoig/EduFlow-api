"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("./app.module");
async function bootstrap() {
    const app = await core_1.NestFactory.create(app_module_1.AppModule);
    const config = app.get(config_1.ConfigService);
    app.setGlobalPrefix("api");
    app.set("trust proxy", "loopback, linklocal, uniquelocal");
    app.disable("x-powered-by");
    app.enableCors({ origin: config.get("FRONTEND_URL", { infer: true }), credentials: true });
    app.enableShutdownHooks();
    if (config.get("NODE_ENV", { infer: true }) !== "production") {
        const document = swagger_1.SwaggerModule.createDocument(app, new swagger_1.DocumentBuilder()
            .setTitle("EduFlow · Platform API")
            .setDescription("**Módulo 1 · Plataforma** — equipa interna da EduFlow, colégios clientes (registo, validação, pagamentos) e faturação.\n\n" +
            "Serviço isolado: tem a sua própria base de dados, o seu utilizador PostgreSQL de privilégios mínimos e as suas chaves de tokens.\n\n" +
            "Erros seguem sempre o formato `{ code, message, meta }`.")
            .setVersion("0.2.0")
            .addBearerAuth({ type: "http", scheme: "bearer", bearerFormat: "JWT" })
            .build());
        swagger_1.SwaggerModule.setup("api/docs", app, document, {
            customSiteTitle: "EduFlow API · Docs",
            jsonDocumentUrl: "api/docs/openapi.json",
            swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tagsSorter: "alpha" },
        });
    }
    const port = config.get("PORT", { infer: true });
    await app.listen(port);
    common_1.Logger.log(`platform-api a correr em http://localhost:${port}/api`, "Bootstrap");
    common_1.Logger.log(`Documentação em http://localhost:${port}/api/docs`, "Bootstrap");
}
void bootstrap();
//# sourceMappingURL=main.js.map