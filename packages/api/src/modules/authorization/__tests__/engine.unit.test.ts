import { describe, it, expect } from "vitest";
import { createAuthorization } from "../authorization.service";
import { ForbiddenError } from "../errors";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
  type MemoryGrantData,
} from "../repositories/memory";
import type {
  GrantRepository,
  PolicyEvaluator,
  ResourceRecord,
  RoleRecord,
} from "../engine/types";
import { subjectFromSession } from "../subject";

const T1 = "t1";
const T2 = "t2";

const role = (
  id: string,
  name: string,
  perms: [string, string, string][],
  extra: Partial<RoleRecord & { isPreset: boolean }> = {},
) => ({
  id,
  tenantId: T1,
  name,
  isSystem: false,
  permissions: perms.map(([key, scopeType, scopeId]) => ({
    key,
    scopeType,
    scopeId,
  })),
  ...extra,
});

const tenantWide = (key: string): [string, string, string] => [
  key,
  "tenant",
  T1,
];

const RESOURCES: ResourceRecord[] = [
  { type: "cluster", id: "c1", tenantId: T1, parents: {} },
  { type: "cluster", id: "c2", tenantId: T1, parents: {} },
  { type: "cluster", id: "cx", tenantId: T2, parents: {} },
  { type: "project", id: "p1", tenantId: T1, parents: { cluster: "c1" } },
  { type: "project", id: "p2", tenantId: T1, parents: { cluster: "c1" } },
  { type: "project", id: "p3", tenantId: T1, parents: { cluster: "c2" } },
  { type: "server", id: "s1", tenantId: T1, parents: { cluster: "c1" } },
  {
    type: "node",
    id: "n1",
    tenantId: T1,
    parents: { project: "p1", cluster: "c1" },
  },
];
const HIER: ResourceRecord[] = [
  { type: "cluster", id: "cA", tenantId: T1, parents: {} },
  { type: "cluster", id: "cB", tenantId: T1, parents: {} },
  { type: "project", id: "pA", tenantId: T1, parents: { cluster: "cA" } },
  { type: "project", id: "pB", tenantId: T1, parents: { cluster: "cB" } },
];

function build(
  partial: Partial<MemoryGrantData> = {},
  policies?: PolicyEvaluator,
) {
  const data: MemoryGrantData = {
    memberships: [
      { id: "m1", userId: "u1", tenantId: T1, legacyRole: "", roleId: null },
    ],
    roles: [],
    teamMembers: [],
    teamRoles: [],
    ...partial,
  };
  const grants = new MemoryGrantRepository(data);
  const authz = createAuthorization({
    grants,
    resources: new MemoryResourceRepository(RESOURCES),
    policies,
  });
  return { authz, data };
}
function buildHier(partial: Partial<MemoryGrantData>) {
  const data: MemoryGrantData = {
    memberships: [
      { id: "m1", userId: "u1", tenantId: T1, legacyRole: "", roleId: null },
    ],
    roles: [],
    teamMembers: [],
    teamRoles: [],
    ...partial,
  };
  return createAuthorization({
    grants: new MemoryGrantRepository(data),
    resources: new MemoryResourceRepository(HIER),
  });
}

const subject = { userId: "u1", tenantId: T1 };
const direct = (r: ReturnType<typeof role>, m = {}) => ({
  memberships: [
    {
      id: "m1",
      userId: "u1",
      tenantId: T1,
      legacyRole: "",
      roleId: r.id,
      ...m,
    },
  ],
  roles: [r],
});
const deployP = (id: string) => ({
  subject,
  action: "project.deploy",
  resource: { type: "project" as const, id },
});

describe("moteur : refus par défaut et entrées invalides", () => {
  it("sans aucun droit : refus", async () => {
    const { authz } = build();
    expect(await authz.can({ subject, action: "project.read" })).toMatchObject({
      allowed: false,
      reason: "no_grant",
    });
  });

  it("permission inconnue", async () => {
    const { authz } = build();
    expect((await authz.can({ subject, action: "nope.nope" })).reason).toBe(
      "unknown_permission",
    );
    expect((await authz.can({ subject, action: "constructor" })).reason).toBe(
      "unknown_permission",
    );
  });

  it("aucune adhésion dans le tenant", async () => {
    const { authz } = build();
    const d = await authz.can({
      subject: { userId: "u1", tenantId: T2 },
      action: "project.read",
    });
    expect(d.reason).toBe("no_membership");
  });

  it("type de ressource non prévu pour l'action", async () => {
    const r = role("r1", "R", [tenantWide("project.deploy")]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "cluster", id: "c1" },
    });
    expect(d.reason).toBe("invalid_resource");
  });
});

describe("moteur : sources de droits", () => {
  it("rôle direct", async () => {
    const r = role("r1", "Custom", [tenantWide("project.read")]);
    const { authz } = build(direct(r));
    const d = await authz.can({ subject, action: "project.read" });
    expect(d.allowed).toBe(true);
    expect(d.sources[0]).toMatchObject({ via: "direct", roleId: "r1" });
  });

  it("rôle via une équipe", async () => {
    const r = role("r1", "Dev", [tenantWide("project.read")]);
    const { authz } = build({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "tenant",
          scopeId: T1,
        },
      ],
    });
    const d = await authz.can({ subject, action: "project.read" });
    expect(d.allowed).toBe(true);
    expect(d.sources[0]).toMatchObject({ via: "team", teamId: "tm1" });
  });

  it("plusieurs rôles : union des permissions", async () => {
    const a = role("ra", "A", [tenantWide("project.read")]);
    const b = role("rb", "B", [tenantWide("audit.read")]);
    const { authz } = build({
      memberships: [
        { id: "m1", userId: "u1", tenantId: T1, legacyRole: "", roleId: "ra" },
      ],
      roles: [a, b],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "rb",
          scopeType: "tenant",
          scopeId: T1,
        },
      ],
    });
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      true,
    );
    expect((await authz.can({ subject, action: "audit.read" })).allowed).toBe(
      true,
    );
    expect((await authz.can({ subject, action: "user.delete" })).allowed).toBe(
      false,
    );
  });

  it("plusieurs équipes", async () => {
    const a = role("ra", "A", [tenantWide("project.read")]);
    const b = role("rb", "B", [tenantWide("audit.read")]);
    const { authz } = build({
      roles: [a, b],
      teamMembers: [
        { teamId: "t-a", tenantId: T1, membershipId: "m1" },
        { teamId: "t-b", tenantId: T1, membershipId: "m1" },
      ],
      teamRoles: [
        {
          teamId: "t-a",
          tenantId: T1,
          roleId: "ra",
          scopeType: "tenant",
          scopeId: T1,
        },
        {
          teamId: "t-b",
          tenantId: T1,
          roleId: "rb",
          scopeType: "tenant",
          scopeId: T1,
        },
      ],
    });
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      true,
    );
    expect((await authz.can({ subject, action: "audit.read" })).allowed).toBe(
      true,
    );
  });

  it("retrait de l'équipe : le droit disparaît", async () => {
    const r = role("r1", "Dev", [tenantWide("project.read")]);
    const { authz, data } = build({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "tenant",
          scopeId: T1,
        },
      ],
    });
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      true,
    );
    data.teamMembers = [];
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("rôle supprimé : aucun droit résiduel, pas de repli legacy", async () => {
    const r = role("r1", "Custom", [tenantWide("project.read")]);
    const preset = role("rp", "Viewer", [tenantWide("project.read")], {
      isPreset: true,
    });
    const { authz, data } = build({
      memberships: [
        {
          id: "m1",
          userId: "u1",
          tenantId: T1,
          legacyRole: "viewer",
          roleId: "r1",
        },
      ],
      roles: [r, preset],
    });
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      true,
    );
    data.roles = data.roles.filter((x) => x.id !== "r1");
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("rôle d'un autre tenant ignoré", async () => {
    const foreign = role("rf", "F", [tenantWide("project.read")], {
      tenantId: T2,
    });
    const { authz } = build({
      memberships: [
        { id: "m1", userId: "u1", tenantId: T1, legacyRole: "", roleId: "rf" },
      ],
      roles: [foreign],
    });
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });
});

describe("moteur : scopes", () => {
  it("scope ressource correct puis incorrect", async () => {
    const r = role("r1", "Dev", [["project.deploy", "project", "p1"]]);
    const { authz } = build(direct(r));
    const ok = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p1" },
    });
    const ko = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p2" },
    });
    expect(ok.allowed).toBe(true);
    expect(ko).toMatchObject({ allowed: false, reason: "scope_not_covered" });
  });

  it("couverture descendante autorisée par le catalogue (cluster couvre ses projets)", async () => {
    const r = role("r1", "Dev", [["project.deploy", "cluster", "c1"]]);
    const { authz } = build(direct(r));
    const inC1 = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p1" },
    });
    const inC2 = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p3" },
    });
    expect(inC1.allowed).toBe(true);
    expect(inC2.allowed).toBe(false);
  });

  it("descendante refusée quand le catalogue ne la prévoit pas (server.promote)", async () => {
    const r = role("r1", "Ops", [["server.promote", "cluster", "c1"]]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "server.promote",
      resource: { type: "server", id: "s1" },
    });
    expect(d).toMatchObject({ allowed: false, reason: "scope_not_covered" });
  });

  it("un droit sur un projet ne donne jamais le droit sur son cluster", async () => {
    const r = role("r1", "Dev", [["cluster.update", "project", "p1"]]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "cluster.update",
      resource: { type: "cluster", id: "c1" },
    });
    expect(d.allowed).toBe(false);
  });

  it("action sans ressource : seul le scope tenant couvre", async () => {
    const r = role("r1", "Ops", [["cluster.update", "cluster", "c1"]]);
    const { authz } = build(direct(r));
    expect(
      (await authz.can({ subject, action: "cluster.update" })).allowed,
    ).toBe(false);
  });

  it("le scope tenant couvre toute ressource du tenant", async () => {
    const r = role("r1", "All", [tenantWide("project.deploy")]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p3" },
    });
    expect(d.allowed).toBe(true);
  });

  it("scope tenant d'un autre tenant : ne couvre rien", async () => {
    const r = role("r1", "X", [["project.read", "tenant", T2]]);
    const { authz } = build(direct(r));
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("scope de type inconnu ignoré", async () => {
    const r = role("r1", "X", [["project.read", "galaxy", "g1"]]);
    const { authz } = build(direct(r));
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("rôle d'équipe : le périmètre d'attribution restreint le rôle", async () => {
    const r = role("r1", "Dev", [tenantWide("project.deploy")]);
    const { authz } = build({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "project",
          scopeId: "p1",
        },
      ],
    });
    const ok = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p1" },
    });
    const ko = await authz.can({
      subject,
      action: "project.deploy",
      resource: { type: "project", id: "p2" },
    });
    expect(ok.allowed).toBe(true);
    expect(ko.allowed).toBe(false);
  });
});

describe("moteur : tenant et ressource", () => {
  it("ressource d'un autre tenant : tenant_mismatch", async () => {
    const r = role("r1", "All", [tenantWide("cluster.read")]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "cluster.read",
      resource: { type: "cluster", id: "cx" },
    });
    expect(d.reason).toBe("tenant_mismatch");
  });

  it("ressource inexistante", async () => {
    const r = role("r1", "All", [tenantWide("cluster.read")]);
    const { authz } = build(direct(r));
    const d = await authz.can({
      subject,
      action: "cluster.read",
      resource: { type: "cluster", id: "zzz" },
    });
    expect(d.reason).toBe("resource_not_found");
  });
});

describe("moteur : rôle système et legacy", () => {
  it("un rôle système sans permission ne donne rien, même attribué", async () => {
    const root = role("rr", "Root", [], { isSystem: true });
    const { authz } = build(direct(root));
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("un rôle système n'a aucun traitement spécial : il vaut ses permissions", async () => {
    const sys = role("rs", "Sys", [tenantWide("audit.read")], {
      isSystem: true,
    });
    const { authz } = build(direct(sys));
    expect((await authz.can({ subject, action: "audit.read" })).allowed).toBe(
      true,
    );
    expect((await authz.can({ subject, action: "user.delete" })).allowed).toBe(
      false,
    );
  });

  it("repli legacy vers le preset du même nom", async () => {
    const viewer = role("rv", "Viewer", [tenantWide("project.read")], {
      isPreset: true,
    });
    const { authz } = build({
      memberships: [
        {
          id: "m1",
          userId: "u1",
          tenantId: T1,
          legacyRole: "viewer",
          roleId: null,
        },
      ],
      roles: [viewer],
    });
    const d = await authz.can({ subject, action: "project.read" });
    expect(d.allowed).toBe(true);
    expect(d.sources[0]?.via).toBe("legacy");
    expect(
      (await authz.can({ subject, action: "project.deploy" })).allowed,
    ).toBe(false);
  });

  it("legacy : preset absent, valeur inconnue ou rôle non preset : aucun droit", async () => {
    const custom = role("rc", "Operator", [tenantWide("project.deploy")]); // pas isPreset
    const { authz } = build({
      memberships: [
        {
          id: "m1",
          userId: "u1",
          tenantId: T1,
          legacyRole: "operator",
          roleId: null,
        },
      ],
      roles: [custom],
    });
    expect(
      (await authz.can({ subject, action: "project.deploy" })).allowed,
    ).toBe(false);

    const { authz: a2 } = build({
      memberships: [
        {
          id: "m1",
          userId: "u1",
          tenantId: T1,
          legacyRole: "n'importe quoi",
          roleId: null,
        },
      ],
      roles: [],
    });
    expect((await a2.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });
});

describe("moteur : fail closed et policies", () => {
  it("une exception interne donne un refus, et require lève ForbiddenError", async () => {
    const broken: GrantRepository = {
      findMembership: async () => {
        throw new Error("base indisponible");
      },
      findRole: async () => null,
      findPresetRoleByName: async () => null,
      listTeamRoleAssignments: async () => [],
    };
    const authz = createAuthorization({
      grants: broken,
      resources: new MemoryResourceRepository([]),
    });
    const d = await authz.can({ subject, action: "project.read" });
    expect(d).toMatchObject({ allowed: false, reason: "internal_error" });
    await expect(
      authz.require({ subject, action: "project.read" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("un deny de policy l'emporte sur le RBAC", async () => {
    const r = role("r1", "All", [tenantWide("project.read")]);
    const denyAll: PolicyEvaluator = { evaluate: async () => "deny" };
    const { authz } = build(direct(r), denyAll);
    expect(await authz.can({ subject, action: "project.read" })).toMatchObject({
      allowed: false,
      reason: "policy_denied",
    });
  });

  it("un allow de policy ne crée aucun droit", async () => {
    const allowAll: PolicyEvaluator = { evaluate: async () => "allow" };
    const { authz } = build({}, allowAll);
    expect((await authz.can({ subject, action: "project.read" })).allowed).toBe(
      false,
    );
  });

  it("une erreur de policy donne un refus", async () => {
    const r = role("r1", "All", [tenantWide("project.read")]);
    const boom: PolicyEvaluator = {
      evaluate: async () => {
        throw new Error("x");
      },
    };
    const { authz } = build(direct(r), boom);
    expect((await authz.can({ subject, action: "project.read" })).reason).toBe(
      "internal_error",
    );
  });

  it("require retourne la décision quand c'est autorisé", async () => {
    const r = role("r1", "All", [tenantWide("project.read")]);
    const { authz } = build(direct(r));
    await expect(
      authz.require({ subject, action: "project.read" }),
    ).resolves.toMatchObject({ allowed: true });
  });
});

describe("cross-scope : être dans le même tenant ne franchit jamais un scope plus étroit", () => {
  it("permission scopée au cluster A : projet A autorisé, projet B refusé", async () => {
    const r = role("r1", "Dev", [["project.deploy", "cluster", "cA"]]);
    const authz = buildHier(direct(r));
    expect((await authz.can(deployP("pA"))).allowed).toBe(true);
    expect(await authz.can(deployP("pB"))).toMatchObject({
      allowed: false,
      reason: "scope_not_covered",
    });
  });

  it("permission scopée au projet A : projet B refusé", async () => {
    const r = role("r1", "Dev", [["project.deploy", "project", "pA"]]);
    const authz = buildHier(direct(r));
    expect((await authz.can(deployP("pA"))).allowed).toBe(true);
    expect(await authz.can(deployP("pB"))).toMatchObject({
      allowed: false,
      reason: "scope_not_covered",
    });
  });

  it("périmètre d'attribution d'équipe = projet A : projet B refusé", async () => {
    // Le rôle porte la permission sur tout le tenant, mais l'équipe le reçoit seulement sur pA.
    const r = role("r1", "Dev", [tenantWide("project.deploy")]);
    const authz = buildHier({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "project",
          scopeId: "pA",
        },
      ],
    });
    expect((await authz.can(deployP("pA"))).allowed).toBe(true);
    expect(await authz.can(deployP("pB"))).toMatchObject({
      allowed: false,
      reason: "scope_not_covered",
    });
  });

  it("périmètre d'attribution d'équipe = cluster A : projet B refusé", async () => {
    const r = role("r1", "Dev", [tenantWide("project.deploy")]);
    const authz = buildHier({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "cluster",
          scopeId: "cA",
        },
      ],
    });
    expect((await authz.can(deployP("pA"))).allowed).toBe(true);
    expect((await authz.can(deployP("pB"))).allowed).toBe(false);
  });

  it("intersection : permission sur le projet A, équipe attribuée sur le projet B : refus des deux", async () => {
    const r = role("r1", "Dev", [["project.deploy", "project", "pA"]]);
    const authz = buildHier({
      roles: [r],
      teamMembers: [{ teamId: "tm1", tenantId: T1, membershipId: "m1" }],
      teamRoles: [
        {
          teamId: "tm1",
          tenantId: T1,
          roleId: "r1",
          scopeType: "project",
          scopeId: "pB",
        },
      ],
    });
    expect((await authz.can(deployP("pA"))).allowed).toBe(false);
    expect((await authz.can(deployP("pB"))).allowed).toBe(false);
  });
});

describe("Subject : le tenant vient de la session, jamais du client", () => {
  it("subjectFromSession ne lit que la session", () => {
    expect(subjectFromSession({ sub: "u1", tenantId: T1 })).toEqual({
      userId: "u1",
      tenantId: T1,
    });
  });

  it("session sans tenant ou sans identifiant : refusée, pas de tenant par défaut", () => {
    expect(() => subjectFromSession({ sub: "u1" })).toThrow();
    expect(() => subjectFromSession({ sub: "", tenantId: T1 })).toThrow();
    expect(() => subjectFromSession(null)).toThrow();
    expect(() => subjectFromSession(undefined)).toThrow();
  });

  it("un tenant glissé dans la session par le client ne remplace pas le tenant authentifié", () => {
    // Simule des champs client (body/query) mélangés à la session : seuls sub et
    // tenantId de la session sont lus, le reste est ignoré.
    const polluted = {
      sub: "u1",
      tenantId: T1,
      body: { tenantId: T2 },
      query: { tenantId: T2 },
    };
    expect(subjectFromSession(polluted).tenantId).toBe(T1);
  });
});

describe("contrat public de require()", () => {
  it("autorisé : retourne exactement la décision de can()", async () => {
    const r = role("r1", "All", [tenantWide("project.read")]);
    const { authz } = build(direct(r));
    const input = { subject, action: "project.read" };
    expect(await authz.require(input)).toEqual(await authz.can(input));
  });

  it("refusé : lève ForbiddenError avec reason et sources de la décision de can()", async () => {
    const r = role("r1", "Dev", [["project.deploy", "project", "p1"]]);
    const { authz } = build(direct(r));
    const input = {
      subject,
      action: "project.deploy",
      resource: { type: "project" as const, id: "p2" },
    };
    const decision = await authz.can(input);
    expect(decision.allowed).toBe(false);

    const err = await authz.require(input).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.statusCode).toBe(403);
    expect(err.decision).toEqual(decision);
    expect(err.decision.reason).toBe("scope_not_covered");
  });

  it("refus par policy : les sources retenues sont conservées dans l'erreur", async () => {
    const r = role("r1", "All", [tenantWide("project.read")]);
    const { authz } = build(direct(r), { evaluate: async () => "deny" });
    const err = await authz
      .require({ subject, action: "project.read" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenError);
    expect(err.decision.reason).toBe("policy_denied");
    expect(err.decision.sources[0]).toMatchObject({
      roleId: "r1",
      via: "direct",
    });
  });

  it("require n'a pas de logique propre : même résultat que can() sur tous les cas de refus", async () => {
    const { authz } = build();
    for (const action of ["nope.nope", "project.read", "cluster.create"]) {
      const d = await authz.can({ subject, action });
      const e = await authz.require({ subject, action }).catch((x) => x);
      expect(e).toBeInstanceOf(ForbiddenError);
      expect(e.decision).toEqual(d);
    }
  });
});
