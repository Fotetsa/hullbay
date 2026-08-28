-- CreateTable
CREATE TABLE "RailpackImage" (
    "id" TEXT NOT NULL,
    "repoUrl" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "imageTag" TEXT NOT NULL,
    "imageId" TEXT,
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "builtById" TEXT,
    "clusterId" TEXT NOT NULL,
    "nodesHavingImage" JSONB,

    CONSTRAINT "RailpackImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RailpackImage_imageTag_key" ON "RailpackImage"("imageTag");

-- CreateIndex
CREATE INDEX "RailpackImage_repoUrl_ref_idx" ON "RailpackImage"("repoUrl", "ref");

-- AddForeignKey
ALTER TABLE "RailpackImage" ADD CONSTRAINT "RailpackImage_builtById_fkey" FOREIGN KEY ("builtById") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RailpackImage" ADD CONSTRAINT "RailpackImage_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
