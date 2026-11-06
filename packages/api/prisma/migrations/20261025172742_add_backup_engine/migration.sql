-- CreateEnum
CREATE TYPE "BackupTargetKind" AS ENUM ('postgres', 'mysql', 'mongodb', 'redis', 'volume');

-- CreateEnum
CREATE TYPE "BackupRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupRunPhase" AS ENUM ('resolving', 'extracting', 'transferring', 'verifying', 'committing', 'retention', 'done');

-- CreateEnum
CREATE TYPE "BackupProtocol" AS ENUM ('s3', 'sftp', 'webdav', 'smb', 'gcs', 'azureblob');

-- CreateTable
CREATE TABLE "BackupTarget" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "kind" "BackupTargetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupDestination" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "BackupProtocol" NOT NULL,
    "configEncrypted" TEXT NOT NULL,
    "basePath" TEXT NOT NULL,
    "capabilitiesJson" JSONB,
    "lastTestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupPolicy" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "schedule" TEXT NOT NULL DEFAULT 'manual',
    "scheduleHourUtc" INTEGER,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "verification" TEXT NOT NULL DEFAULT 'checksum',
    "encryptionMode" TEXT NOT NULL DEFAULT 'none',
    "placementJson" JSONB,
    "timeoutSec" INTEGER NOT NULL DEFAULT 1800,
    "maxConcurrency" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lockedBy" TEXT,
    "lockExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BackupPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "status" "BackupRunStatus" NOT NULL,
    "phase" "BackupRunPhase" NOT NULL DEFAULT 'resolving',
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sizeBytes" BIGINT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "taskId" TEXT,

    CONSTRAINT "BackupRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupArtifact" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "destinationId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "manifestJson" JSONB NOT NULL,
    "payloadFormat" TEXT NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "engine" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "committedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackupArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackupTarget_projectId_idx" ON "BackupTarget"("projectId");

-- CreateIndex
CREATE INDEX "BackupTarget_tenantId_idx" ON "BackupTarget"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BackupTarget_nodeId_kind_key" ON "BackupTarget"("nodeId", "kind");

-- CreateIndex
CREATE INDEX "BackupDestination_tenantId_idx" ON "BackupDestination"("tenantId");

-- CreateIndex
CREATE INDEX "BackupDestination_projectId_idx" ON "BackupDestination"("projectId");

-- CreateIndex
CREATE INDEX "BackupPolicy_targetId_idx" ON "BackupPolicy"("targetId");

-- CreateIndex
CREATE INDEX "BackupPolicy_enabled_idx" ON "BackupPolicy"("enabled");

-- CreateIndex
CREATE INDEX "BackupRun_policyId_startedAt_idx" ON "BackupRun"("policyId", "startedAt");

-- CreateIndex
CREATE INDEX "BackupRun_status_idx" ON "BackupRun"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BackupArtifact_runId_key" ON "BackupArtifact"("runId");

-- CreateIndex
CREATE INDEX "BackupArtifact_targetId_committedAt_idx" ON "BackupArtifact"("targetId", "committedAt");

-- AddForeignKey
ALTER TABLE "BackupTarget" ADD CONSTRAINT "BackupTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupTarget" ADD CONSTRAINT "BackupTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupTarget" ADD CONSTRAINT "BackupTarget_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupDestination" ADD CONSTRAINT "BackupDestination_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupPolicy" ADD CONSTRAINT "BackupPolicy_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "BackupTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupPolicy" ADD CONSTRAINT "BackupPolicy_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupRun" ADD CONSTRAINT "BackupRun_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "BackupPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupArtifact" ADD CONSTRAINT "BackupArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BackupRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupArtifact" ADD CONSTRAINT "BackupArtifact_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "BackupTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackupArtifact" ADD CONSTRAINT "BackupArtifact_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
