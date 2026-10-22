import { prisma } from "../../lib/prisma";
import {
  createAuthorization,
  type Authorization,
} from "./authorization.service";
import {
  PrismaGrantRepository,
  PrismaResourceRepository,
} from "./repositories/prisma";

export { createAuthorization } from "./authorization.service";
export type { Authorization } from "./authorization.service";
export { ForbiddenError } from "./errors";
export type { CanInput, Decision, Subject, Resource } from "./engine/types";
export { subjectFromSession } from "./subject";
export type { AuthenticatedSession } from "./subject";

let instance: Authorization | undefined;

/** Instance branchée sur Prisma. Aucune route ne l'appelle encore. */
export function getAuthorization(): Authorization {
  instance ??= createAuthorization({
    grants: new PrismaGrantRepository(prisma),
    resources: new PrismaResourceRepository(prisma),
    onError: (err) =>
      console.error("[authorization] erreur interne, accès refusé :", err),
  });
  return instance;
}
