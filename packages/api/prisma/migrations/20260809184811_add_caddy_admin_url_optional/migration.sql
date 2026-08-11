/*
  Warnings:

  - Added the required column `caddyAdminUrl` to the `Cluster` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Cluster" ADD COLUMN     "caddyAdminUrl" TEXT NOT NULL;
