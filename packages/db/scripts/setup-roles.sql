-- Crea los dos roles de la base de datos. Ejecutar con un usuario administrador, conectado a la
-- base de datos de la aplicación (que debe existir ya):
--
--   psql "$ADMIN_URL" \
--     -v dbname=facturacion \
--     -v migrator_password="'<clave-migrator>'" \
--     -v app_password="'<clave-app>'" \
--     -f packages/db/scripts/setup-roles.sql
--
--   facturacion_migrator : dueño de la base y de las tablas; lo usa `prisma migrate deploy`.
--   facturacion_app      : lo usa la API. NO es dueño ni superusuario: RLS siempre se aplica.
--
-- Es idempotente: se puede volver a ejecutar para rotar contraseñas.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'facturacion_migrator') THEN
    CREATE ROLE facturacion_migrator LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'facturacion_app') THEN
    CREATE ROLE facturacion_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE facturacion_migrator PASSWORD :migrator_password;
ALTER ROLE facturacion_app PASSWORD :app_password;

ALTER DATABASE :"dbname" OWNER TO facturacion_migrator;
GRANT CONNECT ON DATABASE :"dbname" TO facturacion_app;

-- En PostgreSQL 15+ el schema public es de pg_database_owner (= el migrator tras el ALTER anterior).
ALTER SCHEMA public OWNER TO facturacion_migrator;
GRANT USAGE ON SCHEMA public TO facturacion_app;

-- Todo lo que cree el migrator queda accesible al rol de la app.
ALTER DEFAULT PRIVILEGES FOR ROLE facturacion_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO facturacion_app;
ALTER DEFAULT PRIVILEGES FOR ROLE facturacion_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO facturacion_app;
