import type { Decision } from "./engine/types";

/** Levée par require() quand la décision est un refus. Porte la décision pour l'audit futur. */
export class ForbiddenError extends Error {
  readonly statusCode = 403;
  constructor(public readonly decision: Decision) {
    super("permission insuffisante");
    this.name = "ForbiddenError";
  }
}
