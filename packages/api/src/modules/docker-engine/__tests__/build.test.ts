import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { DockerEngineService } from "../service"
import * as fs from "node:fs"
import * as path from "node:path"

const tmpRoot = fs.mkdtempSync(path.join(require("os").tmpdir(), "railpack-test-"))

// For a real clone in tests, create a temporary local git repo and clone via file://

describe("DockerEngineService.buildImageFromRepo (unit)", () => {
  let mockDocker: any

  beforeEach(() => {
    mockDocker = {
      buildImage: vi.fn().mockResolvedValue({}),
      getImage: vi.fn().mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: "sha:123" }) }),
      modem: { followProgress: (stream: any, cb: any) => cb(null) },
    }
  })

  afterEach(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  })

  it("builds an image from a public repo and returns imageTag", async () => {
    // Create a bare repo and push a commit into it from a work repo, so
    // cloning via file:// works reliably in CI.
    const bareRepo = fs.mkdtempSync(path.join(tmpRoot, "repo-bare-"))
    const workRepo = fs.mkdtempSync(path.join(tmpRoot, "repo-work-"))
    const { spawnSync } = await import("node:child_process")
    const r1 = spawnSync("git", ["init", "--bare"], { cwd: bareRepo })
    if (r1.status !== 0) throw new Error(`git init --bare failed: ${r1.stderr?.toString() || r1.stdout?.toString()}`)
    // prepare work repo
    fs.writeFileSync(path.join(workRepo, "Dockerfile"), "FROM alpine\nCMD [\"echo\",\"ok\"]\n")
    const r2 = spawnSync("git", ["init"], { cwd: workRepo })
    if (r2.status !== 0) throw new Error(`git init failed: ${r2.stderr?.toString() || r2.stdout?.toString()}`)
    const r3 = spawnSync("git", ["checkout", "-b", "main"], { cwd: workRepo })
    if (r3.status !== 0) throw new Error(`git checkout -b main failed: ${r3.stderr?.toString() || r3.stdout?.toString()}`)
    const r4 = spawnSync("git", ["add", "--all"], { cwd: workRepo })
    if (r4.status !== 0) throw new Error(`git add failed: ${r4.stderr?.toString() || r4.stdout?.toString()}`)
    const r5 = spawnSync(
      "git",
      ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-m", "init"],
      { cwd: workRepo }
    )
    if (r5.status !== 0) throw new Error(`git commit failed: ${r5.stderr?.toString() || r5.stdout?.toString()}`)
    const r6 = spawnSync("git", ["remote", "add", "origin", bareRepo], { cwd: workRepo })
    if (r6.status !== 0) throw new Error(`git remote add failed: ${r6.stderr?.toString() || r6.stdout?.toString()}`)
    const r7 = spawnSync("git", ["push", "origin", "main"], { cwd: workRepo })
    if (r7.status !== 0) throw new Error(`git push failed: ${r7.stderr?.toString() || r7.stdout?.toString()}`)
    const repoUrl = `file://${bareRepo}`

    const svc = new DockerEngineService(mockDocker as any)
    const result = await svc.buildImageFromRepo(repoUrl, { branch: "main" })
    expect(result.imageTag).toMatch(/^boz_railpack_/)
    expect(mockDocker.buildImage).toHaveBeenCalled()
    expect(result.imageId).toBeDefined()
  })
})
