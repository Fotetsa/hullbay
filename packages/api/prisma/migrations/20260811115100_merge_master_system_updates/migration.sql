-- CreateTable
CREATE TABLE "SystemInfo" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "currentVersion" TEXT NOT NULL DEFAULT 'unknown',
    "updateChannel" TEXT NOT NULL DEFAULT 'stable',
    "lastCheckAt" TIMESTAMP(3),
    "lastCheckResult" JSONB,
    "channelHistory" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemInfo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemUpdate" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "steps" JSONB NOT NULL DEFAULT '[]',
    "logs" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "rolledBack" BOOLEAN NOT NULL DEFAULT false,
    "rollbackOfId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "triggeredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemUpdate_status_idx" ON "SystemUpdate"("status");

-- CreateIndex
CREATE INDEX "SystemUpdate_createdAt_idx" ON "SystemUpdate"("createdAt");

-- CreateIndex
CREATE INDEX "SystemUpdate_rollbackOfId_idx" ON "SystemUpdate"("rollbackOfId");

-- AddForeignKey
ALTER TABLE "SystemUpdate" ADD CONSTRAINT "SystemUpdate_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
