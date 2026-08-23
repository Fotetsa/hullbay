import { describe, it, expect } from "vitest"
import { databaseOwnershipLabels, decodeDatabaseParent, isRetainedDataVolume, LabelKeys } from "../labels.js"

const own = {
  parentNodeId: "n_db",
  parentNodeName: "Catalog",
  parentConfig: { engine: "postgres", version: "16.3" },
  role: "member",
  index: 0,
  engine: "postgres",
  data: true,
  retainDataOnDelete: true,
}

describe("databaseOwnershipLabels — garde rétention (spec §30)", () => {
  it("data=true + retainDataOnDelete=true → label bozando.database.data=\"true\"", () => {
    const labels = databaseOwnershipLabels(own)
    expect(labels[LabelKeys.dbData]).toBe("true")
  })

  it("off par défaut de l'utilisateur (false) → AUCUN label data → volume supprimable", () => {
    const labels = databaseOwnershipLabels({ ...own, retainDataOnDelete: false })
    expect(labels[LabelKeys.dbData]).toBeUndefined()
  })

  it("resource non-data (réseau/container) → jamais de label data", () => {
    expect(databaseOwnershipLabels({ ...own, data: false }).dbData).toBeUndefined()
    expect(databaseOwnershipLabels({ ...own, data: false, retainDataOnDelete: true }).dbData).toBeUndefined()
  })

  it("labels d'identité toujours posés (parent, nom, rôle, index, moteur, config)", () => {
    const labels = databaseOwnershipLabels({ ...own, retainDataOnDelete: false })
    expect(labels[LabelKeys.dbParent]).toBe("n_db")
    expect(labels[LabelKeys.dbParentName]).toBe("Catalog")
    expect(labels[LabelKeys.dbRole]).toBe("member")
    expect(labels[LabelKeys.dbIndex]).toBe("0")
    expect(labels[LabelKeys.dbEngine]).toBe("postgres")
    const decoded = JSON.parse(
      Buffer.from(labels[LabelKeys.dbParentConfig]!, "base64").toString("utf8")
    )
    expect(decoded.engine).toBe("postgres")
    expect(decoded.version).toBe("16.3")
  })

  it("config encodée sans secret jamais en clair (passwordSecretRef uniquement)", () => {
    const labels = databaseOwnershipLabels({
      ...own,
      parentConfig: {
        engine: "postgres",
        credentials: { passwordSecretRef: "db_secret", password: "hunter2" },
      },
    })
    expect(labels[LabelKeys.dbParentConfig]).not.toContain("hunter2")
  })
})

describe("decodeDatabaseParent — reconstruction du nœud database (rebuild)", () => {
  it("decode l'identité + la config parent depuis les labels d'une ressource générée", () => {
    const labels = databaseOwnershipLabels(own)
    const p = decodeDatabaseParent(labels)
    expect(p).toEqual({
      parentNodeId: "n_db",
      parentNodeName: "Catalog",
      engine: "postgres",
      parentConfig: { engine: "postgres", version: "16.3" },
    })
  })

  it("null sur une ressource sans parent database (nœud régulier)", () => {
    expect(decodeDatabaseParent({ managed: "true", nodeType: "container" })).toBeNull()
    expect(decodeDatabaseParent(undefined)).toBeNull()
  })

  it("parentConfig null (label illisible) → nœud reconstruit dégradé", () => {
    const labels = databaseOwnershipLabels(own)
    labels[LabelKeys.dbParentConfig] = "!!not-base64-json!!"
    const p = decodeDatabaseParent(labels)
    expect(p!.parentConfig).toBeNull()
  })
})

describe("isRetainedDataVolume — garde unique des 3 chemins de suppression (spec §30)", () => {
  it("true uniquement si le label data vaut littéralement \"true\"", () => {
    expect(isRetainedDataVolume({ [LabelKeys.dbData]: "true" })).toBe(true)
    expect(isRetainedDataVolume({ [LabelKeys.dbData]: "false" })).toBe(false)
    expect(isRetainedDataVolume({})).toBe(false)
  })

  it("labels absents (volume normal / non-managé) → jamais retenu", () => {
    expect(isRetainedDataVolume(undefined)).toBe(false)
    expect(isRetainedDataVolume(null)).toBe(false)
    expect(isRetainedDataVolume({ [LabelKeys.managed]: "true" })).toBe(false)
  })

  it("consistant avec databaseOwnershipLabels (opt-out = aucun label data)", () => {
    const retained = databaseOwnershipLabels(own)
    expect(isRetainedDataVolume(retained)).toBe(true)
    const optOut = databaseOwnershipLabels({ ...own, retainDataOnDelete: false })
    expect(isRetainedDataVolume(optOut)).toBe(false)
    const nonData = databaseOwnershipLabels({ ...own, data: false })
    expect(isRetainedDataVolume(nonData)).toBe(false)
  })
})