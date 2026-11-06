import { describe, expect, it } from "vitest"
import {
  buildRcloneRemoteString,
  buildRemotePath,
  escapeRemoteParam,
  redactRemoteString,
  scrubSecrets,
} from "../remote-string"

const s3 = {
  protocol: "s3" as const,
  bucket: "backups",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "s3cr3t/with:specials,and\\slashes",
  region: "eu-west-3",
  useTls: true,
  pathStyle: false,
}

describe("échappement des paramètres", () => {
  it("neutralise backslash, virgule et deux-points", () => {
    expect(escapeRemoteParam("a,b:c\\d")).toBe("a\\,b\\:c\\\\d")
  })

  it("empêche l'injection d'un paramètre supplémentaire", () => {
    const remote = buildRcloneRemoteString({
      protocol: "s3",
      config: { ...s3, accessKeyId: "AKIA,provider=Evil", secretAccessKey: "s" },
      basePath: "p",
    })
    // La virgule injectée reste DANS la valeur : la chaîne conserve exactement
    // trois paramètres (access_key_id, secret_access_key, region). Le secret est
    // obscurci (jamais en clair), on n'en assert que la forme (base64url).
    expect(remote).toContain("access_key_id=AKIA\\,provider=Evil")
    expect(remote).toMatch(/secret_access_key=[A-Za-z0-9_-]{20,}/)
    expect(remote).toContain("region=eu-west-3:backups/p")
    expect(remote.split(/(?<!\\),/)).toHaveLength(4) // :s3 + 3 paramètres
  })
})

describe("construction de la remote-string", () => {
  it("construit un remote S3 complet", () => {
    const remote = buildRcloneRemoteString({
      protocol: "s3",
      config: s3,
      basePath: "hullbay/prod",
    })
    // Clés non-sensibles présentes ; le secret est obscurci (jamais en clair).
    expect(remote).toContain("access_key_id=AKIAEXAMPLE")
    expect(remote).toContain("region=eu-west-3")
    expect(remote).toContain(":backups/hullbay/prod")
    expect(remote).not.toContain("s3cr3t")
    const m = remote.match(/secret_access_key=([A-Za-z0-9_-]{20,})/)
    expect(m).not.toBeNull()
    expect(m![1]).not.toBe(s3.secretAccessKey)
  })

  it("ajoute provider=Other et le path style pour MinIO", () => {
    const remote = buildRcloneRemoteString({
      protocol: "s3",
      config: {
        ...s3,
        endpoint: "http://minio:9000",
        pathStyle: true,
      },
      basePath: "b",
    })
    expect(remote).toContain("endpoint=http\\://minio\\:9000")
    expect(remote).toContain("provider=Other")
    expect(remote).toContain("force_path_style=true")
  })

  it("passe la clé SSH par un fichier, jamais dans la chaîne", () => {
    const remote = buildRcloneRemoteString({
      protocol: "sftp",
      config: {
        protocol: "sftp",
        host: "storage.example",
        port: 2222,
        username: "backup",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      },
      basePath: "hullbay",
      secretFiles: { privateKey: "/run/secrets/sftp_key" },
    })
    expect(remote).toBe(":sftp,host=storage.example,user=backup,port=2222,key_file=/run/secrets/sftp_key:hullbay")
    expect(remote).not.toContain("PRIVATE KEY")
  })

  it("obscurcit le mot de passe SFTP/WebDAV/SMB (jamais en clair)", () => {
    const sftp = buildRcloneRemoteString({
      protocol: "sftp",
      config: {
        protocol: "sftp",
        host: "storage.example",
        port: 22,
        username: "backup",
        password: "clair",
      },
      basePath: "hullbay",
    })
    expect(sftp).not.toContain("pass=clair")
    expect(sftp).toMatch(/pass=[A-Za-z0-9_-]{20,}/)

    const smb = buildRcloneRemoteString({
      protocol: "smb",
      config: {
        protocol: "smb",
        host: "nas",
        share: "vol",
        username: "u",
        password: "clair",
      },
      basePath: "x",
    })
    expect(smb).not.toContain("pass=clair")
    expect(smb).toMatch(/pass=[A-Za-z0-9_-]{20,}/)
  })

  it("extrait et obscurcit les credentials embarqués dans l'URL WebDAV", () => {
    const remote = buildRcloneRemoteString({
      protocol: "webdav",
      config: {
        protocol: "webdav",
        url: "https://alice:s3cr3t@cloud.example/dav",
        username: "",
        password: "",
      },
      basePath: "b",
    })
    // L'URL finale ne contient plus user:pass@.
    expect(remote).not.toContain("alice:s3cr3t")
    expect(remote).toContain("url=https\\://cloud.example/dav")
    // Les credentials extraits sont routés vers user/pass obscurci.
    expect(remote).toContain("user=alice")
    expect(remote).not.toContain("pass=s3cr3t")
    expect(remote).toMatch(/pass=[A-Za-z0-9_-]{20,}/)
  })

  it("normalise les slashes du chemin distant", () => {
    expect(buildRemotePath("s3", s3, "/a/b/")).toBe("backups/a/b")
    expect(buildRemotePath("smb", { protocol: "smb", host: "nas", share: "vol", username: "u", password: "p" }, "x")).toBe(
      "vol/x",
    )
  })

  it("refuse un protocole incohérent avec la config", () => {
    expect(() =>
      buildRcloneRemoteString({ protocol: "sftp", config: s3, basePath: "x" }),
    ).toThrow(/protocole incohérent/)
  })
})

describe("redaction", () => {
  it("masque les valeurs sensibles et conserve le diagnostic", () => {
    const remote = buildRcloneRemoteString({ protocol: "s3", config: s3, basePath: "p" })
    const safe = redactRemoteString(remote)
    expect(safe).toBe(
      ":s3,access_key_id=***,secret_access_key=***,region=eu-west-3:backups/p",
    )
    expect(safe).not.toContain("AKIAEXAMPLE")
    expect(safe).not.toContain("s3cr3t")
  })

  it("gère une valeur contenant un deux-points échappé", () => {
    const remote = buildRcloneRemoteString({
      protocol: "webdav",
      config: {
        protocol: "webdav",
        url: "https://cloud.example/dav",
        username: "u",
        password: "p:a,ss",
      },
      basePath: "b",
    })
    const safe = redactRemoteString(remote)
    expect(safe).toBe(":webdav,url=https\\://cloud.example/dav,vendor=other,user=u,pass=***:b")
  })

  it("retourne un marqueur pour une chaîne non reconnue", () => {
    expect(redactRemoteString("pas-un-remote")).toBe("[remote masquée]")
  })
})

describe("scrubSecrets", () => {
  it("supprime une remote-string d'un message d'erreur", () => {
    const text = "failed: :s3,access_key_id=AKIA,secret_access_key=x:bucket/path (exit 1)"
    const clean = scrubSecrets(text)
    expect(clean).not.toContain("AKIA")
    expect(clean).toContain("[remote masquée]")
  })

  it("ne confond pas une heure avec un remote", () => {
    expect(scrubSecrets("timeout à 10:30:45")).toBe("timeout à 10:30:45")
  })

  it("masque un mot de passe cité en clair", () => {
    expect(scrubSecrets("login password=hunter2 failed")).toBe("login password=*** failed")
  })
})
