import { describe, expect, it } from "vitest"

import { isValidSecretName, parseEnvContent } from "./envParser"

describe("env parser", () => {
  it("accepte les noms de secrets valides", () => {
    expect(isValidSecretName("JWT_SECRET")).toBe(true)
    expect(isValidSecretName("DB_HOST")).toBe(true)
    expect(isValidSecretName("APP-1")).toBe(true)
    expect(isValidSecretName("token.value")).toBe(true)
  })

  it("rejette les noms invalides", () => {
    expect(isValidSecretName("")).toBe(false)
    expect(isValidSecretName("mounir@abu.com")).toBe(false)
    expect(isValidSecretName("my secret")).toBe(false)
    expect(isValidSecretName("foo/bar")).toBe(false)
    expect(isValidSecretName("..")).toBe(false)
    expect(isValidSecretName("abc..def")).toBe(false)
    expect(isValidSecretName("  JWT_SECRET  ")).toBe(true)
  })

  it("ignore les valeurs non valides selon les contraintes de secrets", () => {
    const entries = parseEnvContent("JWT_SECRET=demo\nEMAIL=hello@example.com\nSPACE KEY=value\n")

    expect(entries).toEqual([
      { key: "JWT_SECRET", value: "demo" },
      { key: "EMAIL", value: "hello@example.com" },
      { key: "SPACE KEY", value: "value" },
    ])
  })
})
