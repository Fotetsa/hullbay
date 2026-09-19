export async function sendViaResend(
  config: Record<string, unknown> & { apiKey?: string; from?: string },
  payload: { from?: string; to: string; subject: string; html?: string; text?: string },
) {
  const apiKey = config.apiKey
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error("resend apiKey missing")
  }

  const url = "https://api.resend.com/emails"
  const body = {
    from: payload.from ?? config.from ?? "noreply@example.com",
    to: payload.to,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  }

  // Temporary debug logging to help diagnose API shape / status issues.
  // Do NOT log the API key.
  try {
    console.debug("[resend] POST", url)
    console.debug("[resend] request body (no key):", JSON.stringify(body))
  } catch (e) {
    // ignore logging errors
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    try {
      console.error("[resend] response status:", res.status, "body:", txt)
    } catch (e) {}
    throw new Error(`resend send failed: ${res.status} ${txt}`)
  }
  const out = await res.json().catch(() => null)
  try {
    console.debug("[resend] response ok:", out)
  } catch (e) {}
  return out
}
