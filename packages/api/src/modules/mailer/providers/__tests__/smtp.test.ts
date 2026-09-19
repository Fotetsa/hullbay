import { describe, it, expect } from "vitest"
import { createTransportFromConfig } from "../smtp"

describe("SMTP provider (skeleton)", () => {
  it("creates a transport object", () => {
    const t = createTransportFromConfig({ host: "smtp.example.com", port: 587 })
    expect(t).toBeTruthy()
  })
})
