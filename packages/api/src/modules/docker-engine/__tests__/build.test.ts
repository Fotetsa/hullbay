import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DockerEngineService } from "../service"
import * as fs from "node:fs"
import * as path from "node:path"

describe("DockerEngineService.buildImageFromRepo (unit)", () => {
  const tmpRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "railpack-test-"))
  let mockDocker: any

  beforeEach(() => {
    // mock child_process.spawnSync to simulate `git clone` and `tar`
    vi.mock("node:child_process", () => ({
      spawnSync: (cmd: string, args: string[], opts: any) => {
        if (cmd === "git") {
          // args: [ 'clone', '--depth', '1', '--branch', branch, repoUrl, tmp ]
          const target = args[args.length - 1]
          try {
            fs.mkdirSync(target, { recursive: true })
            fs.writeFileSync(path.join(target, "Dockerfile"), "FROM alpine\nCMD [\"echo\",\"ok\"]\n")
          } catch (e) {}
          return { status: 0, stdout: Buffer.from("") }
        }
        if (cmd === "tar") {
          // return a Buffer as stdout for tar
          return { status: 0, stdout: Buffer.from("fake-tar") }
        }
        return { status: 1 }
      },
    }))

    mockDocker = {
      buildImage: vi.fn().mockResolvedValue({}),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "sha:123" }) }),
      modem: { followProgress: (stream: any, cb: any) => cb(null) },
    }
  })

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true }) } catch {}
    vi.unmock("node:child_process")
  })

  it("builds an image from a public repo and returns imageTag", async () => {
    const svc = new DockerEngineService(mockDocker as any)
    const result = await svc.buildImageFromRepo("https://github.com/example/repo.git", { branch: "main" })
    expect(result.imageTag).toMatch(/^boz_railpack_/) 
    expect(mockDocker.buildImage).toHaveBeenCalled()
    expect(result.imageId).toBeDefined()
  })
})
