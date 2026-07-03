import { buildApp } from "../../server";

/**
 * Réutilisation de la fonction buildApp() du serveur.
 * On désactive le logger et les side effects (jobs, subscribers) pour ne pas polluer les tests.
 */

export async function buildTestApp() {
    return buildApp({
        logger: false,
        skipSideEffects: true,
    });
}
