import { describe, it, expect, vi, beforeEach } from "vitest"
import { TEMPLATES, getTemplate, listTemplates } from "../templates"
import { ResendProvider } from "../providers/resend.provider"
import { SmtpProvider } from "../providers/smtp.provider"

describe("Mailer Module - React Email Templates", () => {
  it("liste tous les templates enregistrés avec métadonnées", () => {
    const list = listTemplates()
    expect(list.length).toBeGreaterThanOrEqual(4)
    const ids = list.map((t) => t.id)
    expect(ids).toContain("deploy.finished")
    expect(ids).toContain("auth.login")
    expect(ids).toContain("password.changed")
    expect(ids).toContain("mail.test")
    expect(ids).toContain("drift.alert")
  })

  it("rend le template de déploiement réussi avec dummy data", async () => {
    const tpl = getTemplate("deploy.finished")
    expect(tpl).toBeDefined()

    const html = await tpl!.renderHtml(tpl!.previewProps)
    expect(html).toContain("HULLBAY OPS")
    expect(html).toContain("DÉPLOIEMENT RÉUSSI")
    expect(html).toContain("API Production &amp; Cache")

    const text = await tpl!.renderText(tpl!.previewProps)
    expect(text).toContain("API PRODUCTION")
  })

  it("rend le template de déploiement échoué avec rapport d'incident détaillé", async () => {
    const tpl = getTemplate("deploy.finished")
    expect(tpl).toBeDefined()
    expect(tpl!.additionalPreviews).toBeDefined()

    const failedProps = tpl!.additionalPreviews!["Échec (erreur d'image ou tunnel)"]
    expect(failedProps).toBeDefined()

    const html = await tpl!.renderHtml(failedProps)
    expect(html).toContain("DÉPLOIEMENT ÉCHOUÉ")
    expect(html).toContain("Base de Données Analytics")
    expect(html).toContain("DeployError")
  })

  it("rend le template de test mail avec Dummy Data", async () => {
    const tpl = getTemplate("mail.test")
    expect(tpl).toBeDefined()

    const html = await tpl!.renderHtml(tpl!.previewProps)
    expect(html).toContain("intégration E-mail")
    expect(html).toContain("RESEND")
  })
})

describe("Mailer Providers", () => {
  it("ResendProvider gère l'envoi et traite les erreurs HTTP proprement", async () => {
    const provider = new ResendProvider({ apiKey: "re_fake_12345" })

    // Mock du fetch global
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "msg_abc123" }),
    } as Response)

    const res = await provider.send({
      to: "operator@hullbay.io",
      subject: "Test Resend",
      html: "<p>Hello</p>",
      from: "notifications@hullbay.io",
    })

    expect(fetchMock).toHaveBeenCalled()
    expect(res.ok).toBe(true)
    expect(res.messageId).toBe("msg_abc123")

    fetchMock.mockRestore()
  })

  it("ResendProvider gère les erreurs de l'API (401 / 422)", async () => {
    const provider = new ResendProvider({ apiKey: "re_invalid" })

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ message: "Invalid API key" }),
    } as Response)

    const res = await provider.send({
      to: "operator@hullbay.io",
      subject: "Test",
      html: "<p>Hello</p>",
      from: "notifications@hullbay.io",
    })

    expect(res.ok).toBe(false)
    expect(res.error).toContain("Invalid API key")

    fetchMock.mockRestore()
  })

  it("chiffre et masque les identifiants de configuration mailer", async () => {
    const { mailerService } = await import("../service")
    const { prisma } = await import("../../../lib/prisma")

    // Mock Prisma pour ce test unitaire
    const mockRow = {
      tenantId: "tenant_test",
      provider: "RESEND",
      enabled: true,
      fromEmail: "ops@hullbay.io",
      fromName: "Hullbay Ops",
      replyTo: "support@hullbay.io",
      configEnc: "",
    }

    vi.spyOn(prisma.mailIntegration, "upsert").mockImplementation(((args: any) => {
      mockRow.configEnc = args.create.configEnc
      return Promise.resolve(mockRow)
    }) as any)

    vi.spyOn(prisma.mailIntegration, "findUnique").mockImplementation((() => {
      return Promise.resolve(mockRow)
    }) as any)

    // Sauvegarde avec clé en clair
    await mailerService.saveConfig("tenant_test", {
      provider: "RESEND",
      enabled: true,
      fromEmail: "ops@hullbay.io",
      fromName: "Hullbay Ops",
      resend: { apiKey: "re_secret_key_123456" },
    })

    // La clé stockée dans mockRow.configEnc DOIT être chiffrée (ne doit pas contenir "re_secret_key_123456")
    expect(mockRow.configEnc).not.toContain("re_secret_key_123456")

    // Lors de la récupération pour l'UI, elle doit être masquée
    const config = await mailerService.getConfig("tenant_test")
    expect(config?.resend?.apiKey).toContain("••••••••")
    expect(config?.resend?.apiKey).not.toContain("re_secret_key_123456")
  })
})
