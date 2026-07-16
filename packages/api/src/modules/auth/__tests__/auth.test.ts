import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { buildTestApp } from "../../../__tests__/helpers/build-test-app";
import { authService } from "../service";
import { prisma } from "../../../lib/prisma";
import { verify } from "crypto";
import { email } from "zod/v4";
import { error } from "console";
import { registerAuthGuard, registerAuthRoutes } from "../routes";


//Isolons les tests de la base de données

vi.mock("../service", () => ({
    authService: {
        createOwner: vi.fn(),
        countUsers: vi.fn(),
        login: vi.fn(),
        verifyMfa: vi.fn(),
        startMfaEnrollment: vi.fn(),
        confirmMfaEnrollment: vi.fn(),
        changePassword: vi.fn(),
        listUsers: vi.fn(),
        createUser: vi.fn(),
        setRole: vi.fn(),
        deleteUser: vi.fn(),
        verifyToken: vi.fn(),
    },
}));

vi.mock("../../../lib/prisma", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(),
        },
        auditLog: {
            findMany: vi.fn(),
            count: vi.fn(),
        },
    },
}));

//Simulation de Token pour chaque utilisateur

const mockOwnerToken = "mock_owner_token";
const mockOperatorToken = "mock_operator_token";
const mockViewerToken = "mock_viewer_token";
const mockInvalidToken = "mock_invalid_token";

describe("Auth Routes", () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;

    beforeAll(async () => {
        app = await buildTestApp({
          routes: async (app) => {
            registerAuthGuard(app);
            await registerAuthRoutes(app);
          },
        });
    }, 60000);

    afterAll(async () => {
        if (app) {
            await app.close();
        }
    });

    beforeEach(() => {
        //Reinitialisons tous les mocks avant chaque test
        vi.clearAllMocks();

        //Simulons une authentification en configurant verifyToken pour renvoyer des rôles spécifiques en fonction du token fourni
        vi.mocked(authService.verifyToken).mockImplementation((token: string) => {
            if (token === mockOwnerToken) {
                return { sub: "owner-id", role: "owner" };
            }

            if (token === mockOperatorToken) {
                return { sub: "operator-id", role: "operator" };
            }
            
            if (token === mockViewerToken) {
                return { sub: "viewer-id", role: "viewer" };
            }

            throw new Error("Token invalide");
        });
    });

    /**
     * POST /api/auth/bootstrap
     */

    describe("POST /api/auth/bootstrap", () => {
        it("devrait créer le premier owner avec des donnée valides", async () => {
            vi.mocked(authService.createOwner).mockResolvedValue({ id: "new-owner-id" } as any);

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/bootstrap",
                payload: {
                    email: "fotetsa@gmail.com",
                    password: "F12345678",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true, id: "new-owner-id" });
            expect(authService.createOwner).toHaveBeenLastCalledWith("fotetsa@gmail.com", "F12345678");
        });

        it("devrait retourner 400 si l'email est invalide", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/bootstrap",
                payload: {
                    email: "fotetsagmail.com",
                    password: "F12345678",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toHaveProperty("details");
        });

        it("devrait retourner 400 si le mot de passe est trop court", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/bootstrap",
                payload: {
                    email: "fotetsa@gmail.com",
                    password: "F123",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toHaveProperty("details");
        });

        it("devrait retourner 400 si un champ est manquant", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/bootstrap",
                payload: {
                    email: "fotetsa@gmail.com",
                    //Mot de passe marquant
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toHaveProperty("details");
        });

        it("devrait retourner 409 si un owner existe deja", async () => {
            vi.mocked(authService.createOwner).mockRejectedValue(
                new Error("un compte owner existe deja")
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/bootstrap",
                payload: {
                    email: "fotetsa@gmail.com",
                    password: "F12345678",
                },
            });

            expect(response.statusCode).toBe(409);
            expect(response.json()).toEqual({ error: "un compte owner existe deja" });
        });
    });

    /**
     * GET /api/auth/needs-bootstrap
     */

    describe("GET /api/auth/needs-bootstrap", () => {
        it("devrait retourner true si aucun utilisateur existe deja", async () => {
            vi.mocked(authService.countUsers).mockResolvedValue(0);

            const response = await app.inject({
                method: "GET",
                url: "/api/auth/needs-bootstrap",
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ needsBootstrap: true });
        });

        it("devrait retourner false si un utilisateur existe deja", async () => {
            vi.mocked(authService.countUsers).mockResolvedValue(1);

            const response = await app.inject({
                method: "GET",
                url: "/api/auth/needs-bootstrap",
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ needsBootstrap: false });
        });
    });

    /**
     * POST /api/auth/login
     */

    describe("POST /api/auth/login", () => {
        it("devrait connecter un utilisateur avec des données valides", async () => {
            vi.mocked(authService.login).mockResolvedValue({
                token: "jwt_token",
                mfaRequired: false
            });

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: {
                    email: "fotetsa@gmail.com",
                    password: "F12345678",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ token: "jwt_token", mfaRequired: false });
        });

        it("devrait retourner 401 avec des credentials invalides", async () => {
            vi.mocked(authService.login).mockRejectedValue(
                new Error("Email ou mot de passe incorrect")
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: {
                    email: "bozandoops@gmai.com",
                    password: "F1234567",
                },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "Email ou mot de passe incorrect" });
        });

        it("devrait retourner 400 si l'email est invalide", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: {
                    email: "bozando@gmailcom",
                    password: "F12345678",
                },
            });

            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 400 si le mot de passe est trop court", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: {
                    email: "fotetsa@gmail.com",
                    password: "F123",
                },
            });

            expect(response.statusCode).toBe(400);
        });
    });

    /**
     * POST /api/auth/mfa/verify
     */

    describe("POST /api/auth/mfa/verify", () => {
        it("devrait verifier le code MFA avec succes", async () => {
            vi.mocked(authService.verifyMfa).mockResolvedValue({ token: "final_jwt" });

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/verify",
                payload: {
                    pendingToken: "pending_token_123",
                    code: "123456",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ token: "final_jwt" });
        });

        it("devrait retourner 401 si le code MFA est invalide", async () => {
            vi.mocked(authService.verifyMfa).mockRejectedValue(
                new Error("code MFA invalide")
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/verify",
                payload: {
                    pendingToken: "pending_token_123",
                    code: "000000",
                },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "code MFA invalide" });
        });

        it("devrait retourner 400 si pendingToken est marquant", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/verify",
                payload: {
                    code: "123456",
                },
            });
            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 400 si le code est marquant", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/verify",
                payload: {
                    pendingToken: "pending_token_123",
                },
            });
            expect(response.statusCode).toBe(400);
        });
    });

    /**
     * POST /api/auth/mfa/enroll
     */

    describe("POST /api/auth/mfa/enroll", () => {
        it("devrait démarrer l'enrolement MFA avec un token valide", async () => {
            vi.mocked(authService.startMfaEnrollment).mockResolvedValue({
                secret: "MFA_SECRET",
                otpauth: "data:image/png;base64,...",
            });

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/enroll",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveProperty("secret");
            expect(response.json()).toHaveProperty("otpauth");
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/enroll",
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "non authentifié" });
        });
        it("devrait retourner 401 avec un token inavlide", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/enroll",
                headers: {
                    authorization: `Bearer ${mockInvalidToken}`,
                },
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "token invalide" });
        });
    });

    /**
     * POST /api/auth/mfa/confirm
    */

    describe("POST /api/auth/mfa/confirm", () => {
        it("devrat confirmer l'enrolement MFA avec code validé", async () => {
            vi.mocked(authService.confirmMfaEnrollment).mockResolvedValue({
                ok: true,
            });

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/confirm",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    code: "123456",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true });
        });

        it("devrat retourner 400 si le code est invalide", async () => {
            vi.mocked(authService.confirmMfaEnrollment).mockRejectedValue(
                new Error("Code de confirmation invalide")
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/confirm",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    code: "000000",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: "Code de confirmation invalide" });
        });

        it("devrat retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/mfa/confirm",
                payload: {
                    code: "123456",
                },
            });

            expect(response.statusCode).toBe(401);
        });
    });

    /**
     * GET /api/auth/me
    */
    
    describe("GET /api/auth/me", () => {
        it("devrait retourner le profil de l'utilisateur authentifie", async () => {
            vi.mocked(prisma.user.findUnique).mockResolvedValue({
                id: "owner-id",
                email: "fotetsa@gmail.com",
                role: "owner",
                mfaEnabled: true,
            } as any);

            const response = await app.inject({
                method: "GET",
                url: "/api/auth/me",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                id: "owner-id",
                email: "fotetsa@gmail.com",
                role: "owner",
                mfaEnabled: true,
            });
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/auth/me",
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "non authentifié" });
        });

        it("devrait retourner 401 avec un token invalide", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/auth/me",
                headers: {
                    authorization: `Bearer ${mockInvalidToken}`,
                }
            });

            expect(response.statusCode).toBe(401);
            expect(response.json()).toEqual({ error: "token invalide" });
        });
    });

    /**
     * POST /api/auth/password
    */
    describe("POST /api/auth/password", () => {
        it("devrait changer le mot de passe avec succes", async () => {
            vi.mocked(authService.changePassword).mockResolvedValue({ ok: true });

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/password",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    currentPassword: "F12345678",
                    newPassword: "F1234567",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true });
        });

        it("devrait retourner 400 si le mot de passe actuel est incorrect", async () => {
            vi.mocked(authService.changePassword).mockRejectedValue(
                new Error("Mot de passe actuel incorrect"),
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/auth/password",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    currentPassword: "wrongPassword",
                    newPassword: "newPassword456",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                error: "Mot de passe actuel incorrect",
            });
        });

        it("devrait retourner 400 si le nouveau mot de passe fait moins de 8 caractères", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/password",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    currentPassword: "oldPassword123",
                    newPassword: "123",
                },
            });

            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/auth/password",
                payload: {
                    currentPassword: "oldPassword123",
                    newPassword: "newPassword456",
                },
            });

            expect(response.statusCode).toBe(401);
        });
    });

    /**
     * GET /api/users
    */
    
    describe("GET /api/users", () => {
        it("devrait lister les utilisateurs pour un owner", async () => {
            vi.mocked(authService.listUsers).mockResolvedValue([
              { id: "1", email: "utilisateur1@gmail.com", role: "operator" },
              { id: "2", email: "utilisateur2@gmail.com", role: "viewer" },
            ] as any);

            const response = await app.inject({
                method: "GET",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveLength(2);
        });

        it("devrait retourner 403 pour un operator", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
            });

            expect(response.statusCode).toBe(403);
        });

        it("devrait retourner 403 pour un viewer", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockViewerToken}`,
                },
            });

            expect(response.statusCode).toBe(403);
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/users",
            });

            expect(response.statusCode).toBe(401);
        });
    });

    /**
     * POST /api/users
    */
    
    describe("POST /api/users", () => {
        it("devrait créer un utilisateur avec des données valides", async () => {
            vi.mocked(authService.createUser).mockResolvedValue({
                id: "new-user-id",
                email: "utilisateur1@gmail.com",
                role: "operator",
            });

            const response = await app.inject({
                method: "POST",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    email: "utilisateur1@gmail.com",
                    password: "U12345678",
                    role: "operator",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveProperty("id", "new-user-id");
        });

        it("devrait retourner 400 si l'email est invalide", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    email: "utilisateur1@gmailcom",
                    password: "U12345678",
                    role: "operator",
                },
            });

            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 400 si le rôle est invalide", async () => {
            vi.mocked(authService.createUser).mockReset();
            const response = await app.inject({
                method: "POST",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    email: "utilisateur1@gmail.com",
                    password: "U12345678",
                    role: "viewer",
                },
            });

            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 403 pour un operator", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
                payload: {
                    email: "utilisateur2@gmail.com",
                    password: "U12345678",
                    role: "viewer",
                },
            });

            expect(response.statusCode).toBe(403);
        });

        it("devrait retourner 400 si l'email existe déjà", async () => {
            vi.mocked(authService.createUser).mockRejectedValue(
                new Error("Cet email est déjà utilisé"),
            );

            const response = await app.inject({
                method: "POST",
                url: "/api/users",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    email: "utilisateur1@gmail.com",
                    password: "U12345678",
                    role: "operator",
                },
            });

            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({
                error: "Cet email est déjà utilisé",
            });
        });
    });

    /**
     * POST api/users/:id/role
    */
    describe("POST /api/users/:id/role", () => {
        it("devrait changer le rôle d'un utilisateur", async () => {
            vi.mocked(authService.setRole).mockResolvedValue({
                id: "user-id",
                email: "utilisateur1@gmail.com",
              role: "operator",
            } as any);

            const response = await app.inject({
                method: "POST",
                url: "/api/users/user-id/role",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    role: "operator",
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveProperty("role", "operator");
        });

        it("devrait retourner 400 si le rôle est invalide", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/users/user-id/role",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
                payload: {
                    role: "invalid_role",
                },
            });

            expect(response.statusCode).toBe(400);
        });

        it("devrait retourner 403 pour un operator", async () => {
            const response = await app.inject({
                method: "POST",
                url: "/api/users/user-id/role",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
                payload: {
                    role: "viewer",
                },
            });

            expect(response.statusCode).toBe(403);
        });
    });

    /**
     * DELETE /api/users/:id
    */
    describe("DELETE /api/users/:id", () => {
        it("devrait supprimer un utilisateur", async () => {
            vi.mocked(authService.deleteUser).mockResolvedValue({
              ok: true,
            });

            const response = await app.inject({
                method: "DELETE",
                url: "/api/users/user-id",
                headers: {
                    authorization: `Bearer ${mockOwnerToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ ok: true });
        });

        it("devrait retourner 403 pour un operator", async () => {
            const response = await app.inject({
                method: "DELETE",
                url: "/api/users/user-id",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
            });

            expect(response.statusCode).toBe(403);
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "DELETE",
                url: "/api/users/user-id",
            });

            expect(response.statusCode).toBe(401);
        });
    });

    /**
     * GET /api/audit
    */
    describe("GET /api/audit", () => {
        it("devrait retourner le journal d'audit pour un operator", async () => {
            vi.mocked(prisma.auditLog.findMany).mockResolvedValue([
                {
                    id: "1",
                    action: "deploy",
                    user: { email: "utilisateur1@gmail.com" },
                    projectId: "proj-1",
                    createdAt: new Date(),
                },
            ] as any);
            vi.mocked(prisma.auditLog.count).mockResolvedValue(1);

            const response = await app.inject({
                method: "GET",
                url: "/api/audit",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveProperty("total", 1);
            expect(response.json()).toHaveProperty("entries");
        });

        it("devrait supporter la pagination", async () => {
            vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
            vi.mocked(prisma.auditLog.count).mockResolvedValue(100);

            const response = await app.inject({
                method: "GET",
                url: "/api/audit?limit=10&offset=20",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toHaveProperty("limit", 10);
            expect(response.json()).toHaveProperty("offset", 20);
        });

        it("devrait supporter le filtre par action", async () => {
            vi.mocked(prisma.auditLog.findMany).mockResolvedValue([]);
            vi.mocked(prisma.auditLog.count).mockResolvedValue(5);

            const response = await app.inject({
                method: "GET",
                url: "/api/audit?action=deploy",
                headers: {
                    authorization: `Bearer ${mockOperatorToken}`,
                },
            });

            expect(response.statusCode).toBe(200);
        });

        it("devrait retourner 403 pour un viewer", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/audit",
                headers: {
                    authorization: `Bearer ${mockViewerToken}`,
                },
            });

            expect(response.statusCode).toBe(403);
        });

        it("devrait retourner 401 sans token", async () => {
            const response = await app.inject({
                method: "GET",
                url: "/api/audit",
            });

            expect(response.statusCode).toBe(401);
        });
    });
});
