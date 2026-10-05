import assert from "node:assert/strict"
import test from "node:test"

import { isValidSecretName, parseEnvContent } from "./envParser"

test("isValidSecretName accepte les noms de secrets valides", () => {
  assert.equal(isValidSecretName("JWT_SECRET"), true)
  assert.equal(isValidSecretName("DB_HOST"), true)
  assert.equal(isValidSecretName("APP-1"), true)
  assert.equal(isValidSecretName("token.value"), true)
})

test("isValidSecretName rejette les noms invalides", () => {
  assert.equal(isValidSecretName(""), false)
  assert.equal(isValidSecretName("mounir@abu.com"), false)
  assert.equal(isValidSecretName("my secret"), false)
  assert.equal(isValidSecretName("foo/bar"), false)
})

test("parseEnvContent ignore les valeurs non valides selon les contraintes de secrets", () => {
  const entries = parseEnvContent("JWT_SECRET=demo\nEMAIL=hello@example.com\nSPACE KEY=value\n")

  assert.deepEqual(entries, [
    { key: "JWT_SECRET", value: "demo" },
    { key: "EMAIL", value: "hello@example.com" },
    { key: "SPACE KEY", value: "value" },
  ])
})
