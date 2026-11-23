import { describe, it, expect } from "vitest";
import { createAuthorization } from "../authorization.service";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import { explain, holds, rightCovers } from "../engine/explain";
import {
  MemoryGrantRepository,
  MemoryResourceRepository,
} from "../repositories/memory";
import type { ResourceRecord } from "../engine/types";
import { testSubject } from "./test-subject";

const T1 = "t1";
const RES: ResourceRecord[] = [
  { type: "cluster", id: "cA", tenantId: T1, parents: {} },
  { type: "cluster", id: "cB", tenantId: T1, parents: {} },
  { type: "project", id: "pA", tenantId: T1, parents: { cluster: "cA" } },
  { type: "project", id: "pB", tenantId: T1, parents: { cluster: "cB" } },
];
const role = (id: string, perms: [string, string, string][]) => ({
  id,
  tenantId: T1,
  name: id,
  isSystem: false,
  permissions: perms.map(([key, scopeType, scopeId]) => ({
    key,
    scopeType,
    scopeId,
  })),
});
const m = {
  id: "m1",
  userId: "u1",
  tenantId: T1,
  legacyRole: "",
  roleId: "r1",
};

const repo = new MemoryGrantRepository({
  memberships: [m],
  roles: [
    role("r1", [
      ["project.deploy", "cluster", "cA"],
      ["project.read", "tenant", T1],
    ]),
    role("r2", [
      ["project.update", "tenant", T1],
      ["audit.read", "tenant", T1],
    ]),
  ],
  teamMembers: [{ teamId: "t", tenantId: T1, membershipId: "m1" }],
  teamRoles: [
    {
      teamId: "t",
      tenantId: T1,
      roleId: "r2",
      scopeType: "project",
      scopeId: "pA",
    },
  ],
});
const authz = createAuthorization({
  grants: repo,
  resources: new MemoryResourceRepository(RES),
});

describe("explain et holds", () => {
  it("expose la provenance de chaque droit", async () => {
    const rights = await explain(repo, m);
    expect(rights.filter((r) => r.via === "direct")).toHaveLength(2);
    expect(rights.find((r) => r.key === "project.update")).toMatchObject({
      via: "team",
      teamId: "t",
      assignmentScope: { scopeType: "project", scopeId: "pA" },
    });
  });

  it("holds : un droit de cluster couvre un projet de ce cluster, pas d'un autre", async () => {
    const rights = await explain(repo, m);
    const target = (id: string) => RES.find((r) => r.id === id)!;
    expect(
      holds(
        rights,
        "project.deploy",
        { scopeType: "project", scopeId: "pA", record: target("pA") },
        T1,
        RESOURCE_CATALOG,
      ),
    ).toBe(true);
    expect(
      holds(
        rights,
        "project.deploy",
        { scopeType: "project", scopeId: "pB", record: target("pB") },
        T1,
        RESOURCE_CATALOG,
      ),
    ).toBe(false);
    expect(
      holds(
        rights,
        "project.deploy",
        { scopeType: "tenant", scopeId: T1 },
        T1,
        RESOURCE_CATALOG,
      ),
    ).toBe(false);
  });

  it("holds : l'intersection permission / attribution d'équipe s'applique", async () => {
    const rights = await explain(repo, m);
    const pA = RES.find((r) => r.id === "pA")!;
    const pB = RES.find((r) => r.id === "pB")!;
    expect(
      holds(
        rights,
        "project.update",
        { scopeType: "project", scopeId: "pA", record: pA },
        T1,
        RESOURCE_CATALOG,
      ),
    ).toBe(true);
    expect(
      holds(
        rights,
        "project.update",
        { scopeType: "project", scopeId: "pB", record: pB },
        T1,
        RESOURCE_CATALOG,
      ),
    ).toBe(false);
  });

  it("cohérence : can() autorise si et seulement si explain() couvre", async () => {
    const rights = await explain(repo, m);
    for (const action of [
      "project.deploy",
      "project.read",
      "project.update",
      "audit.read",
      "cluster.update",
    ]) {
      const entry = RESOURCE_CATALOG.get(action)!;
      const targets = [
        undefined,
        ...RES.filter((r) => entry.resourceTypes.includes(r.type)),
      ];
      for (const res of targets) {
        const expected = rights.some(
          (r) =>
            r.key === action &&
            rightCovers(r, {
              tenantId: T1,
              resource: res,
              accepted: new Set([...entry.scopes, "tenant"]),
            }),
        );
        const d = await authz.can({
          subject: testSubject("u1", T1),
          action,
          resource: res ? { type: res.type, id: res.id } : undefined,
        });
        expect(d.allowed, `${action} ${res?.id ?? "tenant"}`).toBe(expected);
      }
    }
  });
});
