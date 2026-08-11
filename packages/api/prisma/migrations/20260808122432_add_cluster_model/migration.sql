/*
  Warnings:

  - Added the required column `clusterId` to the `Project` table without a default value. This is not possible if the table is not empty.
  - Added the required column `clusterId` to the `Server` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "clusterId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "clusterId" TEXT NOT NULL;

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dockerHost" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Cluster_name_key" ON "Cluster"("name");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Server" ADD CONSTRAINT "Server_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;
