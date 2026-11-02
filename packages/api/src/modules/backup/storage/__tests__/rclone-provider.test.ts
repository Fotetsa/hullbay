import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { RcloneStorageProvider, StorageProviderError } from "../rclone-provider"
import { UNPROBED_CAPABILITIES, type StorageCapabilities } from "../types"

/**
 * Faux binaire rclone : vérifie l'interface réelle (argv, stdin, parsing)
 * sans dépendre du réseau ni d'un backend distant.
 */
const SCRIPT = `#!/bin/sh
cmd="$1"
case "$cmd" in
  rcat) cat > "$FAKE_DIR/object" ;;
  cat) cat "$FAKE_DIR/object" ;;
  lsjson)
    if [ "$2" = "--stat" ]; then
      echo '{"Size":5,"ModTime":"2026-10-25T10:00:00Z","IsDir":false}'
    else
      echo '[{"Path":"a.sql.gz","Size":5,"IsDir":false},{"Path":"sub","Size":0,"IsDir":true}]'
    fi ;;
  hashsum) if [ -n "$FAKE_NO_HASH" ]; then exit 1; fi; echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  x" ;;
  deletefile)
    if [ -f "$FAKE_DIR/fail" ]; then
      echo ":s3,access_key_id=AKIAEXAMPLE,secret_access_key=xyz:bucket" >&2
      exit 1
    fi
    rm -f "$FAKE_DIR/object" ;;
  moveto) echo "not supported by this backend" >&2; exit 1 ;;
  *) echo "commande inconnue: $cmd" >&2; exit 2 ;;
esac
`

let dir: string
let binary: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "hullbay-rclone-"))
  binary = path.join(dir, "rclone")
  await writeFile(binary, SCRIPT, "utf8")
  await chmod(binary, 0o755)
  process.env.FAKE_DIR = dir
})

afterAll(async () => {
  delete process.env.FAKE_DIR
  await rm(dir, { recursive: true, force: true })
})

function provider(options: { capabilities?: StorageCapabilities | null } = {}) {
  return new RcloneStorageProvider(":s3,access_key_id=K,secret_access_key=S:bucket", {
    binary,
    timeoutMs: 5000,
    ...options,
  })
}

const CHECKSUM = "a".repeat(64)

describe("RcloneStorageProvider", () => {
  it("écrit via rcat puis relit", async () => {
    const result = await provider().put("dir/a.sql.gz", Buffer.from("hello"))
    expect(result.size).toBe(5)
    expect(await readFile(path.join(dir, "object"), "utf8")).toBe("hello")
  })

  it("liste en ignorant les répertoires", async () => {
    const entries = await provider().list("dir")
    expect(entries).toEqual([
      { key: "dir/a.sql.gz", size: 5, modifiedAt: undefined },
    ])
  })

  it("lit le hash sha256 natif", async () => {
    expect(await provider().hash("dir/a.sql.gz")).toBe("a".repeat(64))
  })

  it("retourne false quand le backend ne supporte pas le rename", async () => {
    expect(await provider().move("a", "b")).toBe(false)
  })

  it("ne laisse jamais fuiter la remote-string dans une erreur", async () => {
    await writeFile(path.join(dir, "fail"), "1")
    try {
      await provider().delete("dir/a.sql.gz")
      throw new Error("aurait dû échouer")
    } catch (err) {
      expect(err).toBeInstanceOf(StorageProviderError)
      expect((err as Error).message).not.toContain("AKIAEXAMPLE")
      expect((err as Error).message).not.toContain("secret_access_key=xyz")
    } finally {
      await rm(path.join(dir, "fail"), { force: true })
    }
  })

  it("ne revendique aucune capacité sans probe", () => {
    expect(provider().capabilities()).toEqual(UNPROBED_CAPABILITIES)
  })

  it("expose la matrice du probe sans la compléter par un fallback", () => {
    const caps: StorageCapabilities = {
      read: true,
      write: true,
      delete: true,
      move: false,
      checksum: false,
      atomicCommit: false,
      serverSideEncryption: false,
    }
    expect(provider({ capabilities: caps }).capabilities()).toEqual(caps)
  })

  it("vérifie la taille puis bascule en copy-verify-delete", async () => {
    const instance = provider()
    await instance.put("staging/object", Buffer.from("hello"))
    const mode = await instance.commitPayload({
      stagingKey: "staging/object",
      finalKey: "final/object",
      expectedChecksum: CHECKSUM,
      expectedSizeBytes: 5,
    })
    expect(mode).toBe("copy-verify-delete")
  })

  it("refuse le commit si la taille distante diffère", async () => {
    const instance = provider()
    await instance.put("staging/object", Buffer.from("hello"))
    await expect(
      instance.commitPayload({
        stagingKey: "staging/object",
        finalKey: "final/object",
        expectedChecksum: CHECKSUM,
        expectedSizeBytes: 6,
      }),
    ).rejects.toMatchObject({ code: "verify_failed" })
  })

  it("vérifie par taille quand le backend n'expose pas de checksum", async () => {
    process.env.FAKE_NO_HASH = "1"
    try {
      const instance = provider()
      await instance.put("staging/object", Buffer.from("hello"))
      const mode = await instance.commitPayload({
        stagingKey: "staging/object",
        finalKey: "final/object",
        expectedChecksum: CHECKSUM,
        expectedSizeBytes: 5,
      })
      // Ni rename ni checksum : la copie reste vérifiable par la taille.
      expect(mode).toBe("copy-verify-delete")
    } finally {
      delete process.env.FAKE_NO_HASH
    }
  })
})
