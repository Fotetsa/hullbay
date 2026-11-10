import type { FastifyReply, FastifyRequest } from "fastify";
import type { Role } from "../../auth/authorization/rbac";
import type { Authorization } from "../authorization.service";
import type { Decision, Resource, Subject } from "../engine/types";
import { subjectFromSession, type AuthenticatedSession } from "../subject";
import type { AuthzMode } from "./mode";
import type { ResourceExtractor } from "./resolvers";
import { outcomeFor } from "./response";
import { divergenceOf } from "./shadow-report";

declare module "fastify" {
  interface FastifyRequest {
    /** Décision du moteur (reason et sources), côté serveur uniquement, jamais dans le corps. */
    authzDecision?: Decision;
  }
}

export type GuardLogEntry = Record<string, unknown>;

export type GuardDeps = {
  authorization: () => Authorization;
  mode: () => AuthzMode;
  evaluateLegacy: (req: FastifyRequest, min: Role) => Promise<boolean>;
  legacyRespond?: (
    min: Role,
  ) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  log: (level: "warn" | "error", entry: GuardLogEntry) => void;
};

export type RequirePermissionOptions = {
  resource?: ResourceExtractor;
  legacyMin: Role;
};

export function consoleLog(
  level: "warn" | "error",
  entry: GuardLogEntry,
): void {
  const line = JSON.stringify({
    scope: "authorization",
    level,
    ts: new Date().toISOString(),
    ...entry,
  });
  if (level === "error") console.error(line);
  else console.warn(line);
}

const FORBIDDEN = { error: "permission insuffisante" };

type EngineResult =
  | { kind: "session_invalid" }
  | { kind: "context_mismatch"; subject: Subject }
  | {
      kind: "decision";
      subject: Subject;
      resource?: Resource;
      decision: Decision;
    };

const internalError = (): Decision => ({
  allowed: false,
  reason: "internal_error",
  sources: [],
});

export function createRequirePermission(deps: GuardDeps) {
  async function runEngine(
    req: FastifyRequest,
    session: AuthenticatedSession,
    action: string,
    options: RequirePermissionOptions,
  ): Promise<EngineResult> {
    let subject: Subject;
    try {
      subject = subjectFromSession(session);
    } catch {
      return { kind: "session_invalid" };
    }
    // Le tenant des données (req.tenantId, éventuellement issu d'un en-tête) doit être
      // celui de la session : on n'autorise jamais avec un tenant et on lit l'autre.
      const reqWithTenant = req as unknown as { tenantId?: string };
    if (reqWithTenant.tenantId && reqWithTenant.tenantId !== subject.tenantId)
      return { kind: "context_mismatch", subject };

    let resource: Resource | undefined;
    try {
      resource = await options.resource?.(req);
    } catch {
      return { kind: "decision", subject, decision: internalError() };
    }
    try {
      const decision = await deps
        .authorization()
        .can({ subject, action, resource });
      return { kind: "decision", subject, resource, decision };
    } catch {
      return { kind: "decision", subject, resource, decision: internalError() };
    }
  }

  const entryOf = (
    req: FastifyRequest,
    action: string,
    mode: AuthzMode,
    extra: GuardLogEntry,
  ): GuardLogEntry => ({
    route: req.routeOptions?.url ?? "inconnue",
    method: req.method,
    action,
    mode,
    ...extra,
  });

  return function requirePermission(
    action: string,
    options: RequirePermissionOptions,
  ) {
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const session = (req as FastifyRequest & { user?: AuthenticatedSession })
        .user;
      if (!session) return reply.code(401).send({ error: "non authentifié" });

      const mode = deps.mode();

      if (mode === "legacy") {
        if (deps.legacyRespond)
          return deps.legacyRespond(options.legacyMin)(req, reply);
        if (!(await deps.evaluateLegacy(req, options.legacyMin)))
          return reply.code(403).send(FORBIDDEN);
        return;
      }

      if (mode === "shadow") {
        // Le legacy décide ; le moteur est évalué à côté, sans jamais changer la réponse.
        const legacyAllowed = await deps.evaluateLegacy(req, options.legacyMin);
        const result = await runEngine(req, session, action, options);
        const engineAllowed =
          result.kind === "decision" && result.decision.allowed;
        const divergence = divergenceOf(legacyAllowed, engineAllowed);
        if (divergence) {
          deps.log(
            divergence === "engine_more_permissive" ? "error" : "warn",
            entryOf(req, action, mode, {
              divergence,
              legacyAllowed,
              engineAllowed,
              userId: session.sub,
              tenantId: session.tenantId,
              reason:
                result.kind === "decision"
                  ? result.decision.reason
                  : result.kind,
            }),
          );
        }
        if (result.kind === "decision" && result.decision.allowed)
          req.authzDecision = result.decision;
        if (!legacyAllowed) return reply.code(403).send(FORBIDDEN);
        return;
      }

      const result = await runEngine(req, session, action, options);
      if (result.kind === "session_invalid") {
        return reply
          .code(401)
          .send({ error: "session invalide", code: "session_invalid" });
      }
      if (result.kind === "context_mismatch") {
        deps.log(
          "warn",
          entryOf(req, action, mode, {
            reason: "context_tenant_mismatch",
            userId: result.subject.userId,
            tenantId: result.subject.tenantId,
          }),
        );
        return reply.code(403).send(FORBIDDEN);
      }

      const outcome = outcomeFor(result.decision);
      if (!outcome) {
        req.authzDecision = result.decision;
        return;
      }
      const serverSide =
        result.decision.reason === "unknown_permission" ||
        result.decision.reason === "internal_error";
      deps.log(
        serverSide ? "error" : "warn",
        entryOf(req, action, mode, {
          userId: result.subject.userId,
          tenantId: result.subject.tenantId,
          resource: result.resource,
          reason: result.decision.reason,
        }),
      );
      return reply.code(outcome.status).send(outcome.body);
    };
    return Object.assign(handler, { authzAction: action, legacyMin: options.legacyMin})
  };
}
