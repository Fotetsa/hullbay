import { describe, expect, it } from "vitest"
import { assertSafeScope, buildRetentionScript } from "../retention"

const scope = {
  basePath: "hullbay/prod",
  projectSlug: "shop",
  targetName: "orders-db",
  retentionDays: 30,
}

describe("assertSafeScope", () => {
  it("construit un préfixe borné", () => {
    expect(assertSafeScope(scope)).toBe("hullbay/prod/shop/orders-db")
  })

  it("refuse un préfixe vide", () => {
    expect(() =>
      assertSafeScope({ ...scope, basePath: "", projectSlug: "", targetName: "" }),
    ).toThrow(/préfixe de rétention invalide/)
  })

  it("refuse une traversée de chemin", () => {
    expect(() =>
      assertSafeScope({ ...scope, targetName: "../.." }),
    ).toThrow(/préfixe de rétention invalide/)
  })

  it("refuse une rétention non entière ou nulle", () => {
    expect(() => assertSafeScope({ ...scope, retentionDays: 0 })).toThrow(/rétention invalide/)
    expect(() => assertSafeScope({ ...scope, retentionDays: 1.5 })).toThrow(/rétention invalide/)
  })
})

describe("buildRetentionScript", () => {
  it("borne la suppression au préfixe avec --min-age", () => {
    const script = buildRetentionScript("hullbay/shop/orders-db", 30, true)
    expect(script).toContain('TARGET="$REMOTE/hullbay/shop/orders-db"')
    expect(script).toContain('rclone delete "$TARGET" --min-age 30d')
  })

  it("est en dry-run par défaut", () => {
    expect(buildRetentionScript("p", 7, true)).toContain("--dry-run")
  })

  it("n'ajoute --dry-run que si demandé", () => {
    expect(buildRetentionScript("p", 7, false)).not.toContain("--dry-run")
  })

  it("refuse un préfixe terminé par un slash au niveau du script", () => {
    expect(buildRetentionScript("p", 7, false)).toContain('case "$TARGET" in ""|*/)')
  })
})
