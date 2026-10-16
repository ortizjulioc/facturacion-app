# Facturación

Sistema de facturación electrónica (e-CF, República Dominicana) y punto de venta, multiempresa y multigiro.

- Plan y decisiones técnicas: [docs/PLAN.md](docs/PLAN.md)
- Despliegue en Oracle Cloud + Dokploy: [docs/DESPLIEGUE.md](docs/DESPLIEGUE.md)

## Estructura

```
apps/
  web/   Next.js 16 – back-office
  api/   Hono + Better Auth – API, sincronización, workers
packages/
  db/    Prisma 7 (Postgres) – schema, migraciones, RLS por empresa
  core/  Lógica de negocio pura (dinero en centavos, impuestos…)
docker/  Dockerfiles (arm64) y compose de desarrollo
```

## Puesta en marcha local

Requisitos: Node 24, pnpm 11 (`corepack enable`), PostgreSQL 18 (local o `docker compose -f docker/docker-compose.dev.yml up -d`).

```bash
pnpm install

# 1. Pon la clave de tu usuario administrador de Postgres en .env (DATABASE_URL_ADMIN) y:
pnpm db:bootstrap      # crea la base "facturacion", los roles y completa el .env
pnpm db:deploy         # aplica las migraciones (usa el rol dueño)

# 2. Arrancar todo
pnpm dev               # web en :3000, api en :3001
```

## Comandos

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Web + API en modo desarrollo |
| `pnpm build` | Compila todo (genera el cliente Prisma primero) |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | Calidad |
| `pnpm db:deploy` | Aplica las migraciones pendientes |
| `pnpm db:diff` | Imprime el SQL de lo que cambió en `schema.prisma` (ver docs/PLAN.md §0.3.1) |
| `pnpm db:studio` | Prisma Studio |

## Multiempresa

Cada empresa es una *organización* de Better Auth. Las tablas de negocio llevan `organizationId` y tienen **Row-Level Security**: la API fija `app.tenant_id` en cada transacción (`withTenant` en `packages/db/src/tenant.ts`) y la app se conecta con un rol que no puede saltarse las políticas. Las pruebas de `packages/db` verifican el aislamiento directamente contra Postgres.
