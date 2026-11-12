import type { Subject } from "../engine/types";

/** Seul moyen de fabriquer un Subject dans les tests. Ne jamais l'importer hors de __tests__. */
export const testSubject = (userId: string, tenantId: string): Subject =>
  ({ userId, tenantId }) as Subject;
