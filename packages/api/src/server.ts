//Importation du ceux qui vas permettre de traduit Zod en JSON Schema pour Swagger
import {
  serializerCompiler, // Pour sérialiser les réponses
  validatorCompiler, // Pour valider les requêtes entrantes
  jsonSchemaTransform, // Pour transformer les schémas Zod en JSON Schema
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import Fastify, { FastifyError } from "fastify";
import cors from "@fastify/cors";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { pingDocker } from "./modules/docker-engine/client";
import { registerProjectRoutes } from "./modules/projects/routes";
import { registerReconcilerRoutes } from "./modules/reconciler/routes";
import { registerAuthRoutes, registerAuthGuard } from "./modules/auth/routes";
import { registerRegistryRoutes } from "./modules/registry/routes";
import { registerServersRoutes } from "./modules/servers/routes";
import { registerObservabilityRoutes } from "./modules/observability/routes";
import { registerSecretsRoutes } from "./modules/secrets/routes";
import { registerSettingsRoutes } from "./modules/settings/routes";
import { registerUpdatesRoutes } from "./modules/updates/routes";
import { updaterService } from "./modules/updates/updater";
import { prisma } from "./lib/prisma";
import { attachWebSocket } from "./loaders/websocket";
import { startObserver, stopObserver } from "./modules/observer/service";
import { registerObservabilitySubscribers } from "./modules/observability/service";
import { registerDeploySubscribers } from "./subscribers/on-deploy-finished";
import { startDriftJob } from "./jobs/reconcile-drift";
import { startAutoScaler } from "./jobs/auto-scaler";
import fastify, { type FastifyInstance } from "fastify";
import { stopTunnelCleanup, closeAllTunnels } from "./lib/ssh-tunnel";
import { registerClustersRoutes } from "./modules/clusters/routes";
import { registerClusterSubscribers } from "./subscribers/clusters";
import { registerSystemRoutes } from "./modules/system/routes";



/**
 * Serveur Fastify long-running de l'ops-panel (1 process : HTTP + socket.io).
 *
 * SÉCURITÉ : bind loopback par défaut ; exposition publique via Caddy uniquement.
 * Auth JWT + MFA imposées sur /api/* (sauf login/bootstrap). docker.sock = root.
 */

const HOST = process.env.API_HOST || "127.0.0.1";
const PORT = Number(process.env.API_PORT || 4000);

export interface BuildAppOptions {
  logger?: boolean | object;
  skipSideEffects?: boolean;
  skipRoutes?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const { logger = true, skipSideEffects = false, skipRoutes = false } = options;

  const app = Fastify({
    logger: logger ? {
      // Rédaction des champs sensibles dans les logs (Fastify logge req au niveau
      // info). Empêche credentials SSH/registry/secrets de fuiter dans les journaux.
      redact: {
        paths: [
          "req.body.value",
          "req.body.token",
          "req.body.password",
          "req.body.currentPassword",
          "req.body.newPassword",
          "req.body.credential",
          "req.body.privateKey",
          "req.headers.authorization",
          "req.headers.cookie",
        ],
        censor: "[redacted]",
      },
    } : false,
  }).withTypeProvider<ZodTypeProvider>();  //permet l'activation du typage automatique

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  
app.setErrorHandler((error: FastifyError, request, reply) => {
  if (error.validation) {
    const fieldErrors: Record<string, string[]> = {};
    error.validation.forEach((v) => {
      const path = v.instancePath?.replace("/", "") || "body";
      if (!fieldErrors[path]) fieldErrors[path] = [];
      fieldErrors[path].push(v.message ?? "Une Erreur est survenue lors de la Validation");
    });

    return reply.code(400).send({
      statusCode: 400,
      error: "Validation echouee",
      details: fieldErrors,
    });
  }

  reply.send(error);
});
  
  //Permet de spécifier au site donc l'url est http://localhost:5273
  //de lui parler depuis le serveur API (CORS) pour les requêtes fetch() côté navigateur.
  await app.register(cors, {
    origin: (process.env.WEB_ORIGIN || "http://localhost:5273").split(","),
    credentials: true,
  });

  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "hullbay API",
        description:
          "Interface interactive pour découvrir et tester les endpoints du système.",
        version: "1.0.0",
      },
      servers: [{ url: `http://${HOST}:${PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });


  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs", // C'est l'adresse web pour ouvrir le Playground
    uiConfig: {
      docExpansion: "list", // Aligne proprement tes routes sous forme de liste
      deepLinking: true,
    },
  });

  // Garde d'auth sur /api/* (avant l'enregistrement des routes).
  registerAuthGuard(app);

  // Santé (publiques, hors /api).
  //Elle permet de se rassurer que le serveur est bien vivant et que l'API Docker est joignable.
  app.get("/health", {schema: {tags: ["health"]},}, async () => ({ ok: true, service: "hullbay" }));
  app.get("/health/docker", {schema: {tags: ["health"]},}, async (_req, reply) => {
    const result = await pingDocker();
    return reply.code(result.ok ? 200 : 503).send(result);
  });

  // Routes métier.
  if (!skipRoutes) {
    await registerAuthRoutes(app);
    await registerSystemRoutes(app);
    await registerProjectRoutes(app);
    await registerReconcilerRoutes(app);
    await registerRegistryRoutes(app);
    await registerServersRoutes(app);
    await registerObservabilityRoutes(app);
    await registerSecretsRoutes(app);
    await registerSettingsRoutes(app);
    await registerUpdatesRoutes(app);
    await registerClustersRoutes(app);
  }

  if (!skipSideEffects) {
    // socket.io attaché au serveur HTTP de Fastify (calque chat-websocket.ts).
    attachWebSocket(app.server);

    // Seed du singleton SystemInfo (version courante = tag déployé via IMAGE_TAG).
    await seedSystemInfo();

    // Reprise des mises à jour orphelines (le process meurt pendant l'update de
    // l'API lui-même — la finalisation success/failed se joue ici, au boot).
    // Le --catch renvoie au prochain boot si la DB est indisponible : on refuse
    // de crash le boot pour une vérification non critique.
    await updaterService.finalizeOrphanUpdates().catch((err) => {
      console.warn(`[updates] finalize orphelines ignoré (DB indisponible ?): ${err}`);
    });

    // Observer Docker (Réel -> canvas live), lecture seule.
    startObserver();

    // Subscribers métier (audit + suivi drift) + jobs périodiques.
    registerDeploySubscribers();
    registerObservabilitySubscribers();
    registerClusterSubscribers();
    startDriftJob();
    startAutoScaler();
  }
  return app;
}

/**
 * Seed du singleton SystemInfo au boot : synchronise la version courante avec le
 * tag d'image déployé (IMAGE_TAG, défaut "unknown" hors conteneur). Ne touche
 * jamais un currentVersion déjà renseigné (sinon on écraserait un tag manuel).
 * "latest" (défaut install.sh) est rejeté : ambigu, casse la comparaison semver
 * — le placeholder est résolu plus tard par UpdaterService.current() vers le
 * tag réellement déployé.
 */
async function seedSystemInfo() {
  const tag = process.env.IMAGE_TAG;
  const version = tag && tag !== "latest" ? tag : "unknown";
  await prisma.systemInfo
    .upsert({
      where: { id: "singleton" },
      create: { id: "singleton", currentVersion: version },
      update: {},
    })
    .catch((err) => {
      console.warn(`[updates] seed SystemInfo ignoré (DB indisponible ?): ${err}`);
    });
}

async function main() {
  const app = await buildApp({ logger: true, skipSideEffects: false });

  await app.listen({ host: HOST, port: PORT });

  const docker = await pingDocker();
  if (!docker.ok) {
    app.log.warn(`[docker] socket inaccessible: ${docker.error}`);
  } else {
    app.log.info(
      `[docker] connecté — v${docker.version} (api ${docker.apiVersion}), ${docker.containers} conteneurs`,
    );
    if (!docker.swarmActive) {
      app.log.warn(
        "[swarm] MODE SWARM INACTIF — les déploiements échoueront. " +
          "Lance `docker swarm init` sur ce serveur.",
      );
    } else {
      app.log.info("[swarm] mode actif — déploiements en services Swarm");
    }
  }
  app.log.info(`hullbay on http://${HOST}:${PORT} (ws path /ws)`);
  return app;
}

async function shutdown(app: FastifyInstance, signal: string): Promise<void> {
  app.log.info(`[shutdown] signal ${signal} reçu, arrêt propre en cours…`);
  stopObserver();
  stopTunnelCleanup();
  closeAllTunnels();
  try {
    await app.close();
  } catch (err) {
    app.log.error(`[shutdown] erreur pendant app.close(): ${err}`);
  }
  process.exit(0);
}

if (process.env.NODE_ENV !== "test") {
  main()
    .then((app) => {
      process.on("SIGTERM", () => void shutdown(app, "SIGTERM"));
      process.on("SIGINT", () => void shutdown(app, "SIGINT"));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
