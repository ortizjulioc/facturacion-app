import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrisma } from "@facturacion/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createLogger } from "./logger";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);

/** Flujo completo contra Postgres real: registro → empresa → sucursales → aislamiento. */
describe.skipIf(!hasDb)("API de punta a punta", () => {
  const env = loadEnv({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "error" });
  const prisma = createPrisma({ connectionString: env.DATABASE_URL, max: 3 });
  const app = createApp({ env, prisma, auth: createAuth(prisma, env), logger: createLogger(env) });
  const origin = env.WEB_ORIGIN.split(",")[0]!;
  const tag = randomUUID().slice(0, 8);
  const createdOrgs: string[] = [];
  const createdUsers: string[] = [];

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: createdOrgs } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
    await prisma.$disconnect();
  });

  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const { cookie, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("origin", origin);
    if (rest.body) headers.set("content-type", "application/json");
    if (cookie) headers.set("cookie", cookie);
    return app.request(path, { ...rest, headers });
  };

  const post = (path: string, body: unknown, cookie?: string) =>
    call(path, { method: "POST", body: JSON.stringify(body), cookie });

  /** Registra un usuario con su empresa y devuelve la cookie de sesión lista para usar. */
  async function signUpWithCompany(label: string) {
    const signUp = await post("/api/auth/sign-up/email", {
      name: `Usuario ${label}`,
      email: `${label}-${tag}@example.com`,
      password: "una-clave-bien-larga-123",
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    createdUsers.push(((await signUp.json()) as { user: { id: string } }).user.id);

    const org = await post(
      "/api/auth/organization/create",
      { name: `Empresa ${label}`, slug: `${label}-${tag}` },
      cookie,
    );
    expect(org.status).toBe(200);
    const orgId = ((await org.json()) as { id: string }).id;
    createdOrgs.push(orgId);

    const active = await post("/api/auth/organization/set-active", { organizationId: orgId }, cookie);
    expect(active.status).toBe(200);
    // set-active puede rotar la cookie de sesión.
    const refreshed = active.headers.getSetCookie().map((c) => c.split(";")[0]);
    return { cookie: refreshed.length ? refreshed.join("; ") : cookie, orgId };
  }

  it("expone health y readiness", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/ready")).status).toBe(200);
  });

  it("rechaza peticiones sin sesión", async () => {
    expect((await call("/v1/branches")).status).toBe(401);
    expect((await call("/v1/me")).status).toBe(401);
  });

  it("crea sucursales y aísla los datos entre empresas", async () => {
    const a = await signUpWithCompany("a");
    const b = await signUpWithCompany("b");

    const created = await post("/v1/branches", { name: "Tienda Centro", code: "CEN-1" }, a.cookie);
    expect(created.status).toBe(201);

    const listA = (await (await call("/v1/branches", { cookie: a.cookie })).json()) as {
      branches: { code: string }[];
    };
    expect(listA.branches.map((x) => x.code)).toEqual(["CEN-1"]);

    const listB = (await (await call("/v1/branches", { cookie: b.cookie })).json()) as {
      branches: unknown[];
    };
    expect(listB.branches).toEqual([]);

    // El mismo código es válido en otra empresa, pero no se repite dentro de la misma.
    expect((await post("/v1/branches", { name: "Otra", code: "CEN-1" }, b.cookie)).status).toBe(201);
    expect((await post("/v1/branches", { name: "Dup", code: "CEN-1" }, a.cookie)).status).toBe(409);
  });

  it("valida la entrada", async () => {
    const { cookie } = await signUpWithCompany("v");
    const bad = await post("/v1/branches", { name: "x", code: "con espacios" }, cookie);
    expect(bad.status).toBe(400);
  });

  it("registra la creación en la bitácora", async () => {
    const { cookie, orgId } = await signUpWithCompany("log");
    await post("/v1/branches", { name: "Sucursal Log", code: "LOG-1" }, cookie);
    const { withTenant } = await import("@facturacion/db");
    const logs = await withTenant(prisma, orgId).auditLog.findMany();
    expect(logs.map((l) => l.action)).toContain("branch.create");
  });
});
