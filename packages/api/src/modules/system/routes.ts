import type { FastifyInstance } from "fastify";
import { resolveEnvironment } from "./service";

/**
 * Route publicque : informe le frontend de l'environnement réel du backend.
 */
export async function registerSystemRoutes(app: FastifyInstance) {
  app.get(
    "/api/system/environment",
    {
      schema: {
        tags: ["system"],
        summary: "Environnement d'exécution du backend (public)",
      },
    },
    async () => ({ environment: resolveEnvironment() }),
  );
}
