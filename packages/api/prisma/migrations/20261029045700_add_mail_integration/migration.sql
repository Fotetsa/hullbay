-- CreateEnum
CREATE TYPE "MailProviderType" AS ENUM ('RESEND', 'SMTP');

-- CreateTable
CREATE TABLE "MailIntegration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "MailProviderType" NOT NULL DEFAULT 'RESEND',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "fromEmail" TEXT,
    "fromName" TEXT DEFAULT 'Hullbay Ops',
    "replyTo" TEXT,
    "configEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailIntegration_tenantId_key" ON "MailIntegration"("tenantId");

-- CreateIndex
CREATE INDEX "MailIntegration_tenantId_idx" ON "MailIntegration"("tenantId");

-- AddForeignKey
ALTER TABLE "MailIntegration" ADD CONSTRAINT "MailIntegration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
