# Facturación (e-CF República Dominicana)

**Antes de hacer nada, lee [docs/PLAN.md](docs/PLAN.md), sección 0**: estado actual, cómo levantar el entorno, backlog, decisiones tomadas y trampas conocidas.

## Reglas del proyecto

- Responder en **español neutro** (tú; sin "vos", "acá", "che").
- **No desplegar** (Dokploy/Oracle) hasta que el producto esté terminado y pulido.
- Commits solo cuando el usuario lo pida, con el formato `[Add] - "mensaje"`, `[Update]`, `[Fix]` o `[Delete]`.
- Stack: TypeScript, pnpm + Turborepo, Next 16 (`apps/web`), Hono + Better Auth (`apps/api`), Prisma 7 + Postgres con RLS (`packages/db`), lógica fiscal pura en `packages/core`.
- Dinero siempre en **centavos `bigint`**; en JSON viaja como texto decimal (`"19.99"`).
- Toda tabla de negocio lleva `organizationId` + RLS y una prueba en `packages/db/src/tenant.test.ts`. Las migraciones **no** se crean con `prisma migrate dev` (ver PLAN §0.3.1).
- Next 16 difiere de lo que sabes: lee `apps/web/AGENTS.md` y la documentación en `node_modules/next/dist/docs/` antes de tocar código de Next.
- Antes de dar algo por terminado: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
