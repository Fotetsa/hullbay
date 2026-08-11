/**
 * Suivi du drift en mémoire vive (par projet), alimenté par le job de détection
 * périodique (jobs/reconcile-drift.ts). Volontairement séparé d'ObservabilityService
 * (qui lui est désormais lié à un cluster précis via forCluster()) : le drift est
 * un concept par PROJET, jamais par cluster.
 */

const driftByProject = new Map<
  string,
  { count: number; actions: string[]; at: number }
>();

export const driftTracker = {
  record(projectId: string, count: number, actions: string[]): void {
    if (count <= 0) driftByProject.delete(projectId);
    else driftByProject.set(projectId, { count, actions, at: Date.now() });
  },

  clear(projectId: string): void {
    driftByProject.delete(projectId);
  },

  snapshot(): {
    projectId: string;
    count: number;
    actions: string[];
    at: number;
  }[] {
    return Array.from(driftByProject.entries()).map(([projectId, v]) => ({
      projectId,
      ...v,
    }));
  },
};
