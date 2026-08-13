-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dockerHost" TEXT NOT NULL,
    "caddyAdminUrl" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Cluster_name_key" ON "Cluster"("name");


ALTER TABLE "Project" ADD COLUMN "clusterId" TEXT;
ALTER TABLE "Server"  ADD COLUMN "clusterId" TEXT;


INSERT INTO "Cluster" ("id", "name", "dockerHost", "caddyAdminUrl", "isDefault", "updatedAt")
VALUES ('default-cluster', 'Default', 'tcp://socket-proxy:2375', 'http://caddy:2019', true, CURRENT_TIMESTAMP);


UPDATE "Project" SET "clusterId" = 'default-cluster' WHERE "clusterId" IS NULL;
UPDATE "Server"  SET "clusterId" = 'default-cluster' WHERE "clusterId" IS NULL;


ALTER TABLE "Project" ALTER COLUMN "clusterId" SET NOT NULL;
ALTER TABLE "Server"  ALTER COLUMN "clusterId" SET NOT NULL;

ALTER TABLE "Project" ADD CONSTRAINT "Project_clusterId_fkey"
  FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Server" ADD CONSTRAINT "Server_clusterId_fkey"
  FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "Project_clusterId_idx" ON "Project"("clusterId");
CREATE INDEX "Server_clusterId_idx" ON "Server"("clusterId");