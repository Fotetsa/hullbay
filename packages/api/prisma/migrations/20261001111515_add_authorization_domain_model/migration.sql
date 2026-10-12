/*
  Warnings:

  - A unique constraint covering the columns `[tenantId,id]` on the table `Membership` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Membership" ADD COLUMN     "roleId" TEXT;

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isPreset" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamRole" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,

    CONSTRAINT "TeamRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyBinding" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "roleId" TEXT,
    "teamId" TEXT,
    "scopeType" TEXT,
    "scopeId" TEXT,

    CONSTRAINT "PolicyBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalGroupMapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "externalGroupName" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalGroupMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Role_tenantId_idx" ON "Role"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_name_key" ON "Role"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Role_tenantId_id_key" ON "Role"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Permission_resource_action_idx" ON "Permission"("resource", "action");

-- CreateIndex
CREATE INDEX "RolePermission_roleId_idx" ON "RolePermission"("roleId");

-- CreateIndex
CREATE INDEX "RolePermission_permissionId_idx" ON "RolePermission"("permissionId");

-- CreateIndex
CREATE INDEX "RolePermission_scopeType_scopeId_idx" ON "RolePermission"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "RolePermission_roleId_permissionId_scopeType_scopeId_key" ON "RolePermission"("roleId", "permissionId", "scopeType", "scopeId");

-- CreateIndex
CREATE INDEX "Team_tenantId_idx" ON "Team"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_name_key" ON "Team"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Team_tenantId_id_key" ON "Team"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TeamMember_tenantId_idx" ON "TeamMember"("tenantId");

-- CreateIndex
CREATE INDEX "TeamMember_membershipId_idx" ON "TeamMember"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_membershipId_key" ON "TeamMember"("teamId", "membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_tenantId_id_key" ON "TeamMember"("tenantId", "id");

-- CreateIndex
CREATE INDEX "TeamRole_tenantId_idx" ON "TeamRole"("tenantId");

-- CreateIndex
CREATE INDEX "TeamRole_teamId_idx" ON "TeamRole"("teamId");

-- CreateIndex
CREATE INDEX "TeamRole_roleId_idx" ON "TeamRole"("roleId");

-- CreateIndex
CREATE INDEX "TeamRole_scopeType_scopeId_idx" ON "TeamRole"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRole_teamId_roleId_scopeType_scopeId_key" ON "TeamRole"("teamId", "roleId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamRole_tenantId_id_key" ON "TeamRole"("tenantId", "id");

-- CreateIndex
CREATE INDEX "Policy_tenantId_idx" ON "Policy"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_tenantId_name_key" ON "Policy"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_tenantId_id_key" ON "Policy"("tenantId", "id");

-- CreateIndex
CREATE INDEX "PolicyBinding_tenantId_idx" ON "PolicyBinding"("tenantId");

-- CreateIndex
CREATE INDEX "PolicyBinding_policyId_idx" ON "PolicyBinding"("policyId");

-- CreateIndex
CREATE INDEX "PolicyBinding_roleId_idx" ON "PolicyBinding"("roleId");

-- CreateIndex
CREATE INDEX "PolicyBinding_teamId_idx" ON "PolicyBinding"("teamId");

-- CreateIndex
CREATE INDEX "PolicyBinding_scopeType_scopeId_idx" ON "PolicyBinding"("scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyBinding_tenantId_id_key" ON "PolicyBinding"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ExternalGroupMapping_tenantId_idx" ON "ExternalGroupMapping"("tenantId");

-- CreateIndex
CREATE INDEX "ExternalGroupMapping_providerId_idx" ON "ExternalGroupMapping"("providerId");

-- CreateIndex
CREATE INDEX "ExternalGroupMapping_teamId_idx" ON "ExternalGroupMapping"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalGroupMapping_tenantId_providerId_externalGroupName_key" ON "ExternalGroupMapping"("tenantId", "providerId", "externalGroupName");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalGroupMapping_tenantId_id_key" ON "ExternalGroupMapping"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_tenantId_id_key" ON "Membership"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_tenantId_teamId_fkey" FOREIGN KEY ("tenantId", "teamId") REFERENCES "Team"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_tenantId_membershipId_fkey" FOREIGN KEY ("tenantId", "membershipId") REFERENCES "Membership"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRole" ADD CONSTRAINT "TeamRole_tenantId_teamId_fkey" FOREIGN KEY ("tenantId", "teamId") REFERENCES "Team"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamRole" ADD CONSTRAINT "TeamRole_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_tenantId_policyId_fkey" FOREIGN KEY ("tenantId", "policyId") REFERENCES "Policy"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_tenantId_roleId_fkey" FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_tenantId_teamId_fkey" FOREIGN KEY ("tenantId", "teamId") REFERENCES "Team"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalGroupMapping" ADD CONSTRAINT "ExternalGroupMapping_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalGroupMapping" ADD CONSTRAINT "ExternalGroupMapping_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AuthProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalGroupMapping" ADD CONSTRAINT "ExternalGroupMapping_tenantId_teamId_fkey" FOREIGN KEY ("tenantId", "teamId") REFERENCES "Team"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
