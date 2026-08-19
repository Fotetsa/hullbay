import { describe, it, expect, vi } from "vitest";
import { generateToolKeyPair, decryptToolPrivateKey } from "../keys";
import { Client } from "ssh2";

describe("generateToolKeyPair", () => {
  it("génère une clé privée au format openssh-key-v1, jamais PKCS8", () => {
    const pair = generateToolKeyPair();
    const decrypted = decryptToolPrivateKey(pair.privateKeyEnc);
    expect(decrypted).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(decrypted).not.toContain("BEGIN PRIVATE KEY");
  });

  it("génère une clé privée réellement PARSABLE par ssh2 (pas juste le bon en-tête)", () => {
    const pair = generateToolKeyPair();
    const decrypted = decryptToolPrivateKey(pair.privateKeyEnc);
    const client = new Client();

    client.on("error", () => {});

    expect(() => {
      client.connect({
        host: "0.0.0.0",
        port: 1,
        username: "x",
        privateKey: decrypted,
      });
      // On ferme immédiatement pour ne pas laisser de socket ouvert
      setTimeout(() => client.end(), 10);
    }).not.toThrow(/Unsupported key format/);
  });

  it("génère une clé publique au format ssh-ed25519 valide", () => {
    const pair = generateToolKeyPair();
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ hullbay$/);
  });

  it("propage une erreur claire si sshpk échoue à parser (entrée corrompue)", () => {
    const sshpk = require("sshpk");
    vi.spyOn(sshpk, "parsePrivateKey").mockImplementation(() => {
      throw new Error("boom: format non reconnu");
    });
    expect(() => generateToolKeyPair()).toThrow(
      /Échec de conversion de la clé-outil/,
    );
    vi.restoreAllMocks();
  });
});
