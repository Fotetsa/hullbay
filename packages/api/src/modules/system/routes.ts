import type { FastifyInstance } from "fastify";
import { resolveEnvironment } from "./service";

export async function registerSystemRoutes(app: FastifyInstance) {
    app.get(
        "/api/system/environment",
        {
            schema: {
                tags: ["system"],
                summary: "Environment d'exécution du backend (public)",
            },
        },
        async () => ({ environment : resolveEnvironment() }),
    )
}