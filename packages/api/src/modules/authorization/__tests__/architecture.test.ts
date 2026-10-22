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

  it("aucune comparaison avec les rôles historiques hors du résolveur legacy", () => {
    const names = /["'`](owner|operator|viewer)["'`]/i;
    for (const file of tsFiles(ROOT)) {
      if (file.endsWith("legacy-role-resolver.ts")) continue;
      expect(readFileSync(file, "utf8"), file).not.toMatch(names);
    }
  });

  it("le catalogue a des clés resource.action et des scopes valides", () => {
    expect(RESOURCE_CATALOG.size).toBe(50);
    for (const [key, entry] of RESOURCE_CATALOG) {
      expect(key).toMatch(/^[a-z]+(\.[a-z]+)+$/);
      for (const s of [...entry.scopes, ...entry.resourceTypes])
        expect(isValidScopeType(s)).toBe(true);
    }
  });
});
