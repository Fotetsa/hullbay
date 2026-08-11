-- Traçabilité du rollback : l'update d'origine réussie est marquée annulée
-- (rolledBack) et le rollback crée un NOUVEL enregistrement lié à l'update
-- source (rollbackOfId). L'historique de l'update est ainsi préservé.
ALTER TABLE "SystemUpdate" ADD COLUMN "rolledBack" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SystemUpdate" ADD COLUMN "rollbackOfId" TEXT;
CREATE INDEX "SystemUpdate_rollbackOfId_idx" ON "SystemUpdate"("rollbackOfId");
