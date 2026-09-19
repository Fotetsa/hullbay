-- CreateTable
CREATE TABLE "MailIntegration" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "configEnc" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailIntegration_pkey" PRIMARY KEY ("id")
);
