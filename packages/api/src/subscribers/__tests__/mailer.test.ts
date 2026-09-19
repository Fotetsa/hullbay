import { beforeEach, describe, expect, it, vi } from "vitest"
import { eventBus } from "../../lib/event-bus"
import { prisma } from "../../lib/prisma"
import { mailerService } from "../../modules/mailer/service"
import { registerMailSubscribers } from "../mailer"

vi.mock("../../lib/prisma", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}))

vi.mock("../../modules/mailer/service", () => ({
  mailerService: {
    send: vi.fn(),
  },
}))

describe("mailer subscriber user notifications", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerMailSubscribers()
  })

  it("sends user-created emails to owner and new user", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: "owner@hullbay.io" },
    ] as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "alice@hullbay.io",
    } as any)

    await eventBus.emit("user.created", {
      userId: "actor-owner",
      targetUserId: "user-1",
      email: "alice@hullbay.io",
      role: "viewer",
    })

    const recipients = (vi.mocked(mailerService.send) as any).mock.calls.map((call: any) => call[2]?.to)
    expect(recipients).toEqual(expect.arrayContaining(["owner@hullbay.io", "alice@hullbay.io"]))
  })

  it("sends role-change emails only to the affected user", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: "owner@hullbay.io" },
    ] as any)
    ;(vi.mocked(prisma.user.findUnique) as any).mockImplementation(async ({ where }: any) => {
      if (where.id === "actor-owner") return { email: "actor@hullbay.io" }
      if (where.id === "user-1") return { email: "alice@hullbay.io" }
      return null
    })

    await eventBus.emit("user.role.changed", {
      userId: "actor-owner",
      targetUserId: "user-1",
      email: "alice@hullbay.io",
      role: "operator",
    })

    const recipients = (vi.mocked(mailerService.send) as any).mock.calls.map((call: any) => call[2]?.to)
    expect(recipients).toEqual(["alice@hullbay.io"])
  })

  it("sends deletion emails to owner and deleted user when the account is already gone", async () => {
    vi.mocked(prisma.user.findMany).mockResolvedValue([
      { email: "owner@hullbay.io" },
    ] as any)
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null)

    await eventBus.emit("user.deleted", {
      userId: "actor-owner",
      targetUserId: "user-1",
      targetEmail: "alice@hullbay.io",
    })

    const recipients = (vi.mocked(mailerService.send) as any).mock.calls.map((call: any) => call[2]?.to)
    expect(recipients).toEqual(expect.arrayContaining(["owner@hullbay.io", "alice@hullbay.io"]))
  })
})
