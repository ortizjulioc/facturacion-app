import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrisma, withTenant } from "@facturacion/db";
import { createApp } from "./app";
import { createAuth } from "./auth";
import { loadEnv } from "./env";
import { createLogger } from "./logger";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Flujo completo contra Postgres real: registro → empresa → catálogo → aislamiento → roles. */
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
  const send = (method: string, path: string, body: unknown, cookie?: string) =>
    call(path, { method, body: JSON.stringify(body), cookie });
  const post = (path: string, body: unknown, cookie?: string) => send("POST", path, body, cookie);
  const patch = (path: string, body: unknown, cookie?: string) => send("PATCH", path, body, cookie);
  const get = (path: string, cookie?: string) => call(path, { cookie });
  const json = async (res: Response) => (await res.json()) as Json;

  const cookiesOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  async function signUp(label: string) {
    const res = await post("/api/auth/sign-up/email", {
      name: `Usuario ${label}`,
      email: `${label}-${tag}@example.com`,
      password: "una-clave-bien-larga-123",
    });
    expect(res.status).toBe(200);
    const cookie = cookiesOf(res);
    const { user } = await json(res);
    createdUsers.push(user.id);
    return { cookie, userId: user.id as string };
  }

  async function createCompany(label: string, cookie: string) {
    const org = await post(
      "/api/auth/organization/create",
      { name: `Empresa ${label}`, slug: `${label}-${tag}` },
      cookie,
    );
    expect(org.status).toBe(200);
    const orgId = (await json(org)).id as string;
    createdOrgs.push(orgId);
    return { orgId, cookie: await setActive(orgId, cookie) };
  }

  async function setActive(orgId: string, cookie: string) {
    const res = await post("/api/auth/organization/set-active", { organizationId: orgId }, cookie);
    expect(res.status).toBe(200);
    const refreshed = cookiesOf(res);
    return refreshed || cookie;
  }

  /** Usuario con su empresa (rol owner) y cookie lista. */
  async function owner(label: string) {
    const u = await signUp(label);
    const c = await createCompany(label, u.cookie);
    return { ...u, ...c };
  }

  describe("infraestructura", () => {
    it("expone health y readiness", async () => {
      expect((await get("/health")).status).toBe(200);
      expect((await get("/ready")).status).toBe(200);
    });

    it("rechaza peticiones sin sesión", async () => {
      expect((await get("/v1/branches")).status).toBe(401);
      expect((await get("/v1/products")).status).toBe(401);
      expect((await get("/v1/me")).status).toBe(401);
    });

    it("responde 404 en JSON a rutas inexistentes", async () => {
      const { cookie } = await owner("nf");
      const res = await get("/v1/no-existe", cookie);
      expect(res.status).toBe(404);
      expect((await json(res)).error).toBeDefined();
    });
  });

  describe("sucursales y cajas", () => {
    it("crea, edita y aísla sucursales entre empresas", async () => {
      const a = await owner("sa");
      const b = await owner("sb");

      const created = await post("/v1/branches", { name: "Tienda Centro", code: "CEN-1" }, a.cookie);
      expect(created.status).toBe(201);
      const branch = (await json(created)).data;

      expect((await json(await get("/v1/branches", a.cookie))).data.map((x: Json) => x.code)).toEqual([
        "CEN-1",
      ]);
      expect((await json(await get("/v1/branches", b.cookie))).data).toEqual([]);

      // El mismo código sirve en otra empresa, pero no se repite dentro de la misma.
      expect((await post("/v1/branches", { name: "Otra", code: "CEN-1" }, b.cookie)).status).toBe(201);
      expect((await post("/v1/branches", { name: "Dup", code: "CEN-1" }, a.cookie)).status).toBe(409);

      const edited = await patch(`/v1/branches/${branch.id}`, { name: "Centro Plaza" }, a.cookie);
      expect((await json(edited)).data).toMatchObject({ name: "Centro Plaza", code: "CEN-1" });

      // Otra empresa no puede editarla: para ella no existe.
      expect((await patch(`/v1/branches/${branch.id}`, { name: "x1" }, b.cookie)).status).toBe(404);
    });

    it("valida la entrada con mensajes claros", async () => {
      const { cookie } = await owner("val");
      const res = await post("/v1/branches", { name: "x", code: "con espacios" }, cookie);
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(typeof body.error).toBe("string");
      expect(body.issues.length).toBeGreaterThan(0);
    });

    it("las cajas solo se crean en sucursales propias", async () => {
      const a = await owner("ta");
      const b = await owner("tb");
      const branchA = (await json(await post("/v1/branches", { name: "Matriz", code: "M1" }, a.cookie)))
        .data;

      const ok = await post("/v1/terminals", { branchId: branchA.id, name: "Caja 1", code: "C1" }, a.cookie);
      expect(ok.status).toBe(201);
      expect((await post("/v1/terminals", { branchId: branchA.id, name: "Caja 1", code: "C1" }, a.cookie)).status).toBe(409);

      // La sucursal de A no existe para B (RLS).
      const cross = await post("/v1/terminals", { branchId: branchA.id, name: "Caja X", code: "CX" }, b.cookie);
      expect(cross.status).toBe(422);
      expect((await json(await get("/v1/terminals", b.cookie))).data).toEqual([]);
    });
  });

  describe("productos y categorías", () => {
    it("crea productos con valores por defecto y devuelve el precio como texto", async () => {
      const { cookie } = await owner("p1");
      const res = await post("/v1/products", { name: "Agua 500ml", price: "35.50", barcode: "7461234" }, cookie);
      expect(res.status).toBe(201);
      expect((await json(res)).data).toMatchObject({
        name: "Agua 500ml",
        price: "35.50",
        tax: "ITBIS18",
        priceIncludesTax: true,
        unit: "UND",
        allowsDecimals: false,
        active: true,
        sku: null,
      });
    });

    it("PATCH parcial no pisa los demás campos", async () => {
      const { cookie } = await owner("p2");
      const created = (
        await json(await post("/v1/products", { name: "Arroz", price: "60", tax: "EXENTO", unit: "LB" }, cookie))
      ).data;
      const updated = (await json(await patch(`/v1/products/${created.id}`, { price: "65.25" }, cookie))).data;
      expect(updated).toMatchObject({ price: "65.25", tax: "EXENTO", unit: "LB", name: "Arroz" });
    });

    it("rechaza precios inválidos y códigos duplicados", async () => {
      const { cookie } = await owner("p3");
      expect((await post("/v1/products", { name: "Malo", price: "12.345" }, cookie)).status).toBe(400);
      expect((await post("/v1/products", { name: "Malo", price: "-5" }, cookie)).status).toBe(400);

      await post("/v1/products", { name: "A", price: "1", sku: "SKU-1", barcode: "111111" }, cookie);
      expect((await post("/v1/products", { name: "B", price: "1", sku: "SKU-1" }, cookie)).status).toBe(409);
      expect((await post("/v1/products", { name: "C", price: "1", barcode: "111111" }, cookie)).status).toBe(409);
    });

    it("busca por texto, por categoría y por código de barras", async () => {
      const { cookie } = await owner("p4");
      const cat = (await json(await post("/v1/categories", { name: "Bebidas" }, cookie))).data;
      await post("/v1/products", { name: "Coca Cola 2L", price: "120", categoryId: cat.id, barcode: "0001" }, cookie);
      await post("/v1/products", { name: "Pan", price: "10", barcode: "0002" }, cookie);

      const byText = await json(await get("/v1/products?q=coca", cookie));
      expect(byText.total).toBe(1);
      expect(byText.data[0].name).toBe("Coca Cola 2L");

      const byCat = await json(await get(`/v1/products?categoryId=${cat.id}`, cookie));
      expect(byCat.data.map((p: Json) => p.name)).toEqual(["Coca Cola 2L"]);

      const scan = await get("/v1/products/by-barcode/0002", cookie);
      expect((await json(scan)).data.name).toBe("Pan");
      expect((await get("/v1/products/by-barcode/9999", cookie)).status).toBe(404);
    });

    it("pagina resultados", async () => {
      const { cookie } = await owner("p5");
      for (const n of ["a", "b", "c"]) await post("/v1/products", { name: `Prod ${n}`, price: "1" }, cookie);
      const page2 = await json(await get("/v1/products?pageSize=2&page=2", cookie));
      expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page2.data).toHaveLength(1);
    });

    it("desactivar no borra: el producto deja de salir en la caja", async () => {
      const { cookie } = await owner("p6");
      const p = (await json(await post("/v1/products", { name: "Viejo", price: "5", barcode: "0099" }, cookie))).data;
      expect((await call(`/v1/products/${p.id}`, { method: "DELETE", cookie })).status).toBe(204);
      expect((await get("/v1/products/by-barcode/0099", cookie)).status).toBe(404);
      expect((await json(await get(`/v1/products/${p.id}`, cookie))).data.active).toBe(false);
      expect((await json(await get("/v1/products?active=true", cookie))).total).toBe(0);
    });

    it("aísla productos y categorías entre empresas", async () => {
      const a = await owner("p7a");
      const b = await owner("p7b");
      const cat = (await json(await post("/v1/categories", { name: "Privada" }, a.cookie))).data;
      const prod = (await json(await post("/v1/products", { name: "Secreto", price: "9" }, a.cookie))).data;

      expect((await get(`/v1/products/${prod.id}`, b.cookie)).status).toBe(404);
      expect((await patch(`/v1/products/${prod.id}`, { price: "1" }, b.cookie)).status).toBe(404);
      expect((await call(`/v1/products/${prod.id}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
      expect((await json(await get("/v1/products", b.cookie))).total).toBe(0);

      // No se puede asignar una categoría ajena.
      const steal = await post("/v1/products", { name: "Robo", price: "1", categoryId: cat.id }, b.cookie);
      expect(steal.status).toBe(422);
    });

    it("borrar una categoría deja los productos sin categoría", async () => {
      const { cookie } = await owner("p8");
      const cat = (await json(await post("/v1/categories", { name: "Temporal" }, cookie))).data;
      const p = (await json(await post("/v1/products", { name: "X", price: "1", categoryId: cat.id }, cookie))).data;
      expect((await call(`/v1/categories/${cat.id}`, { method: "DELETE", cookie })).status).toBe(204);
      expect((await json(await get(`/v1/products/${p.id}`, cookie))).data.categoryId).toBeNull();
    });
  });

  describe("clientes", () => {
    it("normaliza el RNC y la cédula", async () => {
      const { cookie } = await owner("c1");
      const rnc = await post("/v1/customers", { name: "Acme SRL", documentType: "RNC", documentNumber: "1-01-00157-7" }, cookie);
      expect(rnc.status).toBe(201);
      expect((await json(rnc)).data).toMatchObject({ documentType: "RNC", documentNumber: "101001577" });

      const ced = await post("/v1/customers", { name: "Juan", documentType: "CEDULA", documentNumber: "001-1234567-8" }, cookie);
      expect((await json(ced)).data.documentNumber).toBe("00112345678");
    });

    it("exige tipo y número juntos, y formato válido", async () => {
      const { cookie } = await owner("c2");
      expect((await post("/v1/customers", { name: "A", documentType: "RNC" }, cookie)).status).toBe(422);
      expect((await post("/v1/customers", { name: "A", documentNumber: "123" }, cookie)).status).toBe(422);
      expect((await post("/v1/customers", { name: "A", documentType: "RNC", documentNumber: "123" }, cookie)).status).toBe(422);
      expect((await post("/v1/customers", { name: "Sin doc" }, cookie)).status).toBe(201);
      expect((await post("/v1/customers", { name: "Mal correo", email: "nope" }, cookie)).status).toBe(400);
    });

    it("no repite documentos dentro de la empresa, pero sí entre empresas", async () => {
      const a = await owner("c3a");
      const b = await owner("c3b");
      const body = { name: "Cliente", documentType: "RNC", documentNumber: "131246796" };
      expect((await post("/v1/customers", body, a.cookie)).status).toBe(201);
      expect((await post("/v1/customers", body, a.cookie)).status).toBe(409);
      expect((await post("/v1/customers", body, b.cookie)).status).toBe(201);
    });

    it("busca por nombre o documento y edita sin tocar el documento", async () => {
      const { cookie } = await owner("c4");
      const c = (
        await json(await post("/v1/customers", { name: "Ferretería Lopez", documentType: "RNC", documentNumber: "101234567" }, cookie))
      ).data;
      expect((await json(await get("/v1/customers?q=lopez", cookie))).total).toBe(1);
      expect((await json(await get("/v1/customers?q=1-01-23456", cookie))).total).toBe(1);

      const upd = await patch(`/v1/customers/${c.id}`, { phone: "809-555-0100" }, cookie);
      expect((await json(upd)).data).toMatchObject({ phone: "809-555-0100", documentNumber: "101234567" });
    });

    it("aísla clientes entre empresas", async () => {
      const a = await owner("c5a");
      const b = await owner("c5b");
      const c = (await json(await post("/v1/customers", { name: "Privado" }, a.cookie))).data;
      expect((await get(`/v1/customers/${c.id}`, b.cookie)).status).toBe(404);
      expect((await json(await get("/v1/customers", b.cookie))).total).toBe(0);
    });
  });

  describe("roles", () => {
    it("un miembro puede consultar y crear clientes, pero no modificar el catálogo", async () => {
      const boss = await owner("r1");
      const worker = await signUp("r1w");
      await prisma.member.create({
        data: { id: randomUUID(), organizationId: boss.orgId, userId: worker.userId, role: "member" },
      });
      const cookie = await setActive(boss.orgId, worker.cookie);

      await post("/v1/products", { name: "Visible", price: "5" }, boss.cookie);
      expect((await json(await get("/v1/products", cookie))).total).toBe(1);

      expect((await post("/v1/products", { name: "Nuevo", price: "5" }, cookie)).status).toBe(403);
      expect((await post("/v1/branches", { name: "Otra", code: "O1" }, cookie)).status).toBe(403);
      expect((await post("/v1/customers", { name: "Cliente de caja" }, cookie)).status).toBe(201);
    });
  });

  describe("cálculo de totales", () => {
    it("lista los códigos de impuesto", async () => {
      const { cookie } = await owner("k1");
      const body = await json(await get("/v1/tax-codes", cookie));
      expect(body.data.map((t: Json) => t.code)).toEqual(["ITBIS18", "ITBIS16", "ITBIS0", "EXENTO"]);
      expect(body.data[0].rateBps).toBe(1800);
    });

    it("calcula igual que el motor fiscal", async () => {
      const { cookie } = await owner("k2");
      const res = await post(
        "/v1/calculate",
        {
          propinaLegal: true,
          lines: [
            { unitPrice: "100.00", quantity: "1", tax: "ITBIS18" },
            { unitPrice: "50.00", quantity: "1", tax: "EXENTO" },
            { unitPrice: "99.99", quantity: "3", tax: "ITBIS18" },
          ],
        },
        cookie,
      );
      expect(res.status).toBe(200);
      const { data } = await json(res);
      expect(data).toMatchObject({
        subtotal: "449.97",
        totalTax: "71.99",
        propinaLegal: "45.00",
        total: "566.96",
      });
      expect(data.byTax.ITBIS18).toEqual({ base: "399.97", taxAmount: "71.99" });
    });

    it("rechaza líneas inválidas", async () => {
      const { cookie } = await owner("k3");
      const bad = await post("/v1/calculate", { lines: [{ unitPrice: "1", quantity: "1.5555", tax: "ITBIS18" }] }, cookie);
      expect(bad.status).toBe(400);
      expect((await post("/v1/calculate", { lines: [] }, cookie)).status).toBe(400);
    });
  });

  describe("bitácora", () => {
    it("registra cada cambio, de forma atómica con el cambio", async () => {
      const { cookie, orgId } = await owner("log");
      const p = (await json(await post("/v1/products", { name: "Auditado", price: "10" }, cookie))).data;
      await patch(`/v1/products/${p.id}`, { price: "11" }, cookie);
      await post("/v1/branches", { name: "Sucursal Log", code: "LOG-1" }, cookie);
      // Una operación fallida no debe dejar rastro en la bitácora.
      await post("/v1/branches", { name: "Duplicada", code: "LOG-1" }, cookie);

      const logs = await withTenant(prisma, orgId).auditLog.findMany({ orderBy: { createdAt: "asc" } });
      expect(logs.map((l) => l.action).sort()).toEqual(["branch.create", "product.create", "product.update"]);
      expect(logs.every((l) => l.actorUserId)).toBe(true);
    });
  });
});
