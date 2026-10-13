-- 1. PolicyBinding : scopeType et scopeId vont ensemble (tous deux présents ou tous deux absents)
ALTER TABLE "PolicyBinding" ADD CONSTRAINT "PolicyBinding_scope_pair"
  CHECK (("scopeType" IS NULL) = ("scopeId" IS NULL));

-- 2. Un scope doit désigner une ressource du tenant concerné.
--    Les types inconnus ne sont pas rejetés ici : leur refus est porté par le code
--    (scope.ts), pour qu'ajouter un type de ressource ne demande pas de migration.
CREATE OR REPLACE FUNCTION scope_belongs_to_tenant(scope_type text, scope_id text, tenant text)
RETURNS boolean AS $$
BEGIN
  RETURN CASE scope_type
    WHEN 'tenant'  THEN scope_id = tenant
    WHEN 'cluster' THEN EXISTS (SELECT 1 FROM "Cluster" WHERE id = scope_id AND "tenantId" = tenant)
    WHEN 'server'  THEN EXISTS (SELECT 1 FROM "Server"  WHERE id = scope_id AND "tenantId" = tenant)
    WHEN 'project' THEN EXISTS (SELECT 1 FROM "Project" WHERE id = scope_id AND "tenantId" = tenant)
    WHEN 'node'    THEN EXISTS (SELECT 1 FROM "Node" n JOIN "Project" p ON p.id = n."projectId"
                                WHERE n.id = scope_id AND p."tenantId" = tenant)
    WHEN 'edge'    THEN EXISTS (SELECT 1 FROM "Edge" e JOIN "Project" p ON p.id = e."projectId"
                                WHERE e.id = scope_id AND p."tenantId" = tenant)
    ELSE true
  END;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION check_role_permission_scope() RETURNS trigger AS $$
DECLARE role_tenant text;
BEGIN
  SELECT "tenantId" INTO role_tenant FROM "Role" WHERE id = NEW."roleId";
  IF NOT scope_belongs_to_tenant(NEW."scopeType", NEW."scopeId", role_tenant) THEN
    RAISE EXCEPTION 'Le scope %:% n''appartient pas au tenant du rôle', NEW."scopeType", NEW."scopeId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER rolepermission_check_scope
  BEFORE INSERT OR UPDATE OF "scopeType", "scopeId", "roleId" ON "RolePermission"
  FOR EACH ROW EXECUTE FUNCTION check_role_permission_scope();

CREATE OR REPLACE FUNCTION check_tenant_scope_columns() RETURNS trigger AS $$
BEGIN
  IF NEW."scopeType" IS NOT NULL
     AND NOT scope_belongs_to_tenant(NEW."scopeType", NEW."scopeId", NEW."tenantId") THEN
    RAISE EXCEPTION 'Le scope %:% n''appartient pas au tenant %', NEW."scopeType", NEW."scopeId", NEW."tenantId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER teamrole_check_scope
  BEFORE INSERT OR UPDATE OF "scopeType", "scopeId", "tenantId" ON "TeamRole"
  FOR EACH ROW EXECUTE FUNCTION check_tenant_scope_columns();

CREATE TRIGGER policybinding_check_scope
  BEFORE INSERT OR UPDATE OF "scopeType", "scopeId", "tenantId" ON "PolicyBinding"
  FOR EACH ROW EXECUTE FUNCTION check_tenant_scope_columns();

-- 3. ExternalGroupMapping : le provider doit être global (tenant nul) ou du même tenant
CREATE OR REPLACE FUNCTION check_mapping_provider_tenant() RETURNS trigger AS $$
DECLARE provider_tenant text;
BEGIN
  SELECT "tenantId" INTO provider_tenant FROM "AuthProvider" WHERE id = NEW."providerId";
  IF provider_tenant IS NOT NULL AND provider_tenant <> NEW."tenantId" THEN
    RAISE EXCEPTION 'Le provider appartient à un autre tenant que la correspondance';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER externalgroupmapping_check_provider
  BEFORE INSERT OR UPDATE OF "providerId", "tenantId" ON "ExternalGroupMapping"
  FOR EACH ROW EXECUTE FUNCTION check_mapping_provider_tenant();

-- Un provider ne peut pas changer de tenant s'il a des correspondances d'un autre tenant
CREATE OR REPLACE FUNCTION protect_provider_tenant_change() RETURNS trigger AS $$
BEGIN
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId" AND EXISTS (
    SELECT 1 FROM "ExternalGroupMapping"
    WHERE "providerId" = OLD.id AND (NEW."tenantId" IS NULL OR "tenantId" <> NEW."tenantId")
      AND NEW."tenantId" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Ce provider a des correspondances de groupes d''un autre tenant';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER authprovider_protect_tenant
  BEFORE UPDATE OF "tenantId" ON "AuthProvider"
  FOR EACH ROW EXECUTE FUNCTION protect_provider_tenant_change();

-- 4. Un rôle système (Root) ne peut être attribué ni à une adhésion ni à une équipe.
--    Levée possible par une migration ultérieure, quand la sémantique de Root sera définie.
CREATE OR REPLACE FUNCTION forbid_system_role_assignment() RETURNS trigger AS $$
BEGIN
  IF NEW."roleId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Role" WHERE id = NEW."roleId" AND "isSystem") THEN
    RAISE EXCEPTION 'Un rôle système ne peut pas être attribué';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER membership_forbid_system_role
  BEFORE INSERT OR UPDATE OF "roleId" ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION forbid_system_role_assignment();

CREATE TRIGGER teamrole_forbid_system_role
  BEFORE INSERT OR UPDATE OF "roleId" ON "TeamRole"
  FOR EACH ROW EXECUTE FUNCTION forbid_system_role_assignment();