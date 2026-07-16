import { buildApp } from "../../server";
import type { FastifyInstance } from "fastify";

/**
 * Réutilisation des meme configuration que le serveur de la production.
 * On désactive le logger et les side effects (jobs, subscribers) pour ne pas polluer les tests.
 */

export async function buildTestApp(options: {
    routes?: (app: FastifyInstance) => Promise<void> | void;
}) {
    const { routes } = options;

    const app = await buildApp({
        logger: false,
        skipSideEffects: true,
        skipRoutes: true,
    });
    
    //On Enregistre juste les routes a tester

    if (routes) {
        await routes(app);
    }

    await app.ready();

    return app;
}
