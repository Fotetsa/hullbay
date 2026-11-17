export class AdminError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

export const notFound = () =>
  new AdminError(404, "not_found", "ressource introuvable");
export const systemRole = () =>
  new AdminError(
    409,
    "system_role",
    "un rôle système ne peut pas être modifié, supprimé ni attribué",
  );

/** P2002 (unicité) devient un 409 ; toute autre erreur est conservée. */
export function mapUnique(
  err: unknown,
  code: string,
  message: string,
): unknown {
  return (err as { code?: string })?.code === "P2002"
    ? new AdminError(409, code, message)
    : err;
}
