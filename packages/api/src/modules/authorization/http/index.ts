import { fromParam } from './resolvers';
import { evaluateLegacyRole, requireRole } from "../../auth/authorization/rbac";
import { getAuthorization } from "../index";
import { resolveMode, type AuthzMode } from "./mode";
import { consoleLog, createRequirePermission } from "./require-permission"

let cached: AuthzMode | undefined

// Lu une fois, au premier appel.
export const currentMode = (): AuthzMode => (cached ??= resolveMode())

export const requirePermission = createRequirePermission({
    authorization: getAuthorization,
    mode: currentMode,
    evaluateLegacy: evaluateLegacyRole,
    legacyRespond: requireRole,
    log: consoleLog,
})

export { fromParam, fromBody, fromBodyIfPresent } from "./resolvers"