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
    app.enableShutdownHooks();
    if (config.get("NODE_ENV", { infer: true }) !== "production") {
        const document = swagger_1.SwaggerModule.createDocument(app, new swagger_1.DocumentBuilder()
            .setTitle("EduFlow · School API")
            .setDescription("**Módulo 2 · Portal do colégio** — cada colégio tem a sua própria base de dados e o seu utilizador PostgreSQL.\n\n" +
            "Serviço isolado da plataforma: só lê o diretório de colégios e não tem acesso à equipa nem à faturação.")
            .setVersion("0.1.0")
            .build());
        swagger_1.SwaggerModule.setup("api/docs", app, document, {
            customSiteTitle: "EduFlow School API · Docs",
            jsonDocumentUrl: "api/docs/openapi.json",
        });
    }
    const port = config.get("PORT", { infer: true });
    await app.listen(port);
    common_1.Logger.log(`school-api a correr em http://localhost:${port}/api`, "Bootstrap");
}
void bootstrap();
//# sourceMappingURL=main.js.map