-- Row-Level Security por empresa (tenant).
--
-- La API fija `app.tenant_id` dentro de cada transacción (ver src/tenant.ts). Sin esa variable
-- la condición es NULL y la tabla aparece vacía: falla cerrado.
-- FORCE ROW LEVEL SECURITY hace que la política aplique incluso al dueño de la tabla.

-- ───────────── branch ─────────────
ALTER TABLE "branch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "branch"
  USING ("organizationId" = current_setting('app.tenant_id', true))
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- ───────────── audit_log (solo lectura e inserción) ─────────────
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_select ON "audit_log" FOR SELECT
  USING ("organizationId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_insert ON "audit_log" FOR INSERT
  WITH CHECK ("organizationId" = current_setting('app.tenant_id', true));

-- La bitácora es inmutable: la app no puede modificar ni borrar filas.
-- (Si el rol aún no existe, setup-roles.sql ya no le otorgará UPDATE/DELETE por separado.)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'facturacion_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM facturacion_app;
  END IF;
END $$;
