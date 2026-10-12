-- 1. Membership.roleId : à la suppression d'un rôle, seul roleId passe à NULL
ALTER TABLE "Membership" DROP CONSTRAINT "Membership_tenantId_roleId_fkey";
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_tenantId_roleId_fkey"
  FOREIGN KEY ("tenantId", "roleId") REFERENCES "Role"("tenantId", "id")
  ON DELETE SET NULL ("roleId") ON UPDATE CASCADE;

-- 2. Une policy doit être liée à un rôle ou à une équipe
ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_has_target"
  CHECK ("roleId" IS NOT NULL OR "teamId" IS NOT NULL);

-- 3. Effet d'une policy limité à allow ou deny
ALTER TABLE "Policy" ADD CONSTRAINT "Policy_effect_valid"
  CHECK ("effect" IN ('allow', 'deny'));

-- 4. Protection technique des rôles système (Root)
CREATE OR REPLACE FUNCTION protect_system_role() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- La suppression en cascade d'un tenant reste permise : le tenant a déjà disparu.
    IF OLD."isSystem" AND EXISTS (SELECT 1 FROM "Tenant" WHERE id = OLD."tenantId") THEN
      RAISE EXCEPTION 'Le rôle système % ne peut pas être supprimé', OLD.name;
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."isSystem" AND (
       NEW."isSystem" IS DISTINCT FROM OLD."isSystem"
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
  ) THEN
    RAISE EXCEPTION 'Le rôle système % ne peut pas être modifié', OLD.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER role_protect_system
  BEFORE UPDATE OR DELETE ON "Role"
  FOR EACH ROW EXECUTE FUNCTION protect_system_role();

-- 5. Les permissions d'un rôle système ne peuvent pas être modifiées
CREATE OR REPLACE FUNCTION protect_system_role_permissions() RETURNS trigger AS $$
DECLARE
  target_role text;
BEGIN
  target_role := COALESCE(NEW."roleId", OLD."roleId");
  -- Si le rôle n'existe plus (suppression en cascade), on laisse passer.
  IF EXISTS (SELECT 1 FROM "Role" WHERE id = target_role AND "isSystem") THEN
    RAISE EXCEPTION 'Les permissions d''un rôle système ne peuvent pas être modifiées';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rolepermission_protect_system
  BEFORE INSERT OR UPDATE OR DELETE ON "RolePermission"
  FOR EACH ROW EXECUTE FUNCTION protect_system_role_permissions();