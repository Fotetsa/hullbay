import { describe, expect, it } from "vitest"
import { isPolicyDue } from "../backup-scheduler"

const at = (iso: string) => new Date(iso)

describe("isPolicyDue", () => {
  it("ne planifie jamais une policy manuelle ou désactivée", () => {
    const now = at("2026-10-25T03:00:00Z")
    expect(
      isPolicyDue({ schedule: "manual", scheduleHourUtc: null, enabled: true }, null, now),
    ).toBe(false)
    expect(
      isPolicyDue({ schedule: "daily", scheduleHourUtc: 2, enabled: false }, null, now),
    ).toBe(false)
  })

  it("attend l'heure planifiée (UTC)", () => {
    const policy = { schedule: "daily", scheduleHourUtc: 2, enabled: true }
    expect(isPolicyDue(policy, null, at("2026-10-25T01:30:00Z"))).toBe(false)
    expect(isPolicyDue(policy, null, at("2026-10-25T02:00:00Z"))).toBe(true)
  })

  it("daily : une seule exécution par jour", () => {
    const policy = { schedule: "daily", scheduleHourUtc: 2, enabled: true }
    const last = at("2026-10-25T02:05:00Z")
    expect(isPolicyDue(policy, last, at("2026-10-25T10:00:00Z"))).toBe(false)
    expect(isPolicyDue(policy, last, at("2026-10-26T02:00:00Z"))).toBe(true)
  })

  it("weekly : pas avant 7 jours", () => {
    const policy = { schedule: "weekly", scheduleHourUtc: 2, enabled: true }
    const last = at("2026-10-18T02:00:00Z")
    expect(isPolicyDue(policy, last, at("2026-10-24T02:00:00Z"))).toBe(false)
    expect(isPolicyDue(policy, last, at("2026-10-25T02:00:00Z"))).toBe(true)
  })

  it("respecte le défaut de 2h UTC quand l'heure est absente", () => {
    const policy = { schedule: "daily", scheduleHourUtc: null, enabled: true }
    expect(isPolicyDue(policy, null, at("2026-10-25T01:59:00Z"))).toBe(false)
    expect(isPolicyDue(policy, null, at("2026-10-25T02:00:00Z"))).toBe(true)
  })
})
