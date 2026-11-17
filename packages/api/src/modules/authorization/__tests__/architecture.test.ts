import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { RESOURCE_CATALOG } from "../catalog/resource-catalog";
import { isValidScopeType } from "../scope";

const ROOT = path.resolve(__dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory())
      return name === "__tests__" ? [] : tsFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("architecture", () => {
  it("engine/ n'importe ni Prisma, ni Fastify, ni l'authentification", () => {
    const forbidden =
      /from\s+["'](@prisma\/client|fastify[^"']*|[^"']*lib\/prisma|[^"']*modules\/auth[^"']*|[^"']*repositories\/prisma)["']/;
    for (const file of tsFiles(path.join(ROOT, "engine"))) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(forbidden);
    }
  });

    it("aucune comparaison avec les rôles historiques hors résolveur legacy et admin/routes.ts", () => {
      const names = /["'`](owner|operator|viewer)["'`]/i;
      for (const file of tsFiles(ROOT)) {
        if (
          file.endsWith("legacy-role-resolver.ts") ||
          file.endsWith("admin/routes.ts")
        )
          continue;
        expect(readFileSync(file, "utf8"), file).not.toMatch(names);
      }
    });

    it("le catalogue compte 72 permissions et correspond aux clés de presets.mjs", async () => {
      const { ALL_KEYS } = await import("../presets.mjs");
      expect(RESOURCE_CATALOG.size).toBe(72);
      expect([...RESOURCE_CATALOG.keys()].sort()).toEqual([...ALL_KEYS].sort());
    });

    it("admin/ n'importe pas Fastify (hors routes.ts)", () => {
      for (const file of tsFiles(path.join(ROOT, "admin"))) {
        if (file.endsWith("routes.ts")) continue;
        expect(readFileSync(file, "utf8"), file).not.toMatch(
          /from\s+["']fastify/,
        );
      }
    });

  it("le domaine backup est déclaré dans le catalogue", () => {
    for (const key of [
      "backup.destination.read", "backup.destination.set", "backup.destination.delete",
      "backup.policy.read", "backup.policy.create", "backup.policy.update", "backup.policy.delete",
      "backup.run", "backup.artifact.read", "backup.artifact.restore",
    ]) {
      expect(RESOURCE_CATALOG.has(key), key).toBe(true);
    }
  });

  it("http/ n'importe pas Prisma (seul http/index.ts branche l'instance réelle)", () => {
    for (const file of tsFiles(path.join(ROOT, "http"))) {
      if (file.endsWith("index.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /@prisma\/client|lib\/prisma/,
      );
    }
  });
});
