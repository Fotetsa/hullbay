import { describe, it, expect } from "vitest"
import { ContainerStateTracker } from "../state-tracker"

describe("ContainerStateTracker", () => {
  it("suit le cycle de vie d'un conteneur unique (créé -> running -> exited -> missing)", () => {
    const t = new ContainerStateTracker()
    expect(t.apply("c1", "n1", "created")).toBe("created")
    expect(t.apply("c1", "n1", "running")).toBe("running")
    expect(t.apply("c1", "n1", "exited")).toBe("exited")
    expect(t.apply("c1", "n1", "missing")).toBe("missing")
  })

  it("ne ré-émet pas un état inchangé (dédup par nœud)", () => {
    const t = new ContainerStateTracker()
    expect(t.apply("c1", "n1", "running")).toBe("running")
    expect(t.apply("c1", "n1", "running")).toBeNull()
    expect(t.apply("c2", "n1", "running")).toBeNull()
  })

  it("rolling update start-first : l'ancien conteneur qui meurt ne fait pas tomber l'état", () => {
    const t = new ContainerStateTracker()
    expect(t.apply("old", "n1", "created")).toBe("created")
    expect(t.apply("old", "n1", "running")).toBe("running")
    // nouveau conteneur créé et démarré
    expect(t.apply("new", "n1", "created")).toBeNull() // created < running
    expect(t.apply("new", "n1", "running")).toBeNull() // toujours running
    // l'ancien est arrêté puis détruit
    expect(t.apply("old", "n1", "exited")).toBeNull() // running gagne
    expect(t.apply("old", "n1", "missing")).toBeNull() // running gagne
    expect(t.resolve("n1")).toBe("running")
  })

  it("crash réel : tous les conteneurs du nœud éteints -> exited ressort", () => {
    const t = new ContainerStateTracker()
    t.apply("c1", "n1", "running")
    expect(t.apply("c1", "n1", "exited")).toBe("exited")
  })

  it("replicas : un replica en panne ne fait pas tomber le nœud tant qu'un autre tourne", () => {
    const t = new ContainerStateTracker()
    t.apply("c1", "n1", "running")
    expect(t.apply("c2", "n1", "running")).toBeNull()
    expect(t.apply("c2", "n1", "exited")).toBeNull() // c1 running encore
    expect(t.apply("c1", "n1", "exited")).toBe("exited") // plus rien
    expect(t.apply("c1", "n1", "missing")).toBeNull() // c2 exited déjà
    expect(t.apply("c2", "n1", "missing")).toBe("missing") // plus aucun conteneur
  })

  it("destroy du service -> missing après disparition du dernier conteneur", () => {
    const t = new ContainerStateTracker()
    t.apply("c1", "n1", "running")
    expect(t.apply("c1", "n1", "missing")).toBe("missing")
  })

  it("clearNode purge tous les conteneurs du nœud", () => {
    const t = new ContainerStateTracker()
    t.apply("c1", "n1", "running")
    t.apply("c2", "n1", "running")
    t.apply("c3", "n2", "running")
    expect(t.clearNode("n1")).toBe("missing")
    expect(t.clearNode("n1")).toBeNull() // déjà missing
    expect(t.resolve("n2")).toBe("running")
  })

  it("un conteneur 'missing' est oublié, pas conservé comme exited", () => {
    const t = new ContainerStateTracker()
    t.apply("c1", "n1", "running")
    t.apply("c1", "n1", "exited")
    // le conteneur est détruit
    expect(t.apply("c1", "n1", "missing")).toBe("missing")
    // nouveau conteneur sur le même nœud : repart de zéro
    expect(t.apply("c2", "n1", "created")).toBe("created")
  })
})
