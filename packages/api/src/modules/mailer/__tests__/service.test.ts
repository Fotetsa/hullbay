import { describe, it, expect } from "vitest"
import { MailerService } from "../service"

describe("MailerService (smoke)", () => {
  it("sanitizes payload", async () => {
    const s = new MailerService()
    // @ts-ignore access private method for test
    const out = (s as any).sanitize({ a: 1, password: "secret", token: "x" })
    expect(out).toEqual({ a: 1 })
  })

  it("renders async template text without leaking Promise objects", async () => {
    const s = new MailerService()
    const out = await (s as any).renderTemplate("async_text", { name: "Ada" })
    expect(typeof out.html).toBe("string")
    expect(typeof out.text).toBe("string")
    expect(out.text).toContain("Ada")
    expect(out.text).not.toContain("[object Promise]")
    expect(out.subject).toBe("Async mail")
  })

  it("uses the requested locale in rendered email templates", async () => {
    const s = new MailerService()
    const out = await (s as any).renderTemplate("mail_test", { locale: "en", name: "Ada", message: "Hello from Hullbay" })
    expect(out.subject).toContain("Email test")
    expect(out.html).toContain("Hello")
    expect(out.html).toContain("Ada")
  })
})
