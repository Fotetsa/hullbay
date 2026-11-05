-- AlterTable
ALTER TABLE "BackupTarget" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "BackupTarget_nodeId_archived_idx" ON "BackupTarget"("nodeId", "archived");
