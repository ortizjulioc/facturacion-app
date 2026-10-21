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
  const app = createApp({
    env,
    prisma,
    auth: createAuth(prisma, env),
    logger: createLogger(env),
  });
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
  const post = (path: string, body: unknown, cookie?: string) =>
    send("POST", path, body, cookie);
  const patch = (path: string, body: unknown, cookie?: string) =>
    send("PATCH", path, body, cookie);
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
    const res = await post(
      "/api/auth/organization/set-active",
      { organizationId: orgId },
      cookie,
    );
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

      const created = await post(
        "/v1/branches",
        { name: "Tienda Centro", code: "CEN-1" },
        a.cookie,
      );
      expect(created.status).toBe(201);
      const branch = (await json(created)).data;

      expect(
        (await json(await get("/v1/branches", a.cookie))).data.map((x: Json) => x.code),
      ).toEqual(["CEN-1"]);
      expect((await json(await get("/v1/branches", b.cookie))).data).toEqual([]);

      // El mismo código sirve en otra empresa, pero no se repite dentro de la misma.
      expect(
        (await post("/v1/branches", { name: "Otra", code: "CEN-1" }, b.cookie)).status,
      ).toBe(201);
      expect(
        (await post("/v1/branches", { name: "Dup", code: "CEN-1" }, a.cookie)).status,
      ).toBe(409);

      const edited = await patch(
        `/v1/branches/${branch.id}`,
        { name: "Centro Plaza" },
        a.cookie,
      );
      expect((await json(edited)).data).toMatchObject({
        name: "Centro Plaza",
        code: "CEN-1",
      });

      // Otra empresa no puede editarla: para ella no existe.
      expect(
        (await patch(`/v1/branches/${branch.id}`, { name: "x1" }, b.cookie)).status,
      ).toBe(404);
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
      const branchA = (
        await json(await post("/v1/branches", { name: "Matriz", code: "M1" }, a.cookie))
      ).data;

      const ok = await post(
        "/v1/terminals",
        { branchId: branchA.id, name: "Caja 1", code: "C1" },
        a.cookie,
      );
      expect(ok.status).toBe(201);
      expect(
        (
          await post(
            "/v1/terminals",
            { branchId: branchA.id, name: "Caja 1", code: "C1" },
            a.cookie,
          )
        ).status,
      ).toBe(409);

      // La sucursal de A no existe para B (RLS).
      const cross = await post(
        "/v1/terminals",
        { branchId: branchA.id, name: "Caja X", code: "CX" },
        b.cookie,
      );
      expect(cross.status).toBe(422);
      expect((await json(await get("/v1/terminals", b.cookie))).data).toEqual([]);
    });
  });

  describe("productos y categorías", () => {
    it("crea productos con valores por defecto y devuelve el precio como texto", async () => {
      const { cookie } = await owner("p1");
      const res = await post(
        "/v1/products",
        { name: "Agua 500ml", price: "35.50", barcode: "7461234" },
        cookie,
      );
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
        await json(
          await post(
            "/v1/products",
            { name: "Arroz", price: "60", tax: "EXENTO", unit: "LB" },
            cookie,
          ),
        )
      ).data;
      const updated = (
        await json(await patch(`/v1/products/${created.id}`, { price: "65.25" }, cookie))
      ).data;
      expect(updated).toMatchObject({
        price: "65.25",
        tax: "EXENTO",
        unit: "LB",
        name: "Arroz",
      });
    });

    it("rechaza precios inválidos y códigos duplicados", async () => {
      const { cookie } = await owner("p3");
      expect(
        (await post("/v1/products", { name: "Malo", price: "12.345" }, cookie)).status,
      ).toBe(400);
      expect(
        (await post("/v1/products", { name: "Malo", price: "-5" }, cookie)).status,
      ).toBe(400);

      await post(
        "/v1/products",
        { name: "A", price: "1", sku: "SKU-1", barcode: "111111" },
        cookie,
      );
      expect(
        (await post("/v1/products", { name: "B", price: "1", sku: "SKU-1" }, cookie))
          .status,
      ).toBe(409);
      expect(
        (await post("/v1/products", { name: "C", price: "1", barcode: "111111" }, cookie))
          .status,
      ).toBe(409);
    });

    it("busca por texto, por categoría y por código de barras", async () => {
      const { cookie } = await owner("p4");
      const cat = (await json(await post("/v1/categories", { name: "Bebidas" }, cookie)))
        .data;
      await post(
        "/v1/products",
        { name: "Coca Cola 2L", price: "120", categoryId: cat.id, barcode: "0001" },
        cookie,
      );
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
      for (const n of ["a", "b", "c"])
        await post("/v1/products", { name: `Prod ${n}`, price: "1" }, cookie);
      const page2 = await json(await get("/v1/products?pageSize=2&page=2", cookie));
      expect(page2).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(page2.data).toHaveLength(1);
    });

    it("desactivar no borra: el producto deja de salir en la caja", async () => {
      const { cookie } = await owner("p6");
      const p = (
        await json(
          await post(
            "/v1/products",
            { name: "Viejo", price: "5", barcode: "0099" },
            cookie,
          ),
        )
      ).data;
      expect(
        (await call(`/v1/products/${p.id}`, { method: "DELETE", cookie })).status,
      ).toBe(204);
      expect((await get("/v1/products/by-barcode/0099", cookie)).status).toBe(404);
      expect((await json(await get(`/v1/products/${p.id}`, cookie))).data.active).toBe(
        false,
      );
      expect((await json(await get("/v1/products?active=true", cookie))).total).toBe(0);
    });

    it("aísla productos y categorías entre empresas", async () => {
      const a = await owner("p7a");
      const b = await owner("p7b");
      const cat = (
        await json(await post("/v1/categories", { name: "Privada" }, a.cookie))
      ).data;
      const prod = (
        await json(await post("/v1/products", { name: "Secreto", price: "9" }, a.cookie))
      ).data;

      expect((await get(`/v1/products/${prod.id}`, b.cookie)).status).toBe(404);
      expect(
        (await patch(`/v1/products/${prod.id}`, { price: "1" }, b.cookie)).status,
      ).toBe(404);
      expect(
        (await call(`/v1/products/${prod.id}`, { method: "DELETE", cookie: b.cookie }))
          .status,
      ).toBe(404);
      expect((await json(await get("/v1/products", b.cookie))).total).toBe(0);

      // No se puede asignar una categoría ajena.
      const steal = await post(
        "/v1/products",
        { name: "Robo", price: "1", categoryId: cat.id },
        b.cookie,
      );
      expect(steal.status).toBe(422);
    });

    it("borrar una categoría deja los productos sin categoría", async () => {
      const { cookie } = await owner("p8");
      const cat = (await json(await post("/v1/categories", { name: "Temporal" }, cookie)))
        .data;
      const p = (
        await json(
          await post(
            "/v1/products",
            { name: "X", price: "1", categoryId: cat.id },
            cookie,
          ),
        )
      ).data;
      expect(
        (await call(`/v1/categories/${cat.id}`, { method: "DELETE", cookie })).status,
      ).toBe(204);
      expect(
        (await json(await get(`/v1/products/${p.id}`, cookie))).data.categoryId,
      ).toBeNull();
    });
  });

  describe("clientes", () => {
    it("normaliza el RNC y la cédula", async () => {
      const { cookie } = await owner("c1");
      const rnc = await post(
        "/v1/customers",
        { name: "Acme SRL", documentType: "RNC", documentNumber: "1-01-00157-7" },
        cookie,
      );
      expect(rnc.status).toBe(201);
      expect((await json(rnc)).data).toMatchObject({
        documentType: "RNC",
        documentNumber: "101001577",
      });

      const ced = await post(
        "/v1/customers",
        { name: "Juan", documentType: "CEDULA", documentNumber: "001-1234567-8" },
        cookie,
      );
      expect((await json(ced)).data.documentNumber).toBe("00112345678");
    });

    it("exige tipo y número juntos, y formato válido", async () => {
      const { cookie } = await owner("c2");
      expect(
        (await post("/v1/customers", { name: "A", documentType: "RNC" }, cookie)).status,
      ).toBe(422);
      expect(
        (await post("/v1/customers", { name: "A", documentNumber: "123" }, cookie))
          .status,
      ).toBe(422);
      expect(
        (
          await post(
            "/v1/customers",
            { name: "A", documentType: "RNC", documentNumber: "123" },
            cookie,
          )
        ).status,
      ).toBe(422);
      expect((await post("/v1/customers", { name: "Sin doc" }, cookie)).status).toBe(201);
      expect(
        (await post("/v1/customers", { name: "Mal correo", email: "nope" }, cookie))
          .status,
      ).toBe(400);
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
        await json(
          await post(
            "/v1/customers",
            {
              name: "Ferretería Lopez",
              documentType: "RNC",
              documentNumber: "101234567",
            },
            cookie,
          ),
        )
      ).data;
      expect((await json(await get("/v1/customers?q=lopez", cookie))).total).toBe(1);
      expect((await json(await get("/v1/customers?q=1-01-23456", cookie))).total).toBe(1);

      const upd = await patch(`/v1/customers/${c.id}`, { phone: "809-555-0100" }, cookie);
      expect((await json(upd)).data).toMatchObject({
        phone: "809-555-0100",
        documentNumber: "101234567",
      });
    });

    it("aísla clientes entre empresas", async () => {
      const a = await owner("c5a");
      const b = await owner("c5b");
      const c = (await json(await post("/v1/customers", { name: "Privado" }, a.cookie)))
        .data;
      expect((await get(`/v1/customers/${c.id}`, b.cookie)).status).toBe(404);
      expect((await json(await get("/v1/customers", b.cookie))).total).toBe(0);
    });
  });

  describe("roles", () => {
    it("un miembro puede consultar y crear clientes, pero no modificar el catálogo", async () => {
      const boss = await owner("r1");
      const worker = await signUp("r1w");
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: boss.orgId,
          userId: worker.userId,
          role: "member",
        },
      });
      const cookie = await setActive(boss.orgId, worker.cookie);

      await post("/v1/products", { name: "Visible", price: "5" }, boss.cookie);
      expect((await json(await get("/v1/products", cookie))).total).toBe(1);

      expect(
        (await post("/v1/products", { name: "Nuevo", price: "5" }, cookie)).status,
      ).toBe(403);
      expect(
        (await post("/v1/branches", { name: "Otra", code: "O1" }, cookie)).status,
      ).toBe(403);
      expect(
        (await post("/v1/customers", { name: "Cliente de caja" }, cookie)).status,
      ).toBe(201);
    });
  });

  describe("cálculo de totales", () => {
    it("lista los códigos de impuesto", async () => {
      const { cookie } = await owner("k1");
      const body = await json(await get("/v1/tax-codes", cookie));
      expect(body.data.map((t: Json) => t.code)).toEqual([
        "ITBIS18",
        "ITBIS16",
        "ITBIS0",
        "EXENTO",
      ]);
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
      const bad = await post(
        "/v1/calculate",
        { lines: [{ unitPrice: "1", quantity: "1.5555", tax: "ITBIS18" }] },
        cookie,
      );
      expect(bad.status).toBe(400);
      expect((await post("/v1/calculate", { lines: [] }, cookie)).status).toBe(400);
    });
  });

  // ───────────── Facturación ─────────────

  const profileBody = {
    rnc: "1-01-00157-7",
    legalName: "Empresa de Prueba SRL",
    address: "Calle Principal 1, Santo Domingo",
    environment: "TEST",
  };
  const seqBody = (
    ecfType: string,
    fromNumber: number,
    toNumber: number,
    extra: object = {},
  ) => ({
    ecfType,
    fromNumber,
    toNumber,
    expiresAt: "2099-12-31",
    ...extra,
  });

  /** Empresa con sucursal, un producto de RD$118.00 (ITBIS incluido) y, opcionalmente, datos fiscales y secuencias. */
  async function billing(
    label: string,
    opts: { profile?: boolean; seqs?: [string, number, number][] } = {},
  ) {
    const o = await owner(label);
    const branch = (
      await json(await post("/v1/branches", { name: "Principal", code: "P1" }, o.cookie))
    ).data;
    const product = (
      await json(
        await post(
          "/v1/products",
          { name: "Producto 118", price: "118.00", tax: "ITBIS18" },
          o.cookie,
        ),
      )
    ).data;
    if (opts.profile !== false) {
      expect((await send("PUT", "/v1/company", profileBody, o.cookie)).status).toBe(200);
    }
    for (const [type, from, to] of opts.seqs ?? []) {
      expect(
        (await post("/v1/sequences", seqBody(type, from, to), o.cookie)).status,
      ).toBe(201);
    }
    return { ...o, branch, product };
  }
  type Billing = Awaited<ReturnType<typeof billing>>;

  const draftBody = (b: Billing, over: Json = {}) => ({
    type: "E32",
    branchId: b.branch.id,
    lines: [{ productId: b.product.id, quantity: "2" }],
    payments: [{ method: "CASH", amount: "236.00" }],
    ...over,
  });
  const createDraft = async (b: Billing, over: Json = {}) => {
    const res = await post("/v1/documents", draftBody(b, over), b.cookie);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    return (await json(res)).data as Json;
  };
  const issue = (b: Billing, id: string) =>
    post(`/v1/documents/${id}/issue`, {}, b.cookie);
  const error = async (res: Response) => (await json(res)).error as string;

  describe("datos fiscales y secuencias", () => {
    it("guarda el RNC normalizado y valida el formato", async () => {
      const b = await billing("f1", { profile: false });
      expect((await json(await get("/v1/company", b.cookie))).data).toBeNull();

      const bad = await send(
        "PUT",
        "/v1/company",
        { ...profileBody, rnc: "123" },
        b.cookie,
      );
      expect(bad.status).toBe(422);

      const ok = await send("PUT", "/v1/company", profileBody, b.cookie);
      expect((await json(ok)).data).toMatchObject({
        rnc: "101001577",
        environment: "TEST",
      });
      // Es idempotente: una segunda llamada actualiza, no duplica.
      const again = await send(
        "PUT",
        "/v1/company",
        { ...profileBody, tradeName: "Mi Colmado" },
        b.cookie,
      );
      expect((await json(again)).data.tradeName).toBe("Mi Colmado");
    });

    it("las secuencias no se solapan y el rango debe ser coherente", async () => {
      const b = await billing("f2");
      const created = await post("/v1/sequences", seqBody("E32", 1, 100), b.cookie);
      expect(created.status).toBe(201);
      expect((await json(created)).data).toMatchObject({
        fromNumber: 1,
        toNumber: 100,
        nextNumber: 1,
        remaining: 100,
      });

      expect(
        (await post("/v1/sequences", seqBody("E32", 50, 150), b.cookie)).status,
      ).toBe(409);
      expect(
        (await post("/v1/sequences", seqBody("E31", 50, 150), b.cookie)).status,
      ).toBe(201); // otro tipo: sin conflicto
      expect(
        (await post("/v1/sequences", seqBody("E32", 200, 100), b.cookie)).status,
      ).toBe(400);
      expect(
        (
          await post(
            "/v1/sequences",
            seqBody("E32", 101, 200, { terminalId: randomUUID() }),
            b.cookie,
          )
        ).status,
      ).toBe(422);
    });

    it("permite ampliar el rango pero no recortarlo por debajo de lo emitido", async () => {
      const b = await billing("f3", { seqs: [["E32", 1, 10]] });
      const d = await createDraft(b);
      await issue(b, d.id);

      const seq = (await json(await get("/v1/sequences", b.cookie))).data[0];
      expect(seq).toMatchObject({ nextNumber: 2, remaining: 9 });
      expect(
        (await patch(`/v1/sequences/${seq.id}`, { toNumber: 50 }, b.cookie)).status,
      ).toBe(200);
      expect(
        (await patch(`/v1/sequences/${seq.id}`, { toNumber: 0 }, b.cookie)).status,
      ).toBe(400);
      expect(
        (await patch(`/v1/sequences/${seq.id}`, { active: false }, b.cookie)).status,
      ).toBe(200);
    });

    it("el cajero (member) no puede cambiar datos fiscales ni secuencias", async () => {
      const b = await billing("f4");
      const cashier = await signUp("f4c");
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: b.orgId,
          userId: cashier.userId,
          role: "member",
        },
      });
      const cookie = await setActive(b.orgId, cashier.cookie);

      expect((await send("PUT", "/v1/company", profileBody, cookie)).status).toBe(403);
      expect((await post("/v1/sequences", seqBody("E32", 1, 10), cookie)).status).toBe(
        403,
      );
      expect((await get("/v1/company", cookie)).status).toBe(200); // puede leerlos
    });
  });

  describe("borradores", () => {
    it("calcula los totales en el servidor e ignora los que envíe el cliente", async () => {
      const b = await billing("d1");
      const d = await createDraft(b, { total: "1.00", totals: { total: "1.00" } });
      expect(d.status).toBe("DRAFT");
      expect(d.encf).toBeNull();
      expect(d.totals).toMatchObject({
        base18: "200.00",
        tax18: "36.00",
        tax: "36.00",
        total: "236.00",
      });
      expect(d.lines[0]).toMatchObject({
        name: "Producto 118",
        quantity: "2",
        unitPrice: "118.00",
        total: "236.00",
      });
    });

    it("aplica descuentos antes del impuesto", async () => {
      const b = await billing("d2");
      const d = await createDraft(b, {
        lines: [
          {
            productId: b.product.id,
            quantity: "2",
            discount: { type: "percent", bps: 1000 },
          },
        ],
        payments: [],
      });
      expect(d.totals).toMatchObject({
        discount: "23.60",
        total: "212.40",
        tax: "32.40",
      });
    });

    it("copia los datos del producto: cambiar el precio después no altera el comprobante", async () => {
      const b = await billing("d3");
      const d = await createDraft(b);
      await patch(
        `/v1/products/${b.product.id}`,
        { price: "999.00", name: "Renombrado" },
        b.cookie,
      );
      const again = (await json(await get(`/v1/documents/${d.id}`, b.cookie))).data;
      expect(again.lines[0]).toMatchObject({ name: "Producto 118", unitPrice: "118.00" });
      expect(again.totals.total).toBe("236.00");
    });

    it("valida las líneas", async () => {
      const b = await billing("d4");
      const lines = (l: Json[]) =>
        post("/v1/documents", draftBody(b, { lines: l, payments: [] }), b.cookie);

      // Sin producto, hay que dar nombre, precio e impuesto.
      expect((await lines([{ quantity: "1", name: "Servicio" }])).status).toBe(422);
      const manual = await lines([
        { quantity: "1", name: "Servicio", unitPrice: "100.00", tax: "ITBIS18" },
      ]);
      expect(manual.status).toBe(201);
      expect((await json(manual)).data.totals.total).toBe("118.00");

      expect((await lines([{ productId: randomUUID(), quantity: "1" }])).status).toBe(
        422,
      );
      expect((await lines([{ productId: b.product.id, quantity: "1.5" }])).status).toBe(
        422,
      ); // no admite decimales
      expect((await lines([{ productId: b.product.id, quantity: "0" }])).status).toBe(
        422,
      );
      expect((await lines([])).status).toBe(400);
      expect(
        (
          await lines([
            {
              productId: b.product.id,
              quantity: "1",
              discount: { type: "amount", amount: "500.00" },
            },
          ])
        ).status,
      ).toBe(422); // descuento mayor que la línea

      await call(`/v1/products/${b.product.id}`, { method: "DELETE", cookie: b.cookie });
      expect((await lines([{ productId: b.product.id, quantity: "1" }])).status).toBe(
        422,
      ); // producto inactivo
    });

    it("exige tasa de cambio solo en dólares", async () => {
      const b = await billing("d5");
      const usd = (rate: string) =>
        post(
          "/v1/documents",
          draftBody(b, { currency: "USD", exchangeRate: rate, payments: [] }),
          b.cookie,
        );
      expect((await usd("1")).status).toBe(400);
      const ok = await usd("58.75");
      expect(ok.status).toBe(201);
      expect((await json(ok)).data.exchangeRate).toBe("58.75");
      expect(
        (
          await post(
            "/v1/documents",
            draftBody(b, { exchangeRate: "58.75", payments: [] }),
            b.cookie,
          )
        ).status,
      ).toBe(400);
    });

    it("se puede reemplazar y eliminar mientras es borrador", async () => {
      const b = await billing("d6");
      const d = await createDraft(b);
      const put = await send(
        "PUT",
        `/v1/documents/${d.id}`,
        draftBody(b, {
          lines: [{ productId: b.product.id, quantity: "1" }],
          payments: [],
        }),
        b.cookie,
      );
      expect(put.status).toBe(200);
      const updated = (await json(put)).data;
      expect(updated.lines).toHaveLength(1);
      expect(updated.totals.total).toBe("118.00");
      expect(updated.payments).toHaveLength(0);

      expect(
        (await call(`/v1/documents/${d.id}`, { method: "DELETE", cookie: b.cookie }))
          .status,
      ).toBe(204);
      expect((await get(`/v1/documents/${d.id}`, b.cookie)).status).toBe(404);
    });

    it("rechaza sucursales, cajas y clientes de otra empresa", async () => {
      const a = await billing("d7a");
      const other = await billing("d7b");
      const customer = (
        await json(await post("/v1/customers", { name: "De A" }, a.cookie))
      ).data;

      const forBranch = await post(
        "/v1/documents",
        draftBody(other, { branchId: a.branch.id }),
        other.cookie,
      );
      expect(forBranch.status).toBe(422);
      const forCustomer = await post(
        "/v1/documents",
        draftBody(other, { customerId: customer.id }),
        other.cookie,
      );
      expect(forCustomer.status).toBe(422);
    });
  });

  describe("emisión", () => {
    it("exige los datos fiscales de la empresa", async () => {
      const b = await billing("e1", { profile: false, seqs: [["E32", 1, 10]] });
      const d = await createDraft(b);
      const res = await issue(b, d.id);
      expect(res.status).toBe(422);
      expect(await error(res)).toMatch(/datos fiscales/i);
    });

    it("exige una secuencia vigente del tipo correspondiente", async () => {
      const b = await billing("e2");
      const d = await createDraft(b);
      const none = await issue(b, d.id);
      expect(none.status).toBe(422);
      expect(await error(none)).toMatch(/secuencia/i);

      // Una secuencia vencida no sirve.
      await post(
        "/v1/sequences",
        seqBody("E32", 1, 10, { expiresAt: "2020-01-01" }),
        b.cookie,
      );
      expect((await issue(b, d.id)).status).toBe(422);
      // Una de otro tipo tampoco.
      await post("/v1/sequences", seqBody("E31", 1, 10), b.cookie);
      expect((await issue(b, d.id)).status).toBe(422);
      // El borrador sigue intacto y se puede emitir al registrar una secuencia válida.
      await post("/v1/sequences", seqBody("E32", 100, 110), b.cookie);
      const ok = await issue(b, d.id);
      expect(ok.status).toBe(200);
      expect((await json(ok)).data.encf).toBe("E320000000100");
    });

    it("emite con e-NCF consecutivo y congela el comprobante", async () => {
      const b = await billing("e3", { seqs: [["E32", 1, 2]] });
      const first = await issue(b, (await createDraft(b)).id);
      expect(first.status).toBe(200);
      const doc = (await json(first)).data;
      expect(doc).toMatchObject({ status: "ISSUED", encf: "E320000000001" });
      expect(doc.issuedAt).toBeTruthy();

      expect((await json(await issue(b, (await createDraft(b)).id))).data.encf).toBe(
        "E320000000002",
      );

      // Rango agotado.
      const third = await issue(b, (await createDraft(b)).id);
      expect(third.status).toBe(422);

      // Un comprobante emitido no se modifica, no se elimina ni se vuelve a emitir.
      expect(
        (await send("PUT", `/v1/documents/${doc.id}`, draftBody(b), b.cookie)).status,
      ).toBe(409);
      expect(
        (await call(`/v1/documents/${doc.id}`, { method: "DELETE", cookie: b.cookie }))
          .status,
      ).toBe(409);
      expect((await issue(b, doc.id)).status).toBe(409);
    });

    it("exige que los pagos sumen el total", async () => {
      const b = await billing("e4", { seqs: [["E32", 1, 10]] });
      const short = await createDraft(b, {
        payments: [{ method: "CASH", amount: "100.00" }],
      });
      const res = await issue(b, short.id);
      expect(res.status).toBe(422);
      expect(await error(res)).toMatch(/pagos/i);

      const none = await createDraft(b, { payments: [] });
      expect((await issue(b, none.id)).status).toBe(422);

      const mixed = await createDraft(b, {
        payments: [
          { method: "CASH", amount: "136.00" },
          { method: "CARD", amount: "100.00", reference: "AUTH-123" },
        ],
      });
      expect((await issue(b, mixed.id)).status).toBe(200);
    });

    it("prefiere la secuencia de la caja sobre la general", async () => {
      const b = await billing("e5", { seqs: [["E32", 1, 100]] });
      const terminal = (
        await json(
          await post(
            "/v1/terminals",
            { branchId: b.branch.id, name: "Caja 1", code: "C1" },
            b.cookie,
          ),
        )
      ).data;
      expect(
        (
          await post(
            "/v1/sequences",
            seqBody("E32", 500, 510, { terminalId: terminal.id }),
            b.cookie,
          )
        ).status,
      ).toBe(201);

      const withTerminal = await createDraft(b, { terminalId: terminal.id });
      expect((await json(await issue(b, withTerminal.id))).data.encf).toBe(
        "E320000000500",
      );
      const without = await createDraft(b);
      expect((await json(await issue(b, without.id))).data.encf).toBe("E320000000001");
    });

    it("no duplica e-NCF cuando varias cajas emiten a la vez", async () => {
      const b = await billing("e6", { seqs: [["E32", 1, 50]] });
      const drafts = await Promise.all(Array.from({ length: 8 }, () => createDraft(b)));
      const results = await Promise.all(drafts.map((d) => issue(b, d.id)));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));

      const encfs = (
        await Promise.all(results.map(async (r) => (await json(r)).data.encf as string))
      ).sort();
      expect(encfs).toEqual(
        Array.from({ length: 8 }, (_, i) => `E32${String(i + 1).padStart(10, "0")}`),
      );
      expect((await json(await get("/v1/sequences", b.cookie))).data[0].nextNumber).toBe(
        9,
      );
    });

    it("la factura de crédito fiscal (E31) exige un cliente con RNC", async () => {
      const b = await billing("e7", { seqs: [["E31", 1, 10]] });
      const consumer = (
        await json(
          await post(
            "/v1/customers",
            { name: "Juan", documentType: "CEDULA", documentNumber: "00112345678" },
            b.cookie,
          ),
        )
      ).data;
      const company = (
        await json(
          await post(
            "/v1/customers",
            { name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" },
            b.cookie,
          ),
        )
      ).data;

      const noCustomer = await createDraft(b, { type: "E31" });
      expect(await error(await issue(b, noCustomer.id))).toMatch(/RNC/);
      const cedula = await createDraft(b, { type: "E31", customerId: consumer.id });
      expect((await issue(b, cedula.id)).status).toBe(422);

      const ok = await createDraft(b, { type: "E31", customerId: company.id });
      const issued = (await json(await issue(b, ok.id))).data;
      expect(issued).toMatchObject({
        encf: "E310000000001",
        buyerName: "Acme SRL",
        buyerDocType: "RNC",
        buyerDocNumber: "131246796",
      });
    });

    it("las facturas de consumo desde RD$250,000 exigen identificar al comprador", async () => {
      const b = await billing("e8", { seqs: [["E32", 1, 10]] });
      const big = {
        lines: [{ name: "Equipo", unitPrice: "300000.00", tax: "EXENTO", quantity: "1" }],
        payments: [{ method: "TRANSFER", amount: "300000.00" }],
      };
      const anonymous = await createDraft(b, big);
      const res = await issue(b, anonymous.id);
      expect(res.status).toBe(422);
      expect(await error(res)).toMatch(/250,000/);

      const identified = await createDraft(b, {
        ...big,
        buyer: { name: "Juan Pérez", docType: "CEDULA", docNumber: "001-1234567-8" },
      });
      const issued = (await json(await issue(b, identified.id))).data;
      expect(issued).toMatchObject({ status: "ISSUED", buyerDocNumber: "00112345678" });

      // Por debajo del umbral no hace falta.
      const small = await createDraft(b);
      expect((await issue(b, small.id)).status).toBe(200);
    });

    it("toma el comprador de la ficha del cliente al momento de emitir", async () => {
      const b = await billing("e9", { seqs: [["E32", 1, 10]] });
      const customer = (
        await json(await post("/v1/customers", { name: "Nombre Viejo" }, b.cookie))
      ).data;
      const d = await createDraft(b, { customerId: customer.id });
      expect(d.buyerName).toBe("Nombre Viejo");
      await patch(`/v1/customers/${customer.id}`, { name: "Nombre Nuevo" }, b.cookie);
      expect((await json(await issue(b, d.id))).data.buyerName).toBe("Nombre Nuevo");
      // Después de emitido, la ficha puede cambiar sin tocar el comprobante.
      await patch(`/v1/customers/${customer.id}`, { name: "Otro más" }, b.cookie);
      expect(
        (await json(await get(`/v1/documents/${d.id}`, b.cookie))).data.buyerName,
      ).toBe("Nombre Nuevo");
    });
  });

  describe("notas de crédito y débito", () => {
    /** Factura de consumo emitida por RD$236.00 lista para ser modificada. */
    async function issuedInvoice(label: string) {
      const b = await billing(label, {
        seqs: [
          ["E32", 1, 20],
          ["E34", 1, 20],
          ["E33", 1, 20],
        ],
      });
      const customer = (
        await json(
          await post(
            "/v1/customers",
            { name: "Cliente Nota", documentType: "RNC", documentNumber: "101001577" },
            b.cookie,
          ),
        )
      ).data;
      const invoice = await createDraft(b, {
        customerId: customer.id,
        currency: "USD",
        exchangeRate: "58.50",
      });
      const original = (await json(await issue(b, invoice.id))).data as Json;
      return { b, original };
    }
    const note = (b: Billing, original: Json, amount: string, over: Json = {}) =>
      createDraft(b, {
        type: "E34",
        referencedDocumentId: original.id,
        modificationCode: 3,
        lines: [{ name: "Ajuste", unitPrice: amount, tax: "EXENTO", quantity: "1" }],
        payments: [],
        ...over,
      });

    it("hereda comprador y moneda del comprobante original", async () => {
      const { b, original } = await issuedInvoice("n1");
      const n = await note(b, original, "50.00");
      expect(n).toMatchObject({
        type: "E34",
        referencedEncf: original.encf,
        buyerName: "Cliente Nota",
        currency: "USD",
        exchangeRate: "58.5",
        modificationCode: 3,
      });
      const issued = (await json(await issue(b, n.id))).data;
      expect(issued.encf).toBe("E340000000001");
    });

    it("no permite acreditar más que el total del original", async () => {
      const { b, original } = await issuedInvoice("n2");
      expect((await issue(b, (await note(b, original, "50.00")).id)).status).toBe(200);

      const tooMuch = await issue(b, (await note(b, original, "200.00")).id);
      expect(tooMuch.status).toBe(422);
      expect(await error(tooMuch)).toMatch(/excede/);

      expect((await issue(b, (await note(b, original, "186.00")).id)).status).toBe(200); // lo que queda
      expect((await issue(b, (await note(b, original, "0.01")).id)).status).toBe(422); // ya no queda nada
    });

    it("el código 1 (anular) exige acreditar el total completo", async () => {
      const { b, original } = await issuedInvoice("n3");
      const partial = await note(b, original, "100.00", { modificationCode: 1 });
      expect(await error(await issue(b, partial.id))).toMatch(/anular/i);

      const full = await note(b, original, "236.00", { modificationCode: 1 });
      expect((await issue(b, full.id)).status).toBe(200);
    });

    it("una nota de débito no tiene tope", async () => {
      const { b, original } = await issuedInvoice("n4");
      const debit = await note(b, original, "500.00", { type: "E33" });
      const issued = (await json(await issue(b, debit.id))).data;
      expect(issued).toMatchObject({ type: "E33", encf: "E330000000001" });
    });

    it("exige un comprobante emitido y los datos de modificación", async () => {
      const b = await billing("n5", {
        seqs: [
          ["E32", 1, 5],
          ["E34", 1, 5],
        ],
      });
      const draft = await createDraft(b);

      const body = (over: Json) =>
        post(
          "/v1/documents",
          draftBody(b, {
            type: "E34",
            lines: [{ name: "x", unitPrice: "10", tax: "EXENTO", quantity: "1" }],
            payments: [],
            ...over,
          }),
          b.cookie,
        );
      expect((await body({})).status).toBe(400); // sin referencia
      expect(
        (await body({ referencedDocumentId: draft.id, modificationCode: 3 })).status,
      ).toBe(422); // aún es borrador
      expect(
        (await body({ referencedDocumentId: randomUUID(), modificationCode: 3 })).status,
      ).toBe(422);
      expect((await body({ referencedDocumentId: draft.id })).status).toBe(400); // sin código
      // Un comprobante normal no puede traer referencia.
      expect(
        (
          await post(
            "/v1/documents",
            draftBody(b, { referencedDocumentId: draft.id, modificationCode: 3 }),
            b.cookie,
          )
        ).status,
      ).toBe(400);
    });

    it("no se pueden referenciar comprobantes de otra empresa", async () => {
      const { original } = await issuedInvoice("n6a");
      const other = await billing("n6b", { seqs: [["E34", 1, 5]] });
      const res = await post(
        "/v1/documents",
        draftBody(other, {
          type: "E34",
          referencedDocumentId: original.id,
          modificationCode: 3,
          lines: [{ name: "x", unitPrice: "10", tax: "EXENTO", quantity: "1" }],
          payments: [],
        }),
        other.cookie,
      );
      expect(res.status).toBe(422);
    });
  });

  describe("consulta, aislamiento y roles", () => {
    it("lista y filtra comprobantes", async () => {
      const b = await billing("l1", {
        seqs: [
          ["E32", 1, 10],
          ["E31", 1, 10],
        ],
      });
      const customer = (
        await json(
          await post(
            "/v1/customers",
            {
              name: "Distribuidora Norte",
              documentType: "RNC",
              documentNumber: "131246796",
            },
            b.cookie,
          ),
        )
      ).data;
      await createDraft(b); // borrador
      const e32 = await createDraft(b);
      await issue(b, e32.id);
      const e31 = await createDraft(b, { type: "E31", customerId: customer.id });
      await issue(b, e31.id);

      const all = await json(await get("/v1/documents", b.cookie));
      expect(all.total).toBe(3);
      expect(all.data[0].total).toBe("236.00");

      const ids = async (qs: string) =>
        (await json(await get(`/v1/documents?${qs}`, b.cookie))).data.map(
          (d: Json) => d.id,
        );
      expect(await ids("status=DRAFT")).toHaveLength(1);
      expect(await ids("type=E31")).toEqual([e31.id]);
      expect(await ids("q=E310000000001")).toEqual([e31.id]);
      expect(await ids("q=norte")).toEqual([e31.id]);
      expect(await ids("q=131-24679-6")).toEqual([e31.id]);
      expect(await ids(`customerId=${customer.id}`)).toEqual([e31.id]);
      expect(await ids("pageSize=2")).toHaveLength(2);
      expect(await ids("from=2099-01-01")).toEqual([]);
    });

    it("otra empresa no ve, emite ni elimina los comprobantes ajenos", async () => {
      const a = await billing("i1a", { seqs: [["E32", 1, 10]] });
      const b = await billing("i1b", { seqs: [["E32", 1, 10]] });
      const draft = await createDraft(a);
      const issued = await createDraft(a);
      await issue(a, issued.id);

      for (const id of [draft.id, issued.id]) {
        expect((await get(`/v1/documents/${id}`, b.cookie)).status).toBe(404);
        expect((await issue(b, id)).status).toBe(404);
        expect(
          (await call(`/v1/documents/${id}`, { method: "DELETE", cookie: b.cookie }))
            .status,
        ).toBe(404);
        expect(
          (await send("PUT", `/v1/documents/${id}`, draftBody(b), b.cookie)).status,
        ).toBe(404);
      }
      expect((await json(await get("/v1/documents", b.cookie))).total).toBe(0);
      // Cada empresa usa su propia numeración.
      expect((await json(await issue(b, (await createDraft(b)).id))).data.encf).toBe(
        "E320000000001",
      );
    });

    it("el cajero puede crear y emitir, y todo queda en la bitácora", async () => {
      const boss = await billing("rl1", { seqs: [["E32", 1, 10]] });
      const cashier = await signUp("rl1c");
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: boss.orgId,
          userId: cashier.userId,
          role: "member",
        },
      });
      const cookie = await setActive(boss.orgId, cashier.cookie);

      const created = await post("/v1/documents", draftBody(boss), cookie);
      expect(created.status).toBe(201);
      const id = (await json(created)).data.id;
      expect((await post(`/v1/documents/${id}/issue`, {}, cookie)).status).toBe(200);

      const logs = await withTenant(prisma, boss.orgId).auditLog.findMany({
        where: { entity: "document" },
        orderBy: { createdAt: "asc" },
      });
      expect(logs.map((l) => l.action)).toEqual(["document.create", "document.issue"]);
      expect(logs.every((l) => l.actorUserId === cashier.userId)).toBe(true);
    });

    it("sin sesión no se accede a nada de facturación", async () => {
      for (const path of ["/v1/documents", "/v1/sequences", "/v1/company"]) {
        expect((await get(path)).status).toBe(401);
      }
    });
  });

  describe("equipo e invitaciones", () => {
    const invite = (cookie: string, email: string, role = "member") =>
      post("/api/auth/organization/invite-member", { email, role }, cookie);
    const accept = (cookie: string, invitationId: string) =>
      post("/api/auth/organization/accept-invitation", { invitationId }, cookie);

    /** Dueño + una persona que ya tiene cuenta (con su propia empresa vacía) lista para ser invitada. */
    async function team(label: string) {
      const boss = await billing(label, { seqs: [["E32", 1, 20]] });
      const guest = await signUp(`${label}g`);
      const email = `${label}g-${tag}@example.com`;
      return { boss, guest, email };
    }

    it("el dueño invita a un cajero, que acepta y trabaja con permisos limitados", async () => {
      const { boss, guest, email } = await team("q1");
      const res = await invite(boss.cookie, email);
      expect(res.status).toBe(200);
      const invitation = await json(res);
      expect(invitation).toMatchObject({ email, role: "member", status: "pending" });

      // Aún sin aceptar no tiene acceso.
      expect((await get("/v1/documents", guest.cookie)).status).toBe(409);

      expect((await accept(guest.cookie, invitation.id)).status).toBe(200);
      const cookie = await setActive(boss.orgId, guest.cookie);

      const draft = await post("/v1/documents", draftBody(boss), cookie);
      expect(draft.status).toBe(201);
      expect(
        (await post(`/v1/documents/${(await json(draft)).data.id}/issue`, {}, cookie))
          .status,
      ).toBe(200);
      expect((await post("/v1/sequences", seqBody("E31", 1, 5), cookie)).status).toBe(
        403,
      );
      expect((await invite(cookie, `otro-${tag}@example.com`)).status).toBe(403);

      const members = await json(
        await get(
          `/api/auth/organization/list-members?organizationId=${boss.orgId}`,
          boss.cookie,
        ),
      );
      expect(members.members.map((m: Json) => m.role).sort()).toEqual([
        "member",
        "owner",
      ]);
    });

    it("solo puede aceptar quien recibió la invitación", async () => {
      const { boss, email } = await team("q2");
      const stranger = await signUp("q2x");
      const invitation = await json(await invite(boss.cookie, email));
      expect((await accept(stranger.cookie, invitation.id)).status).toBe(403);
    });

    it("una invitación cancelada ya no se puede aceptar", async () => {
      const { boss, guest, email } = await team("q3");
      const invitation = await json(await invite(boss.cookie, email));

      const pending = await json(
        await get(
          `/api/auth/organization/list-invitations?organizationId=${boss.orgId}`,
          boss.cookie,
        ),
      );
      expect(pending.map((i: Json) => i.id)).toContain(invitation.id);

      expect(
        (
          await post(
            "/api/auth/organization/cancel-invitation",
            { invitationId: invitation.id },
            boss.cookie,
          )
        ).status,
      ).toBe(200);
      expect((await accept(guest.cookie, invitation.id)).status).not.toBe(200);
    });

    it("cambiar el rol a administrador le da acceso a la configuración fiscal", async () => {
      const { boss, guest, email } = await team("q4");
      const invitation = await json(await invite(boss.cookie, email));
      await accept(guest.cookie, invitation.id);
      const cookie = await setActive(boss.orgId, guest.cookie);
      expect((await post("/v1/sequences", seqBody("E31", 1, 5), cookie)).status).toBe(
        403,
      );

      const members = await json(
        await get(
          `/api/auth/organization/list-members?organizationId=${boss.orgId}`,
          boss.cookie,
        ),
      );
      const member = members.members.find((m: Json) => m.role === "member");
      const upd = await post(
        "/api/auth/organization/update-member-role",
        { memberId: member.id, role: "admin" },
        boss.cookie,
      );
      expect(upd.status).toBe(200);

      expect((await post("/v1/sequences", seqBody("E31", 1, 5), cookie)).status).toBe(
        201,
      );
    });

    it("al quitar a un miembro pierde el acceso de inmediato", async () => {
      const { boss, guest, email } = await team("q5");
      const invitation = await json(await invite(boss.cookie, email));
      await accept(guest.cookie, invitation.id);
      const cookie = await setActive(boss.orgId, guest.cookie);
      expect((await get("/v1/documents", cookie)).status).toBe(200);

      const rm = await post(
        "/api/auth/organization/remove-member",
        { memberIdOrEmail: email },
        boss.cookie,
      );
      expect(rm.status).toBe(200);
      expect((await get("/v1/documents", cookie)).status).toBe(403);
      expect((await get("/v1/branches", cookie)).status).toBe(403);
    });

    it("no se puede invitar a quien ya es miembro, ni quitar al único dueño", async () => {
      const { boss, guest, email } = await team("q6");
      const invitation = await json(await invite(boss.cookie, email));
      await accept(guest.cookie, invitation.id);
      expect((await invite(boss.cookie, email)).status).toBe(400);

      const bossEmail = `q6-${tag}@example.com`;
      const rm = await post(
        "/api/auth/organization/remove-member",
        { memberIdOrEmail: bossEmail },
        boss.cookie,
      );
      expect(rm.status).not.toBe(200);
    });
  });

  describe("reportes de ventas", () => {
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Santo_Domingo",
    }).format(new Date());
    const range = (from = today, to = today, extra = "") =>
      `from=${from}&to=${to}${extra}`;

    /** Escenario: 2 facturas en pesos, 1 en dólares, 1 nota de crédito y 1 borrador. */
    async function scenario(label: string) {
      const b = await billing(label, {
        seqs: [
          ["E32", 1, 50],
          ["E34", 1, 50],
        ],
      });
      const first = await issue(b, (await createDraft(b)).id); // 2 × 118.00 con ITBIS = 236.00 (ITBIS 36.00)
      const original = (await json(first)).data as Json;
      await issue(
        b,
        (
          await createDraft(b, {
            lines: [
              {
                name: "Servicio de flete",
                unitPrice: "100.00",
                tax: "EXENTO",
                quantity: "1",
              },
            ],
            payments: [{ method: "TRANSFER", amount: "100.00" }],
          })
        ).id,
      );
      await issue(
        b,
        (
          await createDraft(b, {
            currency: "USD",
            exchangeRate: "60",
            lines: [
              {
                name: "Servicio en dólares",
                unitPrice: "10.00",
                tax: "EXENTO",
                quantity: "1",
              },
            ],
            payments: [{ method: "CARD", amount: "10.00" }],
          })
        ).id,
      ); // US$10.00 × 60 = RD$600.00
      await issue(
        b,
        (
          await createDraft(b, {
            type: "E34",
            referencedDocumentId: original.id,
            modificationCode: 3,
            lines: [{ name: "Ajuste", unitPrice: "50.00", tax: "EXENTO", quantity: "1" }],
            payments: [],
          })
        ).id,
      );
      await createDraft(b); // el borrador no cuenta
      return b;
    }

    it("suma lo emitido, resta las notas de crédito y convierte los dólares a pesos", async () => {
      const b = await scenario("s1");
      const res = await get(`/v1/reports/sales?${range()}`, b.cookie);
      expect(res.status).toBe(200);
      const { data } = await json(res);

      // 236.00 + 100.00 + 600.00 − 50.00
      expect(data.totals).toMatchObject({
        documents: 4,
        net: "886.00",
        tax: "36.00",
        propina: "0.00",
      });
      expect(data.series).toHaveLength(1);
      expect(data.series[0]).toMatchObject({ period: today, count: 4, total: "886.00" });

      const type = (t: string) => data.byType.find((r: Json) => r.type === t);
      expect(type("E32")).toMatchObject({ count: 3, total: "936.00", tax: "36.00" });
      expect(type("E34")).toMatchObject({ count: 1, total: "50.00" });
    });

    it("desglosa el ITBIS por tasa y las ventas por forma de pago", async () => {
      const b = await scenario("s2");
      const { data } = await json(await get(`/v1/reports/sales?${range()}`, b.cookie));
      // Base 200.00 con ITBIS 18 %; exentos: 100.00 + 600.00 − 50.00 de la nota.
      expect(data.taxes).toMatchObject({
        base18: "200.00",
        tax18: "36.00",
        base16: "0.00",
        exempt: "650.00",
      });
      const pay = Object.fromEntries(
        data.payments.map((p: Json) => [p.method, p.amount]),
      );
      expect(pay).toEqual({ CARD: "600.00", CASH: "236.00", TRANSFER: "100.00" });
    });

    it("lista los productos más vendidos sin contar las notas de crédito", async () => {
      const b = await scenario("s3");
      const { data } = await json(await get(`/v1/reports/sales?${range()}`, b.cookie));
      expect(data.topProducts[0]).toMatchObject({
        name: "Servicio en dólares",
        total: "600.00",
      });
      const normal = data.topProducts.find((p: Json) => p.name === "Producto 118");
      expect(normal).toMatchObject({ quantity: "2", total: "236.00" });
      expect(data.topProducts.some((p: Json) => p.name === "Ajuste")).toBe(false);
    });

    it("respeta el rango de fechas y agrupa por mes", async () => {
      const b = await scenario("s4");
      const past = await json(
        await get(`/v1/reports/sales?${range("2020-01-01", "2020-12-31")}`, b.cookie),
      );
      expect(past.data.totals).toMatchObject({ documents: 0, net: "0.00" });
      expect(past.data.series).toEqual([]);

      const month = await json(
        await get(
          `/v1/reports/sales?${range(`${today.slice(0, 7)}-01`, today, "&groupBy=month")}`,
          b.cookie,
        ),
      );
      expect(month.data.series).toHaveLength(1);
      expect(month.data.series[0]).toMatchObject({
        period: `${today.slice(0, 7)}-01`,
        count: 4,
      });
    });

    it("valida el rango", async () => {
      const b = await billing("s5");
      expect(
        (await get(`/v1/reports/sales?${range("2026-02-01", "2026-01-01")}`, b.cookie))
          .status,
      ).toBe(400);
      expect(
        (await get(`/v1/reports/sales?${range("2024-01-01", "2026-01-01")}`, b.cookie))
          .status,
      ).toBe(400);
      expect((await get("/v1/reports/sales?from=hoy&to=mañana", b.cookie)).status).toBe(
        400,
      );
    });

    it("exporta un CSV con los comprobantes emitidos", async () => {
      const b = await scenario("s6");
      const res = await get(`/v1/reports/sales.csv?${range()}`, b.cookie);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/csv");
      expect(res.headers.get("content-disposition")).toContain(
        `ventas-${today}_${today}.csv`,
      );

      const lines = (await res.text()).replace("﻿", "").trim().split("\r\n");
      expect(lines[0]).toContain("e-NCF");
      expect(lines).toHaveLength(1 + 4); // encabezado + 4 emitidos (el borrador no sale)
      expect(
        lines.some((l) => l.includes("E340000000001") && l.includes("E320000000001")),
      ).toBe(true);
      expect(lines.some((l) => l.includes("USD") && l.includes("60"))).toBe(true);
    });

    it("neutraliza fórmulas en el CSV", async () => {
      const b = await billing("s7", { seqs: [["E32", 1, 5]] });
      const d = await createDraft(b, { buyer: { name: '=HYPERLINK("http://x")' } });
      await issue(b, d.id);
      const csv = await (await get(`/v1/reports/sales.csv?${range()}`, b.cookie)).text();
      expect(csv).toContain("'=HYPERLINK");
      expect(csv).not.toMatch(/,=HYPERLINK/);
    });

    it("solo propietarios y administradores, y cada empresa ve lo suyo", async () => {
      const a = await scenario("s8a");
      const other = await billing("s8b");
      const cashier = await signUp("s8c");
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: a.orgId,
          userId: cashier.userId,
          role: "member",
        },
      });
      const cookie = await setActive(a.orgId, cashier.cookie);

      expect((await get(`/v1/reports/sales?${range()}`, cookie)).status).toBe(403);
      expect((await get(`/v1/reports/sales.csv?${range()}`, cookie)).status).toBe(403);
      expect((await get(`/v1/reports/sales?${range()}`)).status).toBe(401);

      const mine = await json(await get(`/v1/reports/sales?${range()}`, other.cookie));
      expect(mine.data.totals.documents).toBe(0);
    });
  });

  describe("inventario", () => {
    /** Empresa lista para facturar con un producto que controla inventario (precio RD$100.00 exento). */
    async function stocked(
      label: string,
      opts: { min?: string; decimals?: boolean } = {},
    ) {
      const b = await billing(label, {
        seqs: [
          ["E32", 1, 100],
          ["E34", 1, 100],
        ],
      });
      const tracked = (
        await json(
          await post(
            "/v1/products",
            {
              name: "Martillo",
              price: "100.00",
              tax: "EXENTO",
              trackInventory: true,
              minStock: opts.min ?? "0",
              allowsDecimals: opts.decimals ?? false,
            },
            b.cookie,
          ),
        )
      ).data;
      return { ...b, tracked };
    }
    type Stocked = Awaited<ReturnType<typeof stocked>>;

    const receipt = (s: Stocked, qty: string, extra: Json = {}) =>
      post(
        "/v1/inventory/receipts",
        { productId: s.tracked.id, branchId: s.branch.id, quantity: qty, ...extra },
        s.cookie,
      );
    const adjust = (s: Stocked, mode: string, qty: string, reason = "Conteo de prueba") =>
      post(
        "/v1/inventory/adjustments",
        { productId: s.tracked.id, branchId: s.branch.id, mode, quantity: qty, reason },
        s.cookie,
      );
    const onHand = async (s: Stocked) => {
      const res = await json(
        await get(`/v1/inventory/stock?branchId=${s.branch.id}`, s.cookie),
      );
      return res.data.find((r: Json) => r.productId === s.tracked.id)?.quantity as
        string | undefined;
    };
    const sell = async (s: Stocked, qty: string, over: Json = {}) => {
      const total = (Number(qty) * 100).toFixed(2);
      const d = await createDraft(s, {
        lines: [{ productId: s.tracked.id, quantity: qty }],
        payments: [{ method: "CASH", amount: total }],
        ...over,
      });
      return issue(s, d.id);
    };
    const setNegative = (s: Stocked, allow: boolean) =>
      send("PATCH", "/v1/inventory/settings", { allowNegativeStock: allow }, s.cookie);

    it("el producto guarda si controla inventario y su mínimo", async () => {
      const s = await stocked("v1", { min: "5" });
      expect(s.tracked).toMatchObject({ trackInventory: true, minStock: "5" });
      const upd = await patch(
        `/v1/products/${s.tracked.id}`,
        { minStock: "8.5" },
        s.cookie,
      );
      expect((await json(upd)).data).toMatchObject({
        trackInventory: true,
        minStock: "8.5",
        name: "Martillo",
      });
      const plain = (
        await json(
          await post("/v1/products", { name: "Sin control", price: "5" }, s.cookie),
        )
      ).data;
      expect(plain).toMatchObject({ trackInventory: false, minStock: "0" });
    });

    it("las entradas suman y quedan en el libro con el saldo resultante", async () => {
      const s = await stocked("v2");
      expect(await onHand(s)).toBe("0");

      const first = await receipt(s, "20", {
        unitCost: "55.50",
        reason: "Compra a proveedor",
      });
      expect(first.status).toBe(201);
      expect((await json(first)).data.balance).toBe("20");
      await receipt(s, "5");
      expect(await onHand(s)).toBe("25");

      const moves = await json(
        await get(`/v1/inventory/movements?productId=${s.tracked.id}`, s.cookie),
      );
      expect(moves.total).toBe(2);
      expect(moves.data[0]).toMatchObject({
        type: "RECEIPT",
        quantity: "5",
        balanceAfter: "25",
      });
      expect(moves.data[1]).toMatchObject({
        quantity: "20",
        unitCost: "55.50",
        reason: "Compra a proveedor",
      });
      expect(moves.data[0].product.name).toBe("Martillo");
    });

    it("valida entradas y exige que el producto controle inventario", async () => {
      const s = await stocked("v3");
      expect((await receipt(s, "0")).status).toBe(422);
      expect((await receipt(s, "-4")).status).toBe(400);
      expect((await receipt(s, "1.5")).status).toBe(422); // no se vende en fracciones
      const plain = (
        await json(
          await post("/v1/products", { name: "Sin control", price: "5" }, s.cookie),
        )
      ).data;
      const res = await post(
        "/v1/inventory/receipts",
        { productId: plain.id, branchId: s.branch.id, quantity: "3" },
        s.cookie,
      );
      expect(res.status).toBe(422);
      expect(await error(res)).toMatch(/inventario/i);
      expect((await receipt(s, "2", { productId: randomUUID() })).status).toBe(422);
    });

    it("los productos por peso admiten fracciones", async () => {
      const s = await stocked("v4", { decimals: true });
      expect((await receipt(s, "12.5")).status).toBe(201);
      expect(await onHand(s)).toBe("12.5");
      expect((await sell(s, "2.25")).status).toBe(200);
      expect(await onHand(s)).toBe("10.25");
    });

    it("ajusta por diferencia y por conteo, y pide motivo", async () => {
      const s = await stocked("v5");
      await receipt(s, "20");

      expect((await adjust(s, "delta", "-3", "Merma")).status).toBe(201);
      expect(await onHand(s)).toBe("17");

      const count = await adjust(s, "count", "10", "Conteo físico");
      expect((await json(count)).data).toMatchObject({ balance: "10", delta: "-7" });
      expect(await onHand(s)).toBe("10");

      expect((await adjust(s, "count", "10")).status).toBe(422); // ya coincide
      expect((await adjust(s, "count", "-1")).status).toBe(422);
      expect((await adjust(s, "delta", "5", "ab")).status).toBe(400); // motivo muy corto

      const moves = (
        await json(await get("/v1/inventory/movements?type=ADJUSTMENT", s.cookie))
      ).data;
      expect(moves.map((m: Json) => m.quantity)).toEqual(["-7", "-3"]);
      expect(moves[0].reason).toBe("Conteo físico");
    });

    it("emitir una factura descuenta la existencia y enlaza el movimiento con el e-NCF", async () => {
      const s = await stocked("v6");
      await receipt(s, "10");
      const issued = (await json(await sell(s, "3"))).data;
      expect(issued.encf).toBe("E320000000001");
      expect(await onHand(s)).toBe("7");

      const [sale] = (
        await json(await get("/v1/inventory/movements?type=SALE", s.cookie))
      ).data;
      expect(sale).toMatchObject({ quantity: "-3", balanceAfter: "7" });
      expect(sale.document).toMatchObject({ encf: "E320000000001", type: "E32" });
    });

    it("un borrador no toca el inventario ni un producto sin control genera movimientos", async () => {
      const s = await stocked("v7");
      await receipt(s, "10");
      await createDraft(s, {
        lines: [{ productId: s.tracked.id, quantity: "4" }],
        payments: [],
      });
      expect(await onHand(s)).toBe("10");

      await issue(s, (await createDraft(s)).id); // línea de "Producto 118", que no controla inventario
      expect(
        (await json(await get("/v1/inventory/movements?type=SALE", s.cookie))).total,
      ).toBe(0);
    });

    it("por defecto permite vender sin existencia y el saldo queda en negativo", async () => {
      const s = await stocked("v8");
      await receipt(s, "2");
      expect((await sell(s, "5")).status).toBe(200);
      expect(await onHand(s)).toBe("-3");
      const row = (await json(await get("/v1/inventory/stock", s.cookie))).data[0];
      expect(row.status).toBe("OUT");
    });

    it("si se prohíbe vender sin existencia, la emisión falla sin quemar el e-NCF", async () => {
      const s = await stocked("v9");
      expect((await setNegative(s, false)).status).toBe(200);
      await receipt(s, "2");

      const draft = await createDraft(s, {
        lines: [{ productId: s.tracked.id, quantity: "5" }],
        payments: [{ method: "CASH", amount: "500.00" }],
      });
      const res = await issue(s, draft.id);
      expect(res.status).toBe(422);
      expect(await error(res)).toMatch(
        /Sin existencia suficiente de "Martillo" \(disponible: 2\)/,
      );
      expect(await onHand(s)).toBe("2");
      expect(
        (await json(await get(`/v1/documents/${draft.id}`, s.cookie))).data.status,
      ).toBe("DRAFT");

      // El número del comprobante no se consumió: el siguiente sigue siendo el 1.
      expect((await json(await sell(s, "2"))).data.encf).toBe("E320000000001");
      expect(await onHand(s)).toBe("0");
    });

    it("varias cajas vendiendo la última existencia: solo se emiten las que alcanzan", async () => {
      const s = await stocked("v10");
      await setNegative(s, false);
      await receipt(s, "3");
      const drafts = await Promise.all(
        Array.from({ length: 6 }, () =>
          createDraft(s, {
            lines: [{ productId: s.tracked.id, quantity: "1" }],
            payments: [{ method: "CASH", amount: "100.00" }],
          }),
        ),
      );
      const statuses = (await Promise.all(drafts.map((d) => issue(s, d.id))))
        .map((r) => r.status)
        .sort();
      expect(statuses).toEqual([200, 200, 200, 422, 422, 422]);
      expect(await onHand(s)).toBe("0");
      const sales = await json(await get("/v1/inventory/movements?type=SALE", s.cookie));
      expect(sales.total).toBe(3);
    });

    it("anular una factura (nota de crédito código 1) devuelve las existencias; otras notas no", async () => {
      const s = await stocked("v11");
      await receipt(s, "10");
      const sale = (await json(await sell(s, "4"))).data;
      expect(await onHand(s)).toBe("6");

      const partial = await createDraft(s, {
        type: "E34",
        referencedDocumentId: sale.id,
        modificationCode: 3,
        lines: [
          { name: "Ajuste de precio", unitPrice: "50.00", tax: "EXENTO", quantity: "1" },
        ],
        payments: [],
      });
      expect((await issue(s, partial.id)).status).toBe(200);
      expect(await onHand(s)).toBe("6"); // un ajuste de monto no mueve inventario

      // Ya se acreditaron 50.00: la anulación completa del original no es posible; se prueba con otra venta.
      const sale2 = (await json(await sell(s, "2"))).data;
      expect(await onHand(s)).toBe("4");
      const void2 = await createDraft(s, {
        type: "E34",
        referencedDocumentId: sale2.id,
        modificationCode: 1,
        lines: [{ name: "Anulación", unitPrice: "200.00", tax: "EXENTO", quantity: "1" }],
        payments: [],
      });
      expect((await issue(s, void2.id)).status).toBe(200);
      expect(await onHand(s)).toBe("6");

      const ret = (await json(await get("/v1/inventory/movements?type=RETURN", s.cookie)))
        .data;
      expect(ret).toHaveLength(1);
      expect(ret[0]).toMatchObject({ quantity: "2", balanceAfter: "6" });
      expect(ret[0].reason).toMatch(/Anulación de E32/);
    });

    it("filtra stock bajo y agotado, y busca por nombre", async () => {
      const s = await stocked("v12", { min: "5" });
      const other = (
        await json(
          await post(
            "/v1/products",
            { name: "Tornillo", price: "1", trackInventory: true, minStock: "10" },
            s.cookie,
          ),
        )
      ).data;
      await receipt(s, "20"); // Martillo: 20 > 5, OK
      await post(
        "/v1/inventory/receipts",
        { productId: other.id, branchId: s.branch.id, quantity: "4" },
        s.cookie,
      ); // Tornillo: 4 <= 10

      const all = (await json(await get("/v1/inventory/stock", s.cookie))).data;
      expect(Object.fromEntries(all.map((r: Json) => [r.name, r.status]))).toEqual({
        Martillo: "OK",
        Tornillo: "LOW",
      });

      const low = await json(await get("/v1/inventory/stock?low=true", s.cookie));
      expect(low.data.map((r: Json) => r.name)).toEqual(["Tornillo"]);
      expect(low.total).toBe(1);
      expect(
        (await json(await get("/v1/inventory/stock?q=marti", s.cookie))).data,
      ).toHaveLength(1);
      expect(
        (await json(await get("/v1/inventory/stock?q=%25", s.cookie))).data,
      ).toHaveLength(0); // % no es comodín
    });

    it("suma las sucursales cuando no se indica una", async () => {
      const s = await stocked("v13");
      const second = (
        await json(await post("/v1/branches", { name: "Segunda", code: "S2" }, s.cookie))
      ).data;
      await receipt(s, "6");
      await post(
        "/v1/inventory/receipts",
        { productId: s.tracked.id, branchId: second.id, quantity: "4" },
        s.cookie,
      );

      expect(
        (await json(await get("/v1/inventory/stock", s.cookie))).data[0].quantity,
      ).toBe("10");
      expect(
        (await json(await get(`/v1/inventory/stock?branchId=${second.id}`, s.cookie)))
          .data[0].quantity,
      ).toBe("4");
      expect(await onHand(s)).toBe("6");
    });

    it("la configuración exige datos fiscales y solo la cambian los administradores", async () => {
      const noProfile = await billing("v14a", { profile: false });
      expect(
        (
          await send(
            "PATCH",
            "/v1/inventory/settings",
            { allowNegativeStock: false },
            noProfile.cookie,
          )
        ).status,
      ).toBe(422);
      expect(
        (await json(await get("/v1/inventory/settings", noProfile.cookie))).data,
      ).toMatchObject({ configured: false, allowNegativeStock: true });

      const s = await stocked("v14b");
      const cashier = await signUp("v14c");
      await prisma.member.create({
        data: {
          id: randomUUID(),
          organizationId: s.orgId,
          userId: cashier.userId,
          role: "member",
        },
      });
      const cookie = await setActive(s.orgId, cashier.cookie);

      expect(
        (
          await send(
            "PATCH",
            "/v1/inventory/settings",
            { allowNegativeStock: false },
            cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            "/v1/inventory/receipts",
            { productId: s.tracked.id, branchId: s.branch.id, quantity: "1" },
            cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            "/v1/inventory/adjustments",
            {
              productId: s.tracked.id,
              branchId: s.branch.id,
              mode: "delta",
              quantity: "1",
              reason: "intento",
            },
            cookie,
          )
        ).status,
      ).toBe(403);
      // El cajero sí puede consultar las existencias.
      expect((await get("/v1/inventory/stock", cookie)).status).toBe(200);
      expect((await get("/v1/inventory/movements", cookie)).status).toBe(200);
    });

    it("cada empresa ve solo su inventario", async () => {
      const a = await stocked("v15a");
      const b = await stocked("v15b");
      await receipt(a, "9");

      expect((await json(await get("/v1/inventory/movements", b.cookie))).total).toBe(0);
      expect(await onHand(b)).toBe("0");
      // No se puede mover el stock de un producto o sucursal ajenos.
      const steal = await post(
        "/v1/inventory/receipts",
        { productId: a.tracked.id, branchId: b.branch.id, quantity: "5" },
        b.cookie,
      );
      expect(steal.status).toBe(422);
      const stealBranch = await post(
        "/v1/inventory/receipts",
        { productId: b.tracked.id, branchId: a.branch.id, quantity: "5" },
        b.cookie,
      );
      expect(stealBranch.status).toBe(422);
      expect(await onHand(a)).toBe("9");
    });

    it("sin sesión no se accede al inventario", async () => {
      for (const path of [
        "/v1/inventory/stock",
        "/v1/inventory/movements",
        "/v1/inventory/settings",
      ]) {
        expect((await get(path)).status).toBe(401);
      }
    });
  });

  describe("proveedores y compras", () => {
    const todayStr = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "America/Santo_Domingo",
    }).format(new Date());

    /** Empresa con secuencias E41/E43, un proveedor formal, uno informal y un producto con inventario. */
    async function buying(label: string) {
      const b = await billing(label, {
        seqs: [
          ["E32", 1, 50],
          ["E41", 1, 50],
          ["E43", 1, 50],
        ],
      });
      const supplier = (
        await json(
          await post(
            "/v1/suppliers",
            {
              name: "Distribuidora Norte",
              documentType: "RNC",
              documentNumber: "131246796",
            },
            b.cookie,
          ),
        )
      ).data;
      const informal = (
        await json(
          await post(
            "/v1/suppliers",
            {
              name: "Juan Pérez",
              documentType: "CEDULA",
              documentNumber: "001-1234567-8",
            },
            b.cookie,
          ),
        )
      ).data;
      const tracked = (
        await json(
          await post(
            "/v1/products",
            { name: "Martillo", price: "100.00", tax: "EXENTO", trackInventory: true },
            b.cookie,
          ),
        )
      ).data;
      return { ...b, supplier, informal, tracked };
    }
    type Buying = Awaited<ReturnType<typeof buying>>;

    const purchaseBody = (s: Buying, over: Json = {}) => ({
      kind: "SUPPLIER_INVOICE",
      branchId: s.branch.id,
      supplierId: s.supplier.id,
      ncf: "B0100000123",
      invoiceDate: todayStr,
      lines: [
        { productId: s.tracked.id, quantity: "10", unitCost: "50.00", tax: "ITBIS18" },
      ],
      ...over,
    });
    const draftPurchase = async (s: Buying, over: Json = {}) => {
      const res = await post("/v1/purchases", purchaseBody(s, over), s.cookie);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
      return (await json(res)).data as Json;
    };
    const postPurchase = (s: Buying, id: string) =>
      post(`/v1/purchases/${id}/post`, {}, s.cookie);
    const stockOf = async (s: Buying, productId = s.tracked.id) => {
      const rows = (
        await json(await get(`/v1/inventory/stock?branchId=${s.branch.id}`, s.cookie))
      ).data as Json[];
      return rows.find((r) => r.productId === productId)?.quantity as string | undefined;
    };
    const movements = async (s: Buying, type = "RECEIPT") =>
      (await json(await get(`/v1/inventory/movements?type=${type}`, s.cookie)))
        .data as Json[];

    describe("proveedores", () => {
      it("normaliza el documento, evita repetidos y busca", async () => {
        const s = await buying("pv1");
        expect(s.informal).toMatchObject({
          documentType: "CEDULA",
          documentNumber: "00112345678",
        });

        const bad = await post(
          "/v1/suppliers",
          { name: "Mal", documentType: "RNC", documentNumber: "123" },
          s.cookie,
        );
        expect(bad.status).toBe(422);
        const dup = await post(
          "/v1/suppliers",
          { name: "Otro", documentType: "RNC", documentNumber: "1-31-24679-6" },
          s.cookie,
        );
        expect(dup.status).toBe(409);

        expect((await json(await get("/v1/suppliers?q=norte", s.cookie))).total).toBe(1);
        expect((await json(await get("/v1/suppliers?q=131-24679", s.cookie))).total).toBe(
          1,
        );

        const upd = await patch(
          `/v1/suppliers/${s.supplier.id}`,
          { phone: "809-555-0100", active: false },
          s.cookie,
        );
        expect((await json(upd)).data).toMatchObject({
          phone: "809-555-0100",
          active: false,
        });
        expect((await json(await get("/v1/suppliers?active=true", s.cookie))).total).toBe(
          1,
        );
      });

      it("un proveedor inactivo no sirve para comprar", async () => {
        const s = await buying("pv2");
        await patch(`/v1/suppliers/${s.supplier.id}`, { active: false }, s.cookie);
        expect((await post("/v1/purchases", purchaseBody(s), s.cookie)).status).toBe(422);
      });

      it("solo propietarios y administradores; cada empresa ve los suyos", async () => {
        const a = await buying("pv3a");
        const b = await buying("pv3b");
        const cashier = await signUp("pv3c");
        await prisma.member.create({
          data: {
            id: randomUUID(),
            organizationId: a.orgId,
            userId: cashier.userId,
            role: "member",
          },
        });
        const cookie = await setActive(a.orgId, cashier.cookie);

        for (const path of ["/v1/suppliers", "/v1/purchases"])
          expect((await get(path, cookie)).status).toBe(403);
        expect((await post("/v1/suppliers", { name: "X" }, cookie)).status).toBe(403);
        expect((await get(`/v1/suppliers/${a.supplier.id}`, b.cookie)).status).toBe(404);
        // Mismo RNC en otra empresa: permitido.
        expect(
          (
            await post(
              "/v1/suppliers",
              { name: "Igual", documentType: "RNC", documentNumber: "131246796" },
              b.cookie,
            )
          ).status,
        ).toBe(409); // b ya tiene el suyo
        const c2 = await buying("pv3d");
        expect((await json(await get("/v1/suppliers", c2.cookie))).total).toBe(2);
        expect((await get("/v1/suppliers")).status).toBe(401);
      });
    });

    describe("factura de proveedor", () => {
      it("calcula los totales en el servidor y valida el NCF", async () => {
        const s = await buying("pf1");
        const d = await draftPurchase(s, { ncf: "b01-0000 0123" });
        expect(d).toMatchObject({
          kind: "SUPPLIER_INVOICE",
          status: "DRAFT",
          ncf: "B0100000123",
          supplierName: "Distribuidora Norte",
        });
        expect(d.totals).toMatchObject({
          subtotal: "500.00",
          tax18: "90.00",
          tax: "90.00",
          total: "590.00",
        });

        for (const ncf of [undefined, "", "B01", "X0100000123", "E41000000001"]) {
          const res = await post("/v1/purchases", purchaseBody(s, { ncf }), s.cookie);
          expect(res.status, String(ncf)).toBe(422);
        }
        expect(
          (await post("/v1/purchases", purchaseBody(s, { supplierId: null }), s.cookie))
            .status,
        ).toBe(422);
      });

      it("no se repite el NCF de un mismo proveedor, pero otro proveedor puede usar el mismo número", async () => {
        const s = await buying("pf2");
        await draftPurchase(s);
        const dup = await post("/v1/purchases", purchaseBody(s), s.cookie);
        expect(dup.status).toBe(409);
        expect(await error(dup)).toMatch(/ese NCF/);
        expect(
          (
            await post(
              "/v1/purchases",
              purchaseBody(s, { supplierId: s.informal.id }),
              s.cookie,
            )
          ).status,
        ).toBe(201);
      });

      it("al registrar da entrada al inventario con el costo neto y actualiza el último costo", async () => {
        const s = await buying("pf3");
        const d = await draftPurchase(s);
        expect(await stockOf(s)).toBe("0");

        const res = await postPurchase(s, d.id);
        expect(res.status).toBe(200);
        expect((await json(res)).data).toMatchObject({
          status: "POSTED",
          ncf: "B0100000123",
        });

        expect(await stockOf(s)).toBe("10");
        const mv = (await movements(s))[0]!;
        expect(mv).toMatchObject({
          type: "RECEIPT",
          quantity: "10",
          balanceAfter: "10",
          unitCost: "50.00",
        });
        expect(mv.reason).toContain("B0100000123");

        const product = (await json(await get(`/v1/products/${s.tracked.id}`, s.cookie)))
          .data;
        expect(product.lastCost).toBe("50.00"); // el administrador ve el último costo…
        const row = await withTenant(prisma, s.orgId).product.findFirstOrThrow({
          where: { id: s.tracked.id },
        });
        expect(row.lastCost).toBe(5000n);

        // …y el cajero no.
        const cashier = await signUp("pf3c");
        await prisma.member.create({
          data: {
            id: randomUUID(),
            organizationId: s.orgId,
            userId: cashier.userId,
            role: "member",
          },
        });
        const cashierCookie = await setActive(s.orgId, cashier.cookie);
        const asCashier = (
          await json(await get(`/v1/products/${s.tracked.id}`, cashierCookie))
        ).data;
        expect(asCashier.lastCost).toBeUndefined();
        const list = (await json(await get("/v1/products", cashierCookie)))
          .data as Json[];
        expect(list.every((p) => p.lastCost === undefined)).toBe(true);
      });

      it("el costo unitario sale de la base sin impuesto, también con precio con ITBIS incluido y descuento", async () => {
        const s = await buying("pf4");
        // 4 unidades a RD$59.00 con ITBIS incluido → base 200.00 → costo 50.00
        await postPurchase(
          s,
          (
            await draftPurchase(s, {
              lines: [
                {
                  productId: s.tracked.id,
                  quantity: "4",
                  unitCost: "59.00",
                  tax: "ITBIS18",
                  priceIncludesTax: true,
                },
              ],
            })
          ).id,
        );
        // 2 unidades a RD$100.00 con 10 % de descuento → base 180.00 → costo 90.00
        await postPurchase(
          s,
          (
            await draftPurchase(s, {
              ncf: "B0100000124",
              lines: [
                {
                  productId: s.tracked.id,
                  quantity: "2",
                  unitCost: "100.00",
                  tax: "EXENTO",
                  discount: { type: "percent", bps: 1000 },
                },
              ],
            })
          ).id,
        );
        const costs = (await movements(s)).map((m) => m.unitCost).sort();
        expect(costs).toEqual(["50.00", "90.00"]);
        expect(await stockOf(s)).toBe("6");
      });

      it("promedia el costo cuando el mismo producto aparece en varias líneas", async () => {
        const s = await buying("pf5");
        const d = await draftPurchase(s, {
          lines: [
            { productId: s.tracked.id, quantity: "1", unitCost: "10.00", tax: "EXENTO" },
            { productId: s.tracked.id, quantity: "3", unitCost: "20.00", tax: "EXENTO" },
          ],
        });
        await postPurchase(s, d.id);
        const moves = await movements(s);
        expect(moves).toHaveLength(1);
        expect(moves[0]).toMatchObject({ quantity: "4", unitCost: "17.50" }); // (10 + 60) / 4
      });

      it("convierte a pesos el costo de una compra en dólares", async () => {
        const s = await buying("pf6");
        const d = await draftPurchase(s, {
          currency: "USD",
          exchangeRate: "60",
          lines: [
            { productId: s.tracked.id, quantity: "5", unitCost: "10.00", tax: "EXENTO" },
          ],
        });
        await postPurchase(s, d.id);
        expect((await movements(s))[0]).toMatchObject({
          quantity: "5",
          unitCost: "600.00",
        });
      });

      it("un producto sin control de inventario no genera movimientos", async () => {
        const s = await buying("pf7");
        const plain = (
          await json(
            await post("/v1/products", { name: "Sin control", price: "5" }, s.cookie),
          )
        ).data;
        const d = await draftPurchase(s, {
          lines: [
            { productId: plain.id, quantity: "3", unitCost: "2.00", tax: "ITBIS18" },
          ],
        });
        expect((await postPurchase(s, d.id)).status).toBe(200);
        expect(await movements(s)).toHaveLength(0);
      });

      it("una compra registrada no se modifica ni se elimina, y no se registra dos veces", async () => {
        const s = await buying("pf8");
        const d = await draftPurchase(s);
        await postPurchase(s, d.id);
        expect((await postPurchase(s, d.id)).status).toBe(409);
        expect(
          (await send("PUT", `/v1/purchases/${d.id}`, purchaseBody(s), s.cookie)).status,
        ).toBe(409);
        expect(
          (await call(`/v1/purchases/${d.id}`, { method: "DELETE", cookie: s.cookie }))
            .status,
        ).toBe(409);
        expect(await stockOf(s)).toBe("10"); // no se duplicó la entrada
      });

      it("un borrador se puede reemplazar y eliminar sin tocar el inventario", async () => {
        const s = await buying("pf9");
        const d = await draftPurchase(s);
        const put = await send(
          "PUT",
          `/v1/purchases/${d.id}`,
          purchaseBody(s, {
            lines: [
              { productId: s.tracked.id, quantity: "1", unitCost: "9.00", tax: "EXENTO" },
            ],
          }),
          s.cookie,
        );
        expect((await json(put)).data.totals.total).toBe("9.00");
        // Reemplazar conservando su propio NCF no cuenta como duplicado.
        expect(put.status).toBe(200);
        expect(
          (await call(`/v1/purchases/${d.id}`, { method: "DELETE", cookie: s.cookie }))
            .status,
        ).toBe(204);
        expect(await stockOf(s)).toBe("0");
        expect((await get(`/v1/purchases/${d.id}`, s.cookie)).status).toBe(404);
      });

      it("valida las líneas", async () => {
        const s = await buying("pf10");
        let n = 0;
        const lines = (l: Json[]) =>
          post(
            "/v1/purchases",
            purchaseBody(s, {
              ncf: `B01000002${String(++n).padStart(2, "0")}`,
              lines: l,
            }),
            s.cookie,
          );
        expect((await lines([{ quantity: "1", unitCost: "5.00" }])).status).toBe(422); // sin producto ni nombre
        expect(
          (await lines([{ name: "Algo", quantity: "1", unitCost: "5.00" }])).status,
        ).toBe(422); // sin impuesto
        expect(
          (
            await lines([
              { name: "Algo", quantity: "1", unitCost: "5.00", tax: "EXENTO" },
            ])
          ).status,
        ).toBe(201);
        expect(
          (
            await lines([
              {
                productId: s.tracked.id,
                quantity: "1.5",
                unitCost: "5.00",
                tax: "EXENTO",
              },
            ])
          ).status,
        ).toBe(422); // no admite fracciones
        expect(
          (
            await lines([
              { productId: s.tracked.id, quantity: "0", unitCost: "5.00", tax: "EXENTO" },
            ])
          ).status,
        ).toBe(422);
        expect(
          (
            await lines([
              { productId: randomUUID(), quantity: "1", unitCost: "5.00", tax: "EXENTO" },
            ])
          ).status,
        ).toBe(422);
        expect((await lines([])).status).toBe(400);
      });
    });

    describe("comprobante de compras (E41)", () => {
      const e41 = (s: Buying, over: Json = {}) =>
        purchaseBody(s, {
          kind: "E41",
          ncf: undefined,
          supplierId: s.informal.id,
          expenseType: 2,
          ...over,
        });

      it("recibe el e-NCF de la empresa al registrarse y también mueve el inventario", async () => {
        const s = await buying("pe1");
        const d = (await json(await post("/v1/purchases", e41(s), s.cookie))).data;
        expect(d).toMatchObject({ kind: "E41", status: "DRAFT", ncf: null });
        const posted = (await json(await postPurchase(s, d.id))).data;
        expect(posted).toMatchObject({ status: "POSTED", ncf: "E410000000001" });
        expect(await stockOf(s)).toBe("10");
        // La numeración de E41 es independiente de la de venta.
        const sale = await createDraft(s);
        expect((await json(await issue(s, sale.id))).data.encf).toBe("E320000000001");
      });

      it("no admite NCF escrito a mano y exige proveedor con documento", async () => {
        const s = await buying("pe2");
        expect(
          (await post("/v1/purchases", e41(s, { ncf: "E410000000099" }), s.cookie))
            .status,
        ).toBe(422);
        expect(
          (await post("/v1/purchases", e41(s, { supplierId: null }), s.cookie)).status,
        ).toBe(422);

        const noDoc = (
          await json(await post("/v1/suppliers", { name: "Sin documento" }, s.cookie))
        ).data;
        const d = (
          await json(
            await post("/v1/purchases", e41(s, { supplierId: noDoc.id }), s.cookie),
          )
        ).data;
        const res = await postPurchase(s, d.id);
        expect(res.status).toBe(422);
        expect(await error(res)).toMatch(/cédula o RNC/);
      });

      it("registra las retenciones sin pasarse del ITBIS ni de la base", async () => {
        const s = await buying("pe3");
        const lines = [
          { name: "Servicio", quantity: "1", unitCost: "100.00", tax: "ITBIS18" },
        ]; // ITBIS 18.00
        const ok = await post(
          "/v1/purchases",
          e41(s, { lines, itbisWithheld: "18.00", isrWithheld: "10.00" }),
          s.cookie,
        );
        expect(ok.status).toBe(201);
        expect((await json(ok)).data.totals).toMatchObject({
          itbisWithheld: "18.00",
          isrWithheld: "10.00",
        });
        expect(
          (
            await post(
              "/v1/purchases",
              e41(s, { lines, itbisWithheld: "18.01" }),
              s.cookie,
            )
          ).status,
        ).toBe(422);
        expect(
          (
            await post(
              "/v1/purchases",
              e41(s, { lines, isrWithheld: "100.01" }),
              s.cookie,
            )
          ).status,
        ).toBe(422);
      });

      it("sin secuencia vigente no se registra y el borrador queda intacto", async () => {
        const s = await buying("pe4");
        const other = await billing("pe4b", { seqs: [["E32", 1, 5]] }); // sin E41
        const supplier = (
          await json(
            await post(
              "/v1/suppliers",
              { name: "Informal", documentType: "CEDULA", documentNumber: "00112345678" },
              other.cookie,
            ),
          )
        ).data;
        const body = {
          kind: "E41",
          branchId: other.branch.id,
          supplierId: supplier.id,
          invoiceDate: todayStr,
          lines: [{ name: "Servicio", quantity: "1", unitCost: "10.00", tax: "EXENTO" }],
        };
        const d = (await json(await post("/v1/purchases", body, other.cookie))).data;
        const res = await post(`/v1/purchases/${d.id}/post`, {}, other.cookie);
        expect(res.status).toBe(422);
        expect(await error(res)).toMatch(/secuencia/i);
        expect(
          (await json(await get(`/v1/purchases/${d.id}`, other.cookie))).data.status,
        ).toBe("DRAFT");
        void s;
      });

      it("registrar varias a la vez no repite el e-NCF", async () => {
        const s = await buying("pe5");
        const drafts = await Promise.all(
          Array.from({ length: 5 }, () =>
            (async () =>
              (
                await json(
                  await post(
                    "/v1/purchases",
                    e41(s, {
                      lines: [
                        {
                          name: "Servicio",
                          quantity: "1",
                          unitCost: "10.00",
                          tax: "EXENTO",
                        },
                      ],
                    }),
                    s.cookie,
                  ),
                )
              ).data as Json)(),
          ),
        );
        const results = await Promise.all(drafts.map((d) => postPurchase(s, d.id)));
        expect(results.map((r) => r.status)).toEqual(Array(5).fill(200));
        const ncfs = (
          await Promise.all(results.map(async (r) => (await json(r)).data.ncf as string))
        ).sort();
        expect(ncfs).toEqual(
          Array.from({ length: 5 }, (_, i) => `E41${String(i + 1).padStart(10, "0")}`),
        );
      });
    });

    describe("gastos menores (E43)", () => {
      const e43 = (s: Buying, over: Json = {}) => ({
        kind: "E43",
        branchId: s.branch.id,
        invoiceDate: todayStr,
        expenseType: 2,
        lines: [
          { name: "Taxi al banco", quantity: "1", unitCost: "350.00", tax: "EXENTO" },
        ],
        ...over,
      });

      it("no necesita proveedor y recibe su e-NCF sin tocar el inventario", async () => {
        const s = await buying("pg1");
        const d = (await json(await post("/v1/purchases", e43(s), s.cookie))).data;
        expect(d).toMatchObject({
          kind: "E43",
          supplierName: null,
          totals: { total: "350.00" },
        });
        const posted = (await json(await postPurchase(s, d.id))).data;
        expect(posted.ncf).toBe("E430000000001");
        expect(await movements(s)).toHaveLength(0);
      });

      it("no admite productos de inventario ni retenciones", async () => {
        const s = await buying("pg2");
        const withProduct = await post(
          "/v1/purchases",
          e43(s, {
            lines: [
              { productId: s.tracked.id, quantity: "1", unitCost: "5.00", tax: "EXENTO" },
            ],
          }),
          s.cookie,
        );
        expect(withProduct.status).toBe(422);
        expect(
          (await post("/v1/purchases", e43(s, { itbisWithheld: "1.00" }), s.cookie))
            .status,
        ).toBe(422);
      });
    });

    describe("reporte de compras", () => {
      async function scenario(label: string) {
        const s = await buying(label);
        // 1) Factura de proveedor: 2 × 50.00 + ITBIS 18 % = 118.00 (tipo 9)
        await postPurchase(
          s,
          (
            await draftPurchase(s, {
              lines: [
                {
                  productId: s.tracked.id,
                  quantity: "2",
                  unitCost: "50.00",
                  tax: "ITBIS18",
                },
              ],
            })
          ).id,
        );
        // 2) Gasto menor de 30.00 (tipo 2)
        await postPurchase(
          s,
          (
            await json(
              await post(
                "/v1/purchases",
                {
                  kind: "E43",
                  branchId: s.branch.id,
                  invoiceDate: todayStr,
                  expenseType: 2,
                  paymentMethod: "CARD",
                  lines: [
                    { name: "Parqueo", quantity: "1", unitCost: "30.00", tax: "EXENTO" },
                  ],
                },
                s.cookie,
              ),
            )
          ).data.id,
        );
        // 3) Comprobante de compras en dólares: US$10.00 × 60 = RD$600.00 con retención de ISR de US$1.00
        await postPurchase(
          s,
          (
            await json(
              await post(
                "/v1/purchases",
                {
                  kind: "E41",
                  branchId: s.branch.id,
                  supplierId: s.informal.id,
                  invoiceDate: todayStr,
                  expenseType: 2,
                  currency: "USD",
                  exchangeRate: "60",
                  isrWithheld: "1.00",
                  lines: [
                    {
                      name: "Servicio profesional",
                      quantity: "1",
                      unitCost: "10.00",
                      tax: "EXENTO",
                    },
                  ],
                },
                s.cookie,
              ),
            )
          ).data.id,
        );
        // 4) Un borrador que no debe contar.
        await draftPurchase(s, { ncf: "B0100000999" });
        return s;
      }

      it("suma lo registrado en pesos y separa ITBIS y retenciones", async () => {
        const s = await scenario("pr1");
        const { data } = await json(
          await get(`/v1/reports/purchases?from=${todayStr}&to=${todayStr}`, s.cookie),
        );
        expect(data.totals).toMatchObject({
          documents: 3,
          subtotal: "730.00",
          tax: "18.00",
          total: "748.00",
          itbisWithheld: "0.00",
          isrWithheld: "60.00",
        });
        expect(data.series).toHaveLength(1);
        expect(data.series[0]).toMatchObject({
          period: todayStr,
          count: 3,
          total: "748.00",
        });
        const kind = Object.fromEntries(data.byKind.map((k: Json) => [k.kind, k.total]));
        expect(kind).toEqual({ E41: "600.00", SUPPLIER_INVOICE: "118.00", E43: "30.00" });
        const expense = Object.fromEntries(
          data.byExpense.map((e: Json) => [e.expenseType, e.total]),
        );
        expect(expense).toEqual({ 2: "630.00", 9: "118.00" });
        expect(data.topSuppliers[0]).toMatchObject({
          name: "Juan Pérez",
          total: "600.00",
        });
      });

      it("respeta el rango y exige fechas válidas", async () => {
        const s = await scenario("pr2");
        const past = await json(
          await get("/v1/reports/purchases?from=2020-01-01&to=2020-12-31", s.cookie),
        );
        expect(past.data.totals).toMatchObject({ documents: 0, total: "0.00" });
        expect(
          (await get("/v1/reports/purchases?from=2026-02-01&to=2026-01-01", s.cookie))
            .status,
        ).toBe(400);
      });

      it("exporta un CSV con las columnas del 606", async () => {
        const s = await scenario("pr3");
        const res = await get(
          `/v1/reports/purchases.csv?from=${todayStr}&to=${todayStr}`,
          s.cookie,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-disposition")).toContain(
          `compras-${todayStr}_${todayStr}.csv`,
        );
        const lines = (await res.text()).replace("﻿", "").trim().split("\r\n");
        expect(lines[0]).toContain("Tipo de bienes y servicios (606)");
        expect(lines).toHaveLength(1 + 3);
        expect(
          lines.some(
            (l) =>
              l.includes("B0100000123") && l.includes("131246796") && l.includes(",1,"),
          ),
        ).toBe(true); // RNC → tipo 1
        expect(
          lines.some(
            (l) =>
              l.includes("E410000000001") &&
              l.includes("00112345678") &&
              l.includes(",2,"),
          ),
        ).toBe(true); // cédula → tipo 2
      });

      it("solo administradores y cada empresa ve lo suyo", async () => {
        const a = await scenario("pr4a");
        const b = await buying("pr4b");
        const cashier = await signUp("pr4c");
        await prisma.member.create({
          data: {
            id: randomUUID(),
            organizationId: a.orgId,
            userId: cashier.userId,
            role: "member",
          },
        });
        const cookie = await setActive(a.orgId, cashier.cookie);
        expect(
          (await get(`/v1/reports/purchases?from=${todayStr}&to=${todayStr}`, cookie))
            .status,
        ).toBe(403);
        expect(
          (await get(`/v1/reports/purchases.csv?from=${todayStr}&to=${todayStr}`, cookie))
            .status,
        ).toBe(403);
        expect(
          (
            await json(
              await get(
                `/v1/reports/purchases?from=${todayStr}&to=${todayStr}`,
                b.cookie,
              ),
            )
          ).data.totals.documents,
        ).toBe(0);
      });
    });

    it("los comprobantes de compra no se pueden emitir como ventas", async () => {
      const s = await buying("px1");
      for (const type of ["E41", "E43"]) {
        expect(
          (await post("/v1/documents", draftBody(s, { type }), s.cookie)).status,
        ).toBe(400);
      }
      // Y las compras no aparecen en el reporte de ventas.
      await postPurchase(s, (await draftPurchase(s)).id);
      const sales = await json(
        await get(`/v1/reports/sales?from=${todayStr}&to=${todayStr}`, s.cookie),
      );
      expect(sales.data.totals.documents).toBe(0);
    });

    it("sin sesión no se accede a las compras", async () => {
      for (const path of [
        "/v1/purchases",
        "/v1/suppliers",
        "/v1/reports/purchases?from=2026-01-01&to=2026-01-02",
      ]) {
        expect((await get(path)).status).toBe(401);
      }
    });

    it("cada empresa ve solo sus compras y no puede usar proveedores ajenos", async () => {
      const a = await buying("pz1a");
      const b = await buying("pz1b");
      const d = await draftPurchase(a);
      expect((await get(`/v1/purchases/${d.id}`, b.cookie)).status).toBe(404);
      expect((await postPurchase(b, d.id)).status).toBe(404);
      expect((await json(await get("/v1/purchases", b.cookie))).total).toBe(0);
      const steal = await post(
        "/v1/purchases",
        purchaseBody(b, { supplierId: a.supplier.id }),
        b.cookie,
      );
      expect(steal.status).toBe(422);
    });
  });

  describe("restaurante", () => {
    /**
     * Restaurante con 3 mesas y tres productos:
     *  - Pollo guisado RD$350.00 (cocina), Cerveza RD$120.00 (bar, con inventario), Agua RD$50.00 (sin preparación).
     * Precios con ITBIS 18 % incluido.
     */
    async function resto(label: string) {
      const b = await billing(label, { seqs: [["E32", 1, 100], ["E31", 1, 50]] });
      const mk = async (body: Json) => (await json(await post("/v1/products", body, b.cookie))).data as Json;
      const pollo = await mk({ name: "Pollo guisado", price: "350.00", prepStation: "KITCHEN" });
      const cerveza = await mk({ name: "Cerveza", price: "120.00", prepStation: "BAR", trackInventory: true });
      const agua = await mk({ name: "Agua", price: "50.00", prepStation: "NONE" });
      expect((await post("/v1/restaurant/tables/bulk", { branchId: b.branch.id, count: 3 }, b.cookie)).status).toBe(201);
      const tables = (await json(await get("/v1/restaurant/tables", b.cookie))).data as Json[];
      return { ...b, pollo, cerveza, agua, tables };
    }
    type Resto = Awaited<ReturnType<typeof resto>>;

    const R = "/v1/restaurant";
    const openOrder = async (r: Resto, tableIndex = 0, covers?: number) => {
      const res = await post(`${R}/orders`, { tableId: r.tables[tableIndex]!.id, covers }, r.cookie);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
      return (await json(res)).data as Json;
    };
    const addItem = (r: Resto, orderId: string, productId: string, qty = "1", notes?: string) =>
      post(`${R}/orders/${orderId}/items`, { productId, quantity: qty, notes }, r.cookie);
    const getOrder = async (r: Resto, id: string) => (await json(await get(`${R}/orders/${id}`, r.cookie))).data as Json;
    const send = (r: Resto, id: string) => post(`${R}/orders/${id}/send`, {}, r.cookie);
    const bill = (r: Resto, id: string, body: Json = {}) =>
      post(`${R}/orders/${id}/bill`, { payments: [{ method: "CASH", amount: "889.49" }], ...body }, r.cookie);
    const itemOf = (order: Json, name: string) => (order.items as Json[]).find((i) => i.name === name)!;

    /** Mesa con 2 pollos y 1 cerveza: subtotal 694.91 + ITBIS 125.09 = 820.00; propina 69.49 → 889.49. */
    async function tableWithOrder(r: Resto, tableIndex = 0) {
      const o = await openOrder(r, tableIndex, 3);
      await addItem(r, o.id, r.pollo.id, "2");
      await addItem(r, o.id, r.cerveza.id, "1");
      return (await getOrder(r, o.id)) as Json;
    }

    describe("mesas", () => {
      it("crea mesas en lote sin repetir y valida los datos", async () => {
        const r = await resto("rm1");
        expect(r.tables.map((t) => t.name)).toEqual(["Mesa 1", "Mesa 2", "Mesa 3"]);

        const again = await post(`${R}/tables/bulk`, { branchId: r.branch.id, count: 5, zone: "Terraza" }, r.cookie);
        expect((await json(again)).data).toEqual({ created: 2, skipped: 3 });

        expect((await post(`${R}/tables`, { branchId: r.branch.id, name: "Barra 1", zone: "Barra", seats: 2 }, r.cookie)).status).toBe(201);
        expect((await post(`${R}/tables`, { branchId: r.branch.id, name: "Barra 1" }, r.cookie)).status).toBe(409);
        expect((await post(`${R}/tables`, { branchId: r.branch.id, name: "Mala", seats: 0 }, r.cookie)).status).toBe(400);
        expect((await post(`${R}/tables`, { branchId: randomUUID(), name: "X" }, r.cookie)).status).toBe(422);
      });

      it("no se puede desactivar una mesa con comanda abierta", async () => {
        const r = await resto("rm2");
        const o = await openOrder(r);
        expect((await patch(`${R}/tables/${r.tables[0]!.id}`, { active: false }, r.cookie)).status).toBe(409);
        await post(`${R}/orders/${o.id}/cancel`, { reason: "Se fueron" }, r.cookie);
        expect((await patch(`${R}/tables/${r.tables[0]!.id}`, { active: false }, r.cookie)).status).toBe(200);
        const active = (await json(await get(`${R}/tables`, r.cookie))).data as Json[];
        expect(active).toHaveLength(2);
        expect(((await json(await get(`${R}/tables?all=true`, r.cookie))).data as Json[])).toHaveLength(3);
      });

      it("el mesero ve el salón pero no administra las mesas", async () => {
        const r = await resto("rm3");
        const waiter = await signUp("rm3w");
        await prisma.member.create({ data: { id: randomUUID(), organizationId: r.orgId, userId: waiter.userId, role: "member" } });
        const cookie = await setActive(r.orgId, waiter.cookie);
        expect((await get(`${R}/tables`, cookie)).status).toBe(200);
        expect((await post(`${R}/tables`, { branchId: r.branch.id, name: "Nueva" }, cookie)).status).toBe(403);
        expect((await post(`${R}/tables/bulk`, { branchId: r.branch.id, count: 2 }, cookie)).status).toBe(403);
        expect((await patch(`${R}/tables/${r.tables[0]!.id}`, { name: "X" }, cookie)).status).toBe(403);
        expect((await get(`${R}/tables`)).status).toBe(401);
      });
    });

    describe("comandas", () => {
      it("abre una comanda por mesa con consecutivo y la muestra en el salón", async () => {
        const r = await resto("rc1");
        const first = await openOrder(r, 0, 4);
        expect(first).toMatchObject({ number: 1, status: "OPEN", covers: 4, table: { name: "Mesa 1" } });
        expect((await post(`${R}/orders`, { tableId: r.tables[0]!.id }, r.cookie)).status).toBe(409);
        expect((await openOrder(r, 1)).number).toBe(2);
        expect((await post(`${R}/orders`, { tableId: randomUUID() }, r.cookie)).status).toBe(422);

        await addItem(r, first.id, r.pollo.id, "2");
        const salon = (await json(await get(`${R}/tables`, r.cookie))).data as Json[];
        expect(salon.find((t) => t.name === "Mesa 1")!.order).toMatchObject({ number: 1, covers: 4, items: 1, unsent: 1, total: "700.00" });
        expect(salon.find((t) => t.name === "Mesa 3")!.order).toBeNull();
      });

      it("dos meseros abriendo la misma mesa a la vez: solo una comanda", async () => {
        const r = await resto("rc2");
        const results = await Promise.all(
          Array.from({ length: 4 }, () => post(`${R}/orders`, { tableId: r.tables[0]!.id }, r.cookie)),
        );
        expect(results.map((x) => x.status).sort()).toEqual([201, 409, 409, 409]);
      });

      it("anota productos con el precio de ese momento y suma los iguales sin enviar", async () => {
        const r = await resto("rc3");
        const o = await openOrder(r);
        await addItem(r, o.id, r.pollo.id, "1");
        await addItem(r, o.id, r.pollo.id, "2");
        await addItem(r, o.id, r.pollo.id, "1", "sin cebolla"); // otras notas = otra línea
        let order = await getOrder(r, o.id);
        expect(order.items).toHaveLength(2);
        expect(itemOf(order, "Pollo guisado")).toMatchObject({ quantity: "3", unitPrice: "350.00", status: "PENDING", station: "KITCHEN" });

        // Cambiar el precio del producto después no afecta lo ya anotado.
        await patch(`/v1/products/${r.pollo.id}`, { price: "999.00" }, r.cookie);
        order = await getOrder(r, o.id);
        expect(itemOf(order, "Pollo guisado").unitPrice).toBe("350.00");
        expect(order.totals.total).toBe("1400.00"); // 4 × 350.00
      });

      it("valida productos, cantidades y fracciones", async () => {
        const r = await resto("rc4");
        const o = await openOrder(r);
        expect((await addItem(r, o.id, r.pollo.id, "0")).status).toBe(422);
        expect((await addItem(r, o.id, r.pollo.id, "1.5")).status).toBe(422);
        expect((await addItem(r, o.id, randomUUID())).status).toBe(422);
        await call(`/v1/products/${r.agua.id}`, { method: "DELETE", cookie: r.cookie });
        expect((await addItem(r, o.id, r.agua.id)).status).toBe(422); // inactivo
      });

      it("modifica cantidad y notas solo antes de enviar; después se anula con motivo", async () => {
        const r = await resto("rc5");
        const o = await openOrder(r);
        const withItem = (await json(await addItem(r, o.id, r.pollo.id, "2"))).data;
        const itemId = withItem.items[0].id;

        const upd = await patch(`${R}/orders/${o.id}/items/${itemId}`, { quantity: "3", notes: "término medio" }, r.cookie);
        expect(itemOf((await json(upd)).data, "Pollo guisado")).toMatchObject({ quantity: "3", notes: "término medio" });

        await send(r, o.id);
        expect((await patch(`${R}/orders/${o.id}/items/${itemId}`, { quantity: "1" }, r.cookie)).status).toBe(409);
        const noReason = await post(`${R}/orders/${o.id}/items/${itemId}/void`, {}, r.cookie);
        expect(noReason.status).toBe(422);
        const voided = await post(`${R}/orders/${o.id}/items/${itemId}/void`, { reason: "El cliente se fue" }, r.cookie);
        expect(itemOf((await json(voided)).data, "Pollo guisado")).toMatchObject({ status: "VOID", voidReason: "El cliente se fue" });
        expect((await post(`${R}/orders/${o.id}/items/${itemId}/void`, { reason: "otra vez" }, r.cookie)).status).toBe(409);
        expect((await getOrder(r, o.id)).totals.total).toBe("0.00"); // lo anulado no se cobra
      });

      it("un producto sin enviar se quita sin dejar rastro", async () => {
        const r = await resto("rc6");
        const o = await openOrder(r);
        const itemId = (await json(await addItem(r, o.id, r.pollo.id))).data.items[0].id;
        const res = await post(`${R}/orders/${o.id}/items/${itemId}/void`, {}, r.cookie);
        expect((await json(res)).data.items).toEqual([]);
      });

      it("calcula la pre-cuenta con ITBIS y propina legal del 10 % sobre el subtotal", async () => {
        const r = await resto("rc7");
        const order = await tableWithOrder(r);
        expect(order.totals).toEqual({ subtotal: "694.91", tax: "125.09", total: "820.00", propina: "69.49", totalWithTip: "889.49" });
      });

      it("cambia la comanda de mesa solo a una libre", async () => {
        const r = await resto("rc8");
        const a = await openOrder(r, 0);
        await openOrder(r, 1);
        expect((await post(`${R}/orders/${a.id}/transfer`, { tableId: r.tables[1]!.id }, r.cookie)).status).toBe(409);
        expect((await post(`${R}/orders/${a.id}/transfer`, { tableId: r.tables[0]!.id }, r.cookie)).status).toBe(422); // ya está ahí
        const moved = await post(`${R}/orders/${a.id}/transfer`, { tableId: r.tables[2]!.id }, r.cookie);
        expect((await json(moved)).data.table.name).toBe("Mesa 3");
        // La mesa original quedó libre.
        expect((await post(`${R}/orders`, { tableId: r.tables[0]!.id }, r.cookie)).status).toBe(201);
      });

      it("cancelar: libre antes de enviar; con productos en cocina, solo un administrador", async () => {
        const r = await resto("rc9");
        const waiter = await signUp("rc9w");
        await prisma.member.create({ data: { id: randomUUID(), organizationId: r.orgId, userId: waiter.userId, role: "member" } });
        const wCookie = await setActive(r.orgId, waiter.cookie);

        const plain = await openOrder(r, 0);
        await addItem(r, plain.id, r.pollo.id);
        expect((await post(`${R}/orders/${plain.id}/cancel`, { reason: "Se fueron" }, wCookie)).status).toBe(204);

        const cooking = await tableWithOrder(r, 1);
        await send(r, cooking.id);
        expect((await post(`${R}/orders/${cooking.id}/cancel`, { reason: "Error de mesa" }, wCookie)).status).toBe(403);
        expect((await post(`${R}/orders/${cooking.id}/cancel`, { reason: "x" }, r.cookie)).status).toBe(400); // motivo muy corto
        expect((await post(`${R}/orders/${cooking.id}/cancel`, { reason: "Error de mesa" }, r.cookie)).status).toBe(204);

        // Una comanda cancelada ya no admite cambios.
        expect((await addItem(r, cooking.id, r.agua.id)).status).toBe(409);
        const final = await getOrder(r, cooking.id);
        expect(final).toMatchObject({ status: "CANCELLED", cancelReason: "Error de mesa" });
      });
    });

    describe("cocina y bar", () => {
      it("envía a cada estación, deja listo lo que no se prepara y arma el ticket", async () => {
        const r = await resto("rk1");
        const o = await openOrder(r, 0, 2);
        await addItem(r, o.id, r.pollo.id, "2", "sin cebolla");
        await addItem(r, o.id, r.cerveza.id, "3");
        await addItem(r, o.id, r.agua.id, "1");

        const res = await send(r, o.id);
        expect(res.status).toBe(200);
        const { data } = await json(res);
        expect(data.ticket).toMatchObject({ number: 1, table: "Mesa 1", covers: 2 });
        const byStation = Object.fromEntries(data.ticket.stations.map((s: Json) => [s.station, s.items.map((i: Json) => `${i.quantity} ${i.name}${i.notes ? ` (${i.notes})` : ""}`)]));
        expect(byStation).toEqual({ KITCHEN: ["2 Pollo guisado (sin cebolla)"], BAR: ["3 Cerveza"] });

        expect(itemOf(data.order, "Pollo guisado").status).toBe("SENT");
        expect(itemOf(data.order, "Agua").status).toBe("READY"); // no pasa por cocina
        expect((await send(r, o.id)).status).toBe(422); // nada pendiente
      });

      it("la pantalla de cocina lista lo enviado por estación y se marca listo", async () => {
        const r = await resto("rk2");
        const a = await tableWithOrder(r, 0);
        const b = await openOrder(r, 1);
        await addItem(r, b.id, r.pollo.id, "1");
        await send(r, a.id);
        await send(r, b.id);

        const kitchen = (await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data as Json[];
        expect(kitchen.map((g) => g.table)).toEqual(["Mesa 1", "Mesa 2"]); // el más antiguo primero
        expect(kitchen[0]!.items.map((i: Json) => i.name)).toEqual(["Pollo guisado"]);
        const bar = (await json(await get(`${R}/kitchen?station=BAR`, r.cookie))).data as Json[];
        expect(bar).toHaveLength(1);
        expect(bar[0]!.items[0].name).toBe("Cerveza");

        const itemId = kitchen[0]!.items[0].id;
        expect((await post(`${R}/items/${itemId}/ready`, {}, r.cookie)).status).toBe(204);
        expect((await post(`${R}/items/${itemId}/ready`, {}, r.cookie)).status).toBe(409); // ya estaba listo
        const after = (await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data as Json[];
        expect(after.map((g) => g.table)).toEqual(["Mesa 2"]);
        expect(itemOf(await getOrder(r, a.id), "Pollo guisado").status).toBe("READY");

        expect((await get(`${R}/kitchen?station=NONE`, r.cookie)).status).toBe(400);
        const salon = (await json(await get(`${R}/tables`, r.cookie))).data as Json[];
        expect(salon.find((t) => t.name === "Mesa 1")!.order).toMatchObject({ waiting: 1, ready: 1 }); // cerveza en el bar, pollo listo
      });
    });

    describe("cobro", () => {
      it("cobra la cuenta completa con propina legal, emite el e-NCF y cierra la mesa", async () => {
        const r = await resto("rb1");
        const order = await tableWithOrder(r);
        await send(r, order.id);

        const res = await bill(r, order.id);
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        const { data } = await json(res);
        expect(data.closed).toBe(true);
        expect(data.document).toMatchObject({ status: "ISSUED", encf: "E320000000001", type: "E32" });
        expect(data.document.totals).toMatchObject({ subtotal: "694.91", tax: "125.09", propina: "69.49", total: "889.49" });
        expect(data.document.lines.map((l: Json) => l.name)).toEqual(["Pollo guisado", "Cerveza"]);
        expect(data.order.status).toBe("CLOSED");
        expect(data.order.items.every((i: Json) => i.remaining === "0")).toBe(true);

        // La mesa vuelve a estar libre.
        const salon = (await json(await get(`${R}/tables`, r.cookie))).data as Json[];
        expect(salon.find((t) => t.name === "Mesa 1")!.order).toBeNull();
        expect((await post(`${R}/orders`, { tableId: r.tables[0]!.id }, r.cookie)).status).toBe(201);
        // Y no se puede cobrar dos veces.
        expect((await bill(r, order.id)).status).toBe(409);
      });

      it("sin propina el total es el de la consumición", async () => {
        const r = await resto("rb2");
        const order = await tableWithOrder(r);
        const res = await bill(r, order.id, { propinaLegal: false, payments: [{ method: "CARD", amount: "820.00" }] });
        expect((await json(res)).data.document.totals).toMatchObject({ propina: "0.00", total: "820.00" });
      });

      it("divide la cuenta cobrando por partes y cierra al cobrar lo último", async () => {
        const r = await resto("rb3");
        const order = await tableWithOrder(r); // 2 pollos + 1 cerveza
        const pollo = itemOf(order, "Pollo guisado");
        const cerveza = itemOf(order, "Cerveza");

        // Primer cliente: 1 pollo (350.00 → base 296.61 + ITBIS 53.39; propina 29.66 → 379.66)
        const first = await bill(r, order.id, {
          items: [{ itemId: pollo.id, quantity: "1" }],
          payments: [{ method: "CASH", amount: "379.66" }],
        });
        expect(first.status, JSON.stringify(await first.clone().json())).toBe(201);
        const one = (await json(first)).data;
        expect(one.closed).toBe(false);
        expect(one.document.totals.total).toBe("379.66");
        expect(itemOf(one.order, "Pollo guisado")).toMatchObject({ billedQuantity: "1", remaining: "1" });

        // No se puede cobrar más de lo que queda, ni un producto ajeno.
        expect((await bill(r, order.id, { items: [{ itemId: pollo.id, quantity: "2" }] })).status).toBe(422);
        expect((await bill(r, order.id, { items: [{ itemId: randomUUID(), quantity: "1" }] })).status).toBe(422);
        expect((await bill(r, order.id, { items: [{ itemId: pollo.id, quantity: "0.5" }] })).status).toBe(422); // no se parte un pollo

        // El resto de la mesa: 1 pollo + 1 cerveza.
        const rest = await getOrder(r, order.id);
        expect(rest.totals.total).toBe("470.00");
        const second = await bill(r, order.id, { payments: [{ method: "CASH", amount: String(rest.totals.totalWithTip) }] });
        expect(second.status, JSON.stringify(await second.clone().json())).toBe(201);
        const last = (await json(second)).data;
        expect(last.closed).toBe(true);
        expect(last.document.encf).toBe("E320000000002");
        expect(cerveza.name).toBe("Cerveza");
      });

      it("si los pagos no suman, no se cobra nada y no se gasta ningún número", async () => {
        const r = await resto("rb4");
        const order = await tableWithOrder(r);
        const bad = await bill(r, order.id, { payments: [{ method: "CASH", amount: "800.00" }] });
        expect(bad.status).toBe(422);
        expect(await error(bad)).toMatch(/pagos/i);

        const after = await getOrder(r, order.id);
        expect(after.status).toBe("OPEN");
        expect(after.items.every((i: Json) => i.billedQuantity === "0")).toBe(true);
        expect((await json(await get("/v1/documents", r.cookie))).total).toBe(0);
        // El siguiente cobro correcto sigue siendo el e-NCF 1.
        expect((await json(await bill(r, order.id))).data.document.encf).toBe("E320000000001");
      });

      it("descuenta del inventario lo cobrado y anotar o enviar no lo toca", async () => {
        const r = await resto("rb5");
        await post("/v1/inventory/receipts", { productId: r.cerveza.id, branchId: r.branch.id, quantity: "24" }, r.cookie);
        const order = await tableWithOrder(r); // 1 cerveza
        await send(r, order.id);
        const stock = async () => ((await json(await get(`/v1/inventory/stock?branchId=${r.branch.id}`, r.cookie))).data as Json[]).find((x) => x.productId === r.cerveza.id)!.quantity;
        expect(await stock()).toBe("24");
        await bill(r, order.id);
        expect(await stock()).toBe("23");
      });

      it("factura de crédito fiscal exige cliente con RNC", async () => {
        const r = await resto("rb6");
        const company = (await json(await post("/v1/customers", { name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" }, r.cookie))).data;
        const order = await tableWithOrder(r);
        const noRnc = await bill(r, order.id, { type: "E31" });
        expect(noRnc.status).toBe(422);
        expect(await error(noRnc)).toMatch(/RNC/);

        const ok = await bill(r, order.id, { type: "E31", customerId: company.id });
        expect(ok.status).toBe(201);
        expect((await json(ok)).data.document).toMatchObject({ type: "E31", encf: "E310000000001", buyerName: "Acme SRL" });
      });

      it("cobra a pesar de que el producto se desactive después de anotarlo", async () => {
        const r = await resto("rb7");
        const order = await tableWithOrder(r);
        await call(`/v1/products/${r.pollo.id}`, { method: "DELETE", cookie: r.cookie });
        expect((await bill(r, order.id)).status).toBe(201);
      });

      it("lo anulado no se cobra y lo ya cobrado no se puede anular ni cancelar", async () => {
        const r = await resto("rb8");
        const order = await tableWithOrder(r);
        await send(r, order.id);
        const cerveza = itemOf(order, "Cerveza");
        const pollo = itemOf(order, "Pollo guisado");
        await post(`${R}/orders/${order.id}/items/${cerveza.id}/void`, { reason: "La pidieron fría y no hay" }, r.cookie);

        const rest = await getOrder(r, order.id);
        expect(rest.totals.total).toBe("700.00");
        const res = await bill(r, order.id, { items: [{ itemId: pollo.id, quantity: "1" }], payments: [{ method: "CASH", amount: "379.66" }] });
        expect(res.status).toBe(201);
        expect((await bill(r, order.id, { items: [{ itemId: cerveza.id, quantity: "1" }] })).status).toBe(422); // anulado
        expect((await post(`${R}/orders/${order.id}/items/${pollo.id}/void`, { reason: "ya cobrado" }, r.cookie)).status).toBe(409);
        expect((await post(`${R}/orders/${order.id}/cancel`, { reason: "intento" }, r.cookie)).status).toBe(409);
      });

      it("dos cobros simultáneos de la misma mesa: uno cobra y el otro no", async () => {
        const r = await resto("rb9");
        const order = await tableWithOrder(r);
        const results = await Promise.all([bill(r, order.id), bill(r, order.id)]);
        const statuses = results.map((x) => x.status).sort();
        expect(statuses[0]).toBe(201);
        expect([409, 422]).toContain(statuses[1]);
        expect((await json(await get("/v1/documents", r.cookie))).total).toBe(1);
      });

      it("el cajero (member) opera la mesa de punta a punta, y las ventas aparecen en el reporte", async () => {
        const r = await resto("rb10");
        const waiter = await signUp("rb10w");
        await prisma.member.create({ data: { id: randomUUID(), organizationId: r.orgId, userId: waiter.userId, role: "member" } });
        const cookie = await setActive(r.orgId, waiter.cookie);

        const o = (await json(await post(`${R}/orders`, { tableId: r.tables[0]!.id }, cookie))).data;
        expect((await post(`${R}/orders/${o.id}/items`, { productId: r.pollo.id, quantity: "2" }, cookie)).status).toBe(201);
        expect((await post(`${R}/orders/${o.id}/send`, {}, cookie)).status).toBe(200);
        const total = (await json(await get(`${R}/orders/${o.id}`, cookie))).data.totals.totalWithTip;
        expect((await post(`${R}/orders/${o.id}/bill`, { payments: [{ method: "CASH", amount: total }] }, cookie)).status).toBe(201);

        const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(new Date());
        const sales = (await json(await get(`/v1/reports/sales?from=${today}&to=${today}`, r.cookie))).data;
        expect(sales.totals).toMatchObject({ documents: 1, propina: "59.32", net: "759.32" }); // 700.00 + 10 % de 593.22 sin ITBIS
      });
    });

    describe("carta: modificadores, cursos y combos", () => {
      const put = (path: string, body: unknown, cookie?: string) =>
        call(path, { method: "PUT", body: JSON.stringify(body), cookie });
      const product = async (r: Resto, body: Json) => {
        const res = await post("/v1/products", body, r.cookie);
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        return (await json(res)).data as Json;
      };
      const group = (r: Resto, body: Json) => post(`${R}/modifier-groups`, body, r.cookie);
      const terminoBody = {
        name: "Término",
        minSelect: 1,
        maxSelect: 1,
        modifiers: [{ name: "Medio" }, { name: "Bien cocido" }],
      };
      const extrasBody = {
        name: "Extras",
        minSelect: 0,
        maxSelect: 2,
        modifiers: [
          { name: "Queso", price: "50.00" },
          { name: "Tocino", price: "60.00" },
          { name: "Huevo", price: "30.00" },
        ],
      };
      const stockOf = async (r: Resto, productId: string) =>
        ((await json(await get(`/v1/inventory/stock?branchId=${r.branch.id}`, r.cookie))).data as Json[]).find(
          (x) => x.productId === productId,
        )?.quantity;

      /** Hamburguesa RD$300.00 con «Término» (obligatorio) y «Extras» (hasta 2). */
      async function burger(r: Resto) {
        const termino = (await json(await group(r, terminoBody))).data as Json;
        const extras = (await json(await group(r, extrasBody))).data as Json;
        const hamburguesa = await product(r, { name: "Hamburguesa", price: "300.00", prepStation: "KITCHEN" });
        const cfg = await put(`${R}/products/${hamburguesa.id}/menu`, { modifierGroupIds: [termino.id, extras.id] }, r.cookie);
        expect(cfg.status).toBe(204);
        const mod = (g: Json, name: string) => (g.modifiers as Json[]).find((m) => m.name === name)!.id as string;
        return { termino, extras, hamburguesa, mod };
      }

      describe("grupos de modificadores", () => {
        it("crea, lista, edita y borra grupos con sus opciones", async () => {
          const r = await resto("cm1");
          const created = await group(r, extrasBody);
          expect(created.status).toBe(201);
          const g = (await json(created)).data as Json;
          expect(g).toMatchObject({ name: "Extras", minSelect: 0, maxSelect: 2, active: true, products: 0 });
          expect(g.modifiers.map((m: Json) => `${m.name}:${m.price}`)).toEqual(["Queso:50.00", "Tocino:60.00", "Huevo:30.00"]);
          expect((await group(r, extrasBody)).status).toBe(409); // mismo nombre

          // Editar: renombrar una opción, cambiar su precio, quitar otra y agregar una nueva.
          const [queso, tocino] = g.modifiers as [Json, Json, Json];
          const upd = await put(
            `${R}/modifier-groups/${g.id}`,
            {
              name: "Adicionales",
              minSelect: 0,
              maxSelect: 3,
              modifiers: [
                { id: queso.id, name: "Queso cheddar", price: "55.00" },
                { id: tocino.id, name: "Tocino", price: "60.00", active: false },
                { name: "Aguacate", price: "40.00" },
              ],
            },
            r.cookie,
          );
          expect(upd.status, JSON.stringify(await upd.clone().json())).toBe(200);
          const after = (await json(upd)).data as Json;
          expect(after).toMatchObject({ name: "Adicionales", maxSelect: 3 });
          expect(after.modifiers.map((m: Json) => `${m.name}:${m.price}:${m.active}`)).toEqual([
            "Queso cheddar:55.00:true",
            "Tocino:60.00:false",
            "Aguacate:40.00:true",
          ]);
          expect(after.modifiers[0].id).toBe(queso.id); // se conserva el id

          // Un intercambio de nombres no choca con la unicidad.
          const swap = await put(
            `${R}/modifier-groups/${g.id}`,
            {
              name: "Adicionales",
              modifiers: [
                { id: after.modifiers[0].id, name: "Aguacate", price: "40.00" },
                { id: after.modifiers[2].id, name: "Queso cheddar", price: "55.00" },
              ],
            },
            r.cookie,
          );
          expect(swap.status).toBe(200);

          const list = (await json(await get(`${R}/modifier-groups`, r.cookie))).data as Json[];
          expect(list.map((x) => x.name)).toEqual(["Adicionales"]);
          expect((await call(`${R}/modifier-groups/${g.id}`, { method: "DELETE", cookie: r.cookie })).status).toBe(204);
          expect(((await json(await get(`${R}/modifier-groups`, r.cookie))).data as Json[])).toEqual([]);
        });

        it("valida mínimos, máximos, nombres repetidos y precios", async () => {
          const r = await resto("cm2");
          const bad = (over: Json) => group(r, { ...extrasBody, ...over });
          expect((await bad({ minSelect: 3, maxSelect: 2 })).status).toBe(400);
          expect((await bad({ maxSelect: 0 })).status).toBe(400);
          expect((await bad({ minSelect: 4, maxSelect: 5 })).status).toBe(400); // más que las opciones activas
          expect((await bad({ modifiers: [] })).status).toBe(400);
          expect((await bad({ modifiers: [{ name: "A" }, { name: "a" }] })).status).toBe(400);
          expect((await bad({ modifiers: [{ name: "A", price: "-5" }] })).status).toBe(400);
          expect((await bad({ name: "" })).status).toBe(400);
        });

        it("el mesero lee los grupos pero no los administra; cada empresa ve los suyos", async () => {
          const a = await resto("cm3a");
          const b = await resto("cm3b");
          const g = (await json(await group(a, extrasBody))).data as Json;
          const waiter = await signUp("cm3w");
          await prisma.member.create({ data: { id: randomUUID(), organizationId: a.orgId, userId: waiter.userId, role: "member" } });
          const cookie = await setActive(a.orgId, waiter.cookie);
          expect((await get(`${R}/modifier-groups`, cookie)).status).toBe(200);
          expect((await post(`${R}/modifier-groups`, extrasBody, cookie)).status).toBe(403);
          expect((await put(`${R}/modifier-groups/${g.id}`, extrasBody, cookie)).status).toBe(403);
          expect((await call(`${R}/modifier-groups/${g.id}`, { method: "DELETE", cookie })).status).toBe(403);

          expect(((await json(await get(`${R}/modifier-groups`, b.cookie))).data as Json[])).toEqual([]);
          expect((await put(`${R}/modifier-groups/${g.id}`, extrasBody, b.cookie)).status).toBe(404);
          expect((await call(`${R}/modifier-groups/${g.id}`, { method: "DELETE", cookie: b.cookie })).status).toBe(404);
        });
      });

      describe("modificadores en la comanda", () => {
        it("la carta ofrece los grupos de cada producto con sus precios", async () => {
          const r = await resto("cm4");
          const { hamburguesa } = await burger(r);
          const menu = (await json(await get(`${R}/menu`, r.cookie))).data as Json[];
          const h = menu.find((p) => p.id === hamburguesa.id)!;
          expect(h.modifierGroups.map((g: Json) => `${g.name}(${g.minSelect}-${g.maxSelect})`)).toEqual(["Término(1-1)", "Extras(0-2)"]);
          expect(h.modifierGroups[1].modifiers.map((m: Json) => m.price)).toEqual(["50.00", "60.00", "30.00"]);
          expect(menu.find((p) => p.name === "Pollo guisado")!.modifierGroups).toEqual([]);
          const cfg = (await json(await get(`${R}/products/${hamburguesa.id}/menu`, r.cookie))).data;
          expect(cfg.modifierGroupIds).toHaveLength(2);
          // Filtros
          expect(((await json(await get(`${R}/menu?q=hambur`, r.cookie))).data as Json[]).map((p) => p.name)).toEqual(["Hamburguesa"]);
        });

        it("suma el recargo de las opciones al precio y lo cobra", async () => {
          const r = await resto("cm5");
          const { hamburguesa, termino, extras, mod } = await burger(r);
          const o = await openOrder(r);
          const res = await post(
            `${R}/orders/${o.id}/items`,
            { productId: hamburguesa.id, quantity: "2", notes: "sin cebolla", modifierIds: [mod(termino, "Medio"), mod(extras, "Queso"), mod(extras, "Tocino")] },
            r.cookie,
          );
          expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
          const order = (await json(res)).data as Json;
          const item = itemOf(order, "Hamburguesa");
          expect(item.unitPrice).toBe("410.00"); // 300 + 50 + 60
          expect(item.modifiers.map((m: Json) => `${m.name}:${m.price}`)).toEqual(["Medio:0.00", "Queso:50.00", "Tocino:60.00"]);
          expect(order.totals.total).toBe("820.00");

          // Cambiar el precio de la opción después no altera lo ya anotado.
          const g = (await json(await get(`${R}/modifier-groups`, r.cookie))).data as Json[];
          const ex = g.find((x) => x.name === "Extras")!;
          await put(`${R}/modifier-groups/${ex.id}`, { ...ex, modifiers: ex.modifiers.map((m: Json) => ({ ...m, price: "999.00" })) }, r.cookie);
          expect(itemOf(await getOrder(r, o.id), "Hamburguesa").unitPrice).toBe("410.00");

          // El comprobante dice qué se cobró y a qué precio.
          const billed = await post(`${R}/orders/${o.id}/bill`, { propinaLegal: false, payments: [{ method: "CASH", amount: "820.00" }] }, r.cookie);
          expect(billed.status, JSON.stringify(await billed.clone().json())).toBe(201);
          const line = (await json(billed)).data.document.lines[0];
          expect(line).toMatchObject({ name: "Hamburguesa", unitPrice: "410.00", quantity: "2" });
          expect(line.description).toBe("Medio, Queso, Tocino · sin cebolla");
        });

        it("exige el mínimo, respeta el máximo y rechaza opciones ajenas o repetidas", async () => {
          const r = await resto("cm6");
          const { hamburguesa, termino, extras, mod } = await burger(r);
          const o = await openOrder(r);
          const add = (modifierIds: string[]) => post(`${R}/orders/${o.id}/items`, { productId: hamburguesa.id, modifierIds }, r.cookie);

          const none = await add([]);
          expect(none.status).toBe(422);
          expect(await error(none)).toMatch(/Término/);
          expect((await add([mod(termino, "Medio"), mod(termino, "Bien cocido")])).status).toBe(422); // máximo 1
          expect((await add([mod(termino, "Medio"), mod(extras, "Queso"), mod(extras, "Tocino"), mod(extras, "Huevo")])).status).toBe(422); // máximo 2
          expect((await add([mod(termino, "Medio"), mod(termino, "Medio")])).status).toBe(422); // repetida
          expect((await add([mod(termino, "Medio"), randomUUID()])).status).toBe(422); // ajena
          // Una opción de otro producto tampoco vale.
          const other = await group(r, { name: "Salsas", modifiers: [{ name: "Ranch" }] });
          const ranch = ((await json(other)).data.modifiers as Json[])[0]!.id;
          expect((await add([mod(termino, "Medio"), ranch])).status).toBe(422);

          expect((await add([mod(termino, "Bien cocido")])).status).toBe(201);
          expect((await getOrder(r, o.id)).items).toHaveLength(1);
        });

        it("junta las líneas iguales y separa las que tienen opciones distintas", async () => {
          const r = await resto("cm7");
          const { hamburguesa, termino, extras, mod } = await burger(r);
          const o = await openOrder(r);
          const add = (modifierIds: string[]) => post(`${R}/orders/${o.id}/items`, { productId: hamburguesa.id, modifierIds }, r.cookie);
          await add([mod(termino, "Medio"), mod(extras, "Queso")]);
          await add([mod(extras, "Queso"), mod(termino, "Medio")]); // mismo conjunto, otro orden
          await add([mod(termino, "Medio")]);
          const items = (await getOrder(r, o.id)).items as Json[];
          expect(items.map((i) => `${i.quantity}:${i.unitPrice}`).sort()).toEqual(["1:300.00", "2:350.00"]);
        });

        it("las opciones desactivadas o de un grupo inactivo ya no se ofrecen", async () => {
          const r = await resto("cm8");
          const { hamburguesa, termino, extras, mod } = await burger(r);
          const o = await openOrder(r);
          const queso = mod(extras, "Queso");
          await put(`${R}/modifier-groups/${extras.id}`, { ...extras, modifiers: (extras.modifiers as Json[]).map((m) => ({ ...m, active: m.name !== "Queso" })) }, r.cookie);
          expect((await post(`${R}/orders/${o.id}/items`, { productId: hamburguesa.id, modifierIds: [mod(termino, "Medio"), queso] }, r.cookie)).status).toBe(422);
          const menu = (await json(await get(`${R}/menu`, r.cookie))).data as Json[];
          expect(menu.find((p) => p.id === hamburguesa.id)!.modifierGroups[1].modifiers.map((m: Json) => m.name)).toEqual(["Tocino", "Huevo"]);

          await put(`${R}/modifier-groups/${termino.id}`, { ...termino, active: false }, r.cookie);
          // Con el grupo obligatorio inactivo ya no se pide.
          expect((await post(`${R}/orders/${o.id}/items`, { productId: hamburguesa.id }, r.cookie)).status).toBe(201);
        });
      });

      describe("cursos", () => {
        it("el producto trae su curso y se puede cambiar al anotarlo o antes de enviar", async () => {
          const r = await resto("cu1");
          const flan = await product(r, { name: "Flan", price: "100.00", course: 3 });
          expect(flan.course).toBe(3);
          expect((await post("/v1/products", { name: "Malo", price: "1.00", course: 6 }, r.cookie)).status).toBe(400);
          expect((await patch(`/v1/products/${flan.id}`, { course: 0 }, r.cookie)).status).toBe(400);

          const o = await openOrder(r);
          const res = await post(`${R}/orders/${o.id}/items`, { productId: flan.id }, r.cookie);
          expect(itemOf((await json(res)).data, "Flan").course).toBe(3);
          const over = await post(`${R}/orders/${o.id}/items`, { productId: r.pollo.id, course: 2 }, r.cookie);
          const pollo = itemOf((await json(over)).data, "Pollo guisado");
          expect(pollo.course).toBe(2);

          const moved = await patch(`${R}/orders/${o.id}/items/${pollo.id}`, { course: 1 }, r.cookie);
          expect(itemOf((await json(moved)).data, "Pollo guisado").course).toBe(1);
          expect((await patch(`${R}/orders/${o.id}/items/${pollo.id}`, { course: 9 }, r.cookie)).status).toBe(400);
          // El mismo producto en otro curso es otra línea.
          await post(`${R}/orders/${o.id}/items`, { productId: r.pollo.id, course: 2 }, r.cookie);
          expect(((await getOrder(r, o.id)).items as Json[]).filter((i) => i.name === "Pollo guisado")).toHaveLength(2);
        });

        it("envía a cocina un curso a la vez", async () => {
          const r = await resto("cu2");
          const ensalada = await product(r, { name: "Ensalada", price: "150.00", prepStation: "KITCHEN", course: 1 });
          const flan = await product(r, { name: "Flan", price: "100.00", prepStation: "KITCHEN", course: 3 });
          const o = await openOrder(r);
          await addItem(r, o.id, ensalada.id);
          await addItem(r, o.id, r.pollo.id); // curso 1 por defecto
          await post(`${R}/orders/${o.id}/items`, { productId: r.cerveza.id, course: 2 }, r.cookie);
          await addItem(r, o.id, flan.id);

          const first = await post(`${R}/orders/${o.id}/send`, { course: 1 }, r.cookie);
          expect(first.status).toBe(200);
          const t1 = (await json(first)).data;
          expect(t1.ticket.course).toBe(1);
          expect(t1.ticket.stations[0].items.map((i: Json) => i.name).sort()).toEqual(["Ensalada", "Pollo guisado"]);
          const states = (order: Json) => Object.fromEntries((order.items as Json[]).map((i) => [i.name, i.status]));
          expect(states(t1.order)).toEqual({ Ensalada: "SENT", "Pollo guisado": "SENT", Cerveza: "PENDING", Flan: "PENDING" });

          // La cocina solo ve lo enviado; el postre espera.
          const kitchen = (await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data as Json[];
          expect(kitchen[0]!.items.map((i: Json) => i.name).sort()).toEqual(["Ensalada", "Pollo guisado"]);

          // Un curso sin pendientes no se puede enviar.
          expect((await post(`${R}/orders/${o.id}/send`, { course: 1 }, r.cookie)).status).toBe(422);
          const second = await post(`${R}/orders/${o.id}/send`, { course: 2 }, r.cookie);
          expect((await json(second)).data.ticket.stations.map((s: Json) => s.station)).toEqual(["BAR"]);
          // Sin curso: todo lo que quede.
          const rest = await send(r, o.id);
          expect(states((await json(rest)).data.order)).toEqual({ Ensalada: "SENT", "Pollo guisado": "SENT", Cerveza: "SENT", Flan: "SENT" });
          expect((await post(`${R}/orders/${o.id}/send`, { course: 7 }, r.cookie)).status).toBe(400);
        });
      });

      describe("combos", () => {
        /** «Combo Pollo» RD$400.00: 1 pollo (cocina) + 2 cervezas (bar, con inventario). */
        async function combo(r: Resto, extra: Json = {}) {
          const c = await product(r, { name: "Combo Pollo", price: "400.00", ...extra });
          const cfg = await put(
            `${R}/products/${c.id}/menu`,
            { components: [{ productId: r.pollo.id, quantity: 1 }, { productId: r.cerveza.id, quantity: 2 }] },
            r.cookie,
          );
          expect(cfg.status).toBe(204);
          return c;
        }

        it("se configura con componentes y aparece en la carta", async () => {
          const r = await resto("co1");
          const c = await combo(r);
          const cfg = (await json(await get(`${R}/products/${c.id}/menu`, r.cookie))).data;
          expect(cfg.isCombo).toBe(true);
          expect(cfg.components.map((k: Json) => `${k.quantity} ${k.name}`).sort()).toEqual(["1 Pollo guisado", "2 Cerveza"]);
          const menu = (await json(await get(`${R}/menu`, r.cookie))).data as Json[];
          expect(menu.find((p) => p.id === c.id)).toMatchObject({ isCombo: true });
          expect((await json(await get(`/v1/products/${c.id}`, r.cookie))).data.isCombo).toBe(true);

          // Vaciar los componentes lo devuelve a producto normal.
          expect((await put(`${R}/products/${c.id}/menu`, { components: [] }, r.cookie)).status).toBe(204);
          expect((await json(await get(`/v1/products/${c.id}`, r.cookie))).data.isCombo).toBe(false);
        });

        it("rechaza combos inválidos", async () => {
          const r = await resto("co2");
          const c = await product(r, { name: "Combo X", price: "100.00" });
          const cfg = (components: Json[], extra: Json = {}) => put(`${R}/products/${c.id}/menu`, { components, ...extra }, r.cookie);
          expect((await cfg([{ productId: c.id, quantity: 1 }])).status).toBe(422); // a sí mismo
          expect((await cfg([{ productId: r.pollo.id, quantity: 1 }, { productId: r.pollo.id, quantity: 2 }])).status).toBe(422); // repetido
          expect((await cfg([{ productId: randomUUID(), quantity: 1 }])).status).toBe(422); // no existe
          expect((await cfg([{ productId: r.pollo.id, quantity: 0 }])).status).toBe(400);
          const g = (await json(await group(r, extrasBody))).data;
          expect((await cfg([{ productId: r.pollo.id, quantity: 1 }], { modifierGroupIds: [g.id] })).status).toBe(422); // combo sin modificadores
          expect((await put(`${R}/products/${r.pollo.id}/menu`, { modifierGroupIds: [randomUUID()] }, r.cookie)).status).toBe(422);
          expect((await put(`${R}/products/${randomUUID()}/menu`, {}, r.cookie)).status).toBe(404);

          // Un combo no contiene otro combo, ni un componente puede volverse combo.
          await cfg([{ productId: r.pollo.id, quantity: 1 }]);
          const outer = await product(r, { name: "Combo grande", price: "900.00" });
          expect((await put(`${R}/products/${outer.id}/menu`, { components: [{ productId: c.id, quantity: 1 }] }, r.cookie)).status).toBe(422);
          expect((await put(`${R}/products/${r.pollo.id}/menu`, { components: [{ productId: r.agua.id, quantity: 1 }] }, r.cookie)).status).toBe(422);
          // Ni uno con inventario propio, ni productos por peso como parte.
          const tracked = await product(r, { name: "Combo con stock", price: "10.00", trackInventory: true });
          expect((await put(`${R}/products/${tracked.id}/menu`, { components: [{ productId: r.agua.id, quantity: 1 }] }, r.cookie)).status).toBe(422);
          const peso = await product(r, { name: "Arroz", price: "10.00", allowsDecimals: true, unit: "LB" });
          expect((await put(`${R}/products/${c.id}/menu`, { components: [{ productId: peso.id, quantity: 1 }] }, r.cookie)).status).toBe(422);
          // Y un combo ya configurado no puede pasar a llevar inventario.
          expect((await patch(`/v1/products/${c.id}`, { trackInventory: true }, r.cookie)).status).toBe(422);
        });

        it("anota el combo como una línea que se cobra y sus partes que van a cocina y bar", async () => {
          const r = await resto("co3");
          const c = await combo(r);
          const o = await openOrder(r);
          const res = await addItem(r, o.id, c.id, "2");
          expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
          const order = (await json(res)).data as Json;

          const parent = itemOf(order, "Combo Pollo");
          const parts = (order.items as Json[]).filter((i) => i.parentItemId === parent.id);
          expect(parent).toMatchObject({ quantity: "2", unitPrice: "400.00", parentItemId: null });
          expect(parts.map((p) => `${p.quantity} ${p.name} ${p.unitPrice} ${p.station} ${p.remaining}`).sort()).toEqual([
            "2 Pollo guisado 0.00 KITCHEN 0",
            "4 Cerveza 0.00 BAR 0",
          ]);
          expect(order.totals.total).toBe("800.00"); // solo se cobra el combo
          expect((await patch(`${R}/orders/${o.id}/items/${parts[0]!.id}`, { quantity: "9" }, r.cookie)).status).toBe(409);
          expect((await post(`${R}/orders/${o.id}/items/${parts[0]!.id}/void`, {}, r.cookie)).status).toBe(409);

          // Cambiar los combos mantiene la proporción de las partes.
          const upd = await patch(`${R}/orders/${o.id}/items/${parent.id}`, { quantity: "3", notes: "sin hielo" }, r.cookie);
          const after = (await json(upd)).data as Json;
          const parts3 = (after.items as Json[]).filter((i) => i.parentItemId === parent.id);
          expect(parts3.map((p) => `${p.quantity} ${p.name} ${p.notes}`).sort()).toEqual(["3 Pollo guisado sin hielo", "6 Cerveza sin hielo"]);
          expect(after.totals.total).toBe("1200.00");

          // Cada combo es una línea aparte (no se juntan) y no admite fracciones ni modificadores.
          await addItem(r, o.id, c.id, "1");
          expect(((await getOrder(r, o.id)).items as Json[]).filter((i) => i.name === "Combo Pollo" && !i.parentItemId)).toHaveLength(2);
          expect((await addItem(r, o.id, c.id, "1.5")).status).toBe(422);
        });

        it("al enviar, las partes van a su estación y el combo queda listo; la cocina ve de qué combo son", async () => {
          const r = await resto("co4");
          const c = await combo(r);
          const o = await openOrder(r);
          await addItem(r, o.id, c.id, "1");
          const sent = (await json(await send(r, o.id))).data;
          const byStation = Object.fromEntries(sent.ticket.stations.map((s: Json) => [s.station, s.items.map((i: Json) => `${i.quantity} ${i.name} (${i.combo})`)]));
          expect(byStation).toEqual({ KITCHEN: ["1 Pollo guisado (Combo Pollo)"], BAR: ["2 Cerveza (Combo Pollo)"] });
          expect(itemOf(sent.order, "Combo Pollo").status).toBe("READY");

          const kitchen = (await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data as Json[];
          expect(kitchen[0]!.items[0]).toMatchObject({ name: "Pollo guisado", combo: "Combo Pollo", quantity: "1" });
          const salon = (await json(await get(`${R}/tables`, r.cookie))).data as Json[];
          expect(salon[0]!.order).toMatchObject({ items: 1, waiting: 2 }); // el combo cuenta como un producto
        });

        it("anular un combo enviado anula sus partes; uno sin enviar se quita completo", async () => {
          const r = await resto("co5");
          const c = await combo(r);
          const o = await openOrder(r, 0);
          const o2 = await openOrder(r, 1);

          const p = itemOf((await json(await addItem(r, o.id, c.id, "1"))).data, "Combo Pollo");
          await send(r, o.id);
          const voided = await post(`${R}/orders/${o.id}/items/${p.id}/void`, { reason: "Cliente se fue" }, r.cookie);
          const items = ((await json(voided)).data.items as Json[]);
          expect(items).toHaveLength(3);
          expect(items.every((i) => i.status === "VOID")).toBe(true);
          expect((await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data).toEqual([]);

          const q = itemOf((await json(await addItem(r, o2.id, c.id, "1"))).data, "Combo Pollo");
          const removed = await post(`${R}/orders/${o2.id}/items/${q.id}/void`, {}, r.cookie);
          expect((await json(removed)).data.items).toEqual([]);
        });

        it("cobrar el combo factura una línea y descuenta del inventario sus componentes", async () => {
          const r = await resto("co6");
          const c = await combo(r);
          await post("/v1/inventory/receipts", { productId: r.cerveza.id, branchId: r.branch.id, quantity: "24" }, r.cookie);
          const o = await openOrder(r);
          const parent = itemOf((await json(await addItem(r, o.id, c.id, "2"))).data, "Combo Pollo");
          await send(r, o.id);
          expect(await stockOf(r, r.cerveza.id)).toBe("24"); // anotar o enviar no toca el inventario

          // Primero 1 de 2 combos: 2 cervezas.
          const first = await bill(r, o.id, { propinaLegal: false, items: [{ itemId: parent.id, quantity: "1" }], payments: [{ method: "CASH", amount: "400.00" }] });
          expect(first.status, JSON.stringify(await first.clone().json())).toBe(201);
          const d1 = (await json(first)).data;
          expect(d1.closed).toBe(false);
          expect(d1.document.lines.map((l: Json) => `${l.name} x${l.quantity}`)).toEqual(["Combo Pollo x1"]);
          expect(await stockOf(r, r.cerveza.id)).toBe("22");

          // El resto cierra la mesa y descuenta las otras 2.
          const second = await bill(r, o.id, { propinaLegal: false, payments: [{ method: "CASH", amount: "400.00" }] });
          expect(second.status).toBe(201);
          expect((await json(second)).data.closed).toBe(true);
          expect(await stockOf(r, r.cerveza.id)).toBe("20");
          const movements = (await json(await get(`/v1/inventory/movements?productId=${r.cerveza.id}&type=SALE`, r.cookie))).data as Json[];
          expect(movements.map((m) => m.quantity).sort()).toEqual(["-2", "-2"]);
        });

        it("sin existencia suficiente de un componente no se cobra nada", async () => {
          const r = await resto("co7");
          await patch("/v1/inventory/settings", { allowNegativeStock: false }, r.cookie);
          const c = await combo(r);
          await post("/v1/inventory/receipts", { productId: r.cerveza.id, branchId: r.branch.id, quantity: "1" }, r.cookie);
          const o = await openOrder(r);
          await addItem(r, o.id, c.id, "1"); // necesita 2 cervezas
          const res = await bill(r, o.id, { propinaLegal: false, payments: [{ method: "CASH", amount: "400.00" }] });
          expect(res.status).toBe(422);
          expect(await error(res)).toMatch(/Cerveza/);
          const after = await getOrder(r, o.id);
          expect(after.status).toBe("OPEN");
          expect((await json(await get("/v1/documents", r.cookie))).total).toBe(0);
          expect(await stockOf(r, r.cerveza.id)).toBe("1");
          // Con el siguiente cobro correcto, el e-NCF sigue siendo el 1.
          await post("/v1/inventory/receipts", { productId: r.cerveza.id, branchId: r.branch.id, quantity: "5" }, r.cookie);
          expect((await json(await bill(r, o.id, { propinaLegal: false, payments: [{ method: "CASH", amount: "400.00" }] }))).data.document.encf).toBe("E320000000001");
        });

        it("cobrar un combo sin enviar deja sus partes como entregadas", async () => {
          const r = await resto("co8");
          const c = await combo(r);
          const o = await openOrder(r);
          await addItem(r, o.id, c.id, "1");
          const res = await bill(r, o.id, { propinaLegal: false, payments: [{ method: "CASH", amount: "400.00" }] });
          expect(res.status).toBe(201);
          const order = (await json(res)).data.order as Json;
          expect(order.status).toBe("CLOSED");
          expect((order.items as Json[]).map((i) => i.status)).toEqual(["READY", "READY", "READY"]);
          expect((await json(await get(`${R}/kitchen?station=KITCHEN`, r.cookie))).data).toEqual([]);
        });

        it("un componente desactivado impide anotar el combo, y los combos aislados por empresa", async () => {
          const r = await resto("co9");
          const other = await resto("co9b");
          const c = await combo(r);
          expect((await put(`${R}/products/${c.id}/menu`, { components: [{ productId: other.pollo.id, quantity: 1 }] }, r.cookie)).status).toBe(422);
          await call(`/v1/products/${r.pollo.id}`, { method: "DELETE", cookie: r.cookie });
          const o = await openOrder(r);
          const res = await addItem(r, o.id, c.id, "1");
          expect(res.status).toBe(422);
          expect(await error(res)).toMatch(/Pollo guisado/);
          expect(((await json(await get(`${R}/menu`, other.cookie))).data as Json[]).some((p) => p.isCombo)).toBe(false);
          expect((await get(`${R}/products/${c.id}/menu`, other.cookie)).status).toBe(404);
        });
      });
    });

    describe("aislamiento", () => {
      it("cada empresa ve solo sus mesas y comandas", async () => {
        const a = await resto("ra1");
        const b = await resto("ra2");
        const order = await tableWithOrder(a);

        expect((await get(`${R}/orders/${order.id}`, b.cookie)).status).toBe(404);
        expect((await send(b, order.id)).status).toBe(404);
        expect((await bill(b, order.id)).status).toBe(404);
        expect((await post(`${R}/orders`, { tableId: a.tables[1]!.id }, b.cookie)).status).toBe(422);
        expect((await post(`${R}/orders/${order.id}/items`, { productId: b.pollo.id }, b.cookie)).status).toBe(404);
        const salonB = (await json(await get(`${R}/tables`, b.cookie))).data as Json[];
        expect(salonB.every((t) => t.order === null)).toBe(true);
        expect((await json(await get(`${R}/kitchen?station=KITCHEN`, b.cookie))).data).toEqual([]);
      });

      it("el producto guarda su estación de preparación", async () => {
        const r = await resto("ra3");
        expect(r.pollo.prepStation).toBe("KITCHEN");
        expect(r.agua.prepStation).toBe("NONE");
        const upd = await patch(`/v1/products/${r.agua.id}`, { prepStation: "BAR" }, r.cookie);
        expect((await json(upd)).data).toMatchObject({ prepStation: "BAR", name: "Agua" });
      });
    });
  });

  // ───────────── Turnos de caja ─────────────

  describe("turnos de caja", () => {
    const S = "/v1/shifts";
    /** Empresa con una caja y secuencias E32/E34. */
    async function caja(label: string) {
      const b = await billing(label, { seqs: [["E32", 1, 100], ["E34", 1, 50]] });
      const res = await post("/v1/terminals", { branchId: b.branch.id, name: "Caja 1", code: "C1" }, b.cookie);
      expect(res.status).toBe(201);
      const terminal = (await json(res)).data as Json;
      return { ...b, terminal };
    }
    type Caja = Awaited<ReturnType<typeof caja>>;

    const open = (c: Caja, amount = "1000.00", cookie = c.cookie) =>
      post(S, { terminalId: c.terminal.id, openingAmount: amount }, cookie);
    const close = (c: Caja, id: string, body: Json, cookie = c.cookie) => post(`${S}/${id}/close`, body, cookie);
    const current = async (c: Caja, cookie = c.cookie) =>
      (await json(await get(`${S}/current?terminalId=${c.terminal.id}`, cookie))).data as Json | null;
    /** Vende RD$236.00 en la caja (dos productos de RD$118.00) con el medio de pago indicado. */
    async function sell(c: Caja, method = "CASH") {
      const d = await createDraft(c, { terminalId: c.terminal.id, payments: [{ method, amount: "236.00" }] });
      const res = await issue(c, d.id);
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
      return (await json(res)).data as Json;
    }
    const cashier = async (c: Caja, label: string) => {
      const u = await signUp(label);
      await prisma.member.create({ data: { id: randomUUID(), organizationId: c.orgId, userId: u.userId, role: "member" } });
      return setActive(c.orgId, u.cookie);
    };

    describe("apertura", () => {
      it("abre un turno con su fondo y lo muestra como el turno actual", async () => {
        const c = await caja("sh1");
        expect(await current(c)).toBeNull();
        const res = await open(c, "1500.50");
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        const shift = (await json(res)).data as Json;
        expect(shift).toMatchObject({ status: "OPEN", openingAmount: "1500.50", closedAt: null, countedCash: null });
        expect(shift.terminal).toMatchObject({ code: "C1" });
        expect(shift.openedBy.name).toMatch(/Usuario/);

        const now = (await current(c))!;
        expect(now.id).toBe(shift.id);
        expect(now.report).toMatchObject({ documents: 0, openingAmount: "1500.50", expectedCash: "1500.50", cashReceived: "0.00", net: "0.00" });
      });

      it("el fondo es opcional (cero) y no puede ser negativo", async () => {
        const c = await caja("sh2");
        expect((await post(S, { terminalId: c.terminal.id, openingAmount: "-5" }, c.cookie)).status).toBe(400);
        expect((await post(S, { terminalId: c.terminal.id, openingAmount: "abc" }, c.cookie)).status).toBe(400);
        const res = await post(S, { terminalId: c.terminal.id }, c.cookie);
        expect((await json(res)).data.openingAmount).toBe("0.00");
      });

      it("una caja tiene un solo turno abierto, aunque lo intenten a la vez", async () => {
        const c = await caja("sh3");
        const results = await Promise.all(Array.from({ length: 4 }, () => open(c)));
        expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
        expect((await open(c)).status).toBe(409);
      });

      it("rechaza cajas inexistentes, inactivas o de otra empresa", async () => {
        const c = await caja("sh4");
        const other = await caja("sh4b");
        expect((await post(S, { terminalId: randomUUID() }, c.cookie)).status).toBe(422);
        expect((await post(S, { terminalId: other.terminal.id }, c.cookie)).status).toBe(422);
        await patch(`/v1/terminals/${c.terminal.id}`, { active: false }, c.cookie);
        expect((await open(c)).status).toBe(422);
        expect((await get(S)).status).toBe(401);
      });
    });

    describe("informe y cierre", () => {
      it("el informe suma ventas por forma de pago, resta notas de crédito y calcula el efectivo esperado", async () => {
        const c = await caja("sh5");
        const shift = (await json(await open(c, "1000.00"))).data as Json;
        const first = await sell(c, "CASH");
        await sell(c, "CARD");
        const note = await createDraft(c, {
          type: "E34",
          terminalId: c.terminal.id,
          referencedDocumentId: first.id,
          modificationCode: 3,
          lines: [{ name: "Ajuste", unitPrice: "50.00", tax: "EXENTO", quantity: "1" }],
          payments: [],
        });
        expect((await issue(c, note.id)).status).toBe(200);

        const x = (await current(c))!.report;
        expect(x).toMatchObject({
          documents: 3,
          sales: { subtotal: "400.00", tax: "72.00", propina: "0.00", total: "472.00" },
          credits: "50.00",
          net: "422.00",
          payments: { CARD: "236.00", CASH: "236.00" },
          cashReceived: "236.00",
          expectedCash: "1236.00",
        });
        expect(x.byType.E32).toEqual({ count: 2, total: "472.00" });
        expect(x.byType.E34).toEqual({ count: 1, total: "50.00" });
        // Los comprobantes quedan marcados con su turno.
        const doc = (await json(await get(`/v1/documents/${first.id}`, c.cookie))).data;
        expect(doc.shiftId).toBe(shift.id);
      });

      it("cierra con el cuadre y congela el informe Z; el turno cerrado no se toca más", async () => {
        const c = await caja("sh6");
        const shift = (await json(await open(c, "1000.00"))).data as Json;
        await sell(c, "CASH");

        const res = await close(c, shift.id, { countedCash: "1236.00" });
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
        const closed = (await json(res)).data as Json;
        expect(closed).toMatchObject({ status: "CLOSED", countedCash: "1236.00", expectedCash: "1236.00", difference: "0.00" });
        expect(closed.closedBy.id).toBe(closed.openedBy.id);
        expect(closed.report).toMatchObject({ documents: 1, expectedCash: "1236.00", countedCash: "1236.00", difference: "0.00" });

        expect((await close(c, shift.id, { countedCash: "1.00" })).status).toBe(409);
        expect(await current(c)).toBeNull();
        const detail = (await json(await get(`${S}/${shift.id}`, c.cookie))).data;
        expect(detail.report).toEqual(closed.report);
        // Lo que se venda después ya no entra en ese turno; el siguiente turno parte de cero.
        const later = await sell(c, "CASH");
        expect((await json(await get(`/v1/documents/${later.id}`, c.cookie))).data.shiftId).toBeNull();
        const next = (await json(await open(c, "200.00"))).data as Json;
        expect((await current(c))!.report).toMatchObject({ documents: 0, expectedCash: "200.00" });
        expect(next.id).not.toBe(shift.id);
      });

      it("una diferencia de efectivo exige el motivo y queda registrada", async () => {
        const c = await caja("sh7");
        const shift = (await json(await open(c, "1000.00"))).data as Json;
        await sell(c, "CASH"); // esperado 1236.00

        const short = await close(c, shift.id, { countedCash: "1200.00" });
        expect(short.status).toBe(422);
        expect(await error(short)).toMatch(/diferencia/);
        expect((await current(c))!.status).toBe("OPEN"); // nada cambió

        const ok = await close(c, shift.id, { countedCash: "1200.00", notes: "Faltaron 36 pesos del cambio" });
        expect((await json(ok)).data).toMatchObject({ difference: "-36.00", notes: "Faltaron 36 pesos del cambio" });

        const c2 = await caja("sh7b");
        const s2 = (await json(await open(c2, "100.00"))).data as Json;
        const over = await close(c2, s2.id, { countedCash: "150.00", notes: "Propina en la gaveta" });
        expect((await json(over)).data.difference).toBe("50.00");
        expect((await close(c2, s2.id, { countedCash: "-1", notes: "x" })).status).toBe(400);
      });

      it("un comprobante preparado antes de abrir el turno entra al turno en que se emite", async () => {
        const c = await caja("sh8");
        const draft = await createDraft(c, { terminalId: c.terminal.id, payments: [{ method: "CASH", amount: "236.00" }] });
        const shift = (await json(await open(c))).data as Json;
        const issued = (await json(await issue(c, draft.id))).data;
        expect(issued.shiftId).toBe(shift.id);
        // Sin terminal (facturación desde el back-office) no hay turno.
        const web = await createDraft(c);
        expect((await json(await issue(c, web.id))).data.shiftId).toBeNull();
        expect((await current(c))!.report.documents).toBe(1);
      });

      it("emisiones y cierre simultáneos: cada comprobante cae en el informe o fuera del turno, nunca se pierde", async () => {
        const c = await caja("sh9");
        const shift = (await json(await open(c, "0"))).data as Json;
        const drafts = await Promise.all(
          Array.from({ length: 5 }, () => createDraft(c, { terminalId: c.terminal.id, payments: [{ method: "CASH", amount: "236.00" }] })),
        );
        const [closeRes, ...issues] = await Promise.all([
          close(c, shift.id, { countedCash: "0.00", notes: "Cierre durante ventas" }),
          ...drafts.map((d) => issue(c, d.id)),
        ]);
        expect(issues.every((r) => r.status === 200)).toBe(true);
        expect(closeRes.status, JSON.stringify(await closeRes.clone().json())).toBe(200);

        // Lo contado en el informe Z es exactamente lo que quedó atado al turno.
        const z = (await json(await get(`${S}/${shift.id}`, c.cookie))).data.report;
        const docs = (await json(await get("/v1/documents?pageSize=50", c.cookie))).data as Json[];
        const attached = docs.filter((d) => d.shiftId === shift.id).length;
        expect(z.documents).toBe(attached);
      });
    });

    describe("permisos", () => {
      it("el cajero abre su turno y lo cierra; otro cajero no ve ni cierra turnos ajenos, el administrador sí", async () => {
        const c = await caja("sh10");
        const ana = await cashier(c, "sh10a");
        const luis = await cashier(c, "sh10l");

        const shift = (await json(await open(c, "500.00", ana))).data as Json;
        expect((await current(c, ana))!.id).toBe(shift.id);
        expect((await get(`${S}/current?terminalId=${c.terminal.id}`, luis)).status).toBe(403);
        expect((await get(`${S}/${shift.id}`, luis)).status).toBe(404);
        expect((await close(c, shift.id, { countedCash: "500.00" }, luis)).status).toBe(403);
        expect((await open(c, "0", luis)).status).toBe(409); // la caja está en uso

        const mine = (await json(await get(S, luis))).data as Json[];
        expect(mine).toEqual([]);
        expect(((await json(await get(S, ana))).data as Json[]).map((s) => s.id)).toEqual([shift.id]);
        expect(((await json(await get(S, c.cookie))).data as Json[]).map((s) => s.id)).toEqual([shift.id]);

        // El administrador puede cerrar el turno de otra persona.
        const res = await close(c, shift.id, { countedCash: "500.00" }, c.cookie);
        expect(res.status).toBe(200);
        const closedShift = (await json(res)).data;
        expect(closedShift.openedBy.id).not.toBe(closedShift.closedBy.id);
        // Y el cajero cierra el suyo.
        const own = (await json(await open(c, "10.00", luis))).data as Json;
        expect((await close(c, own.id, { countedCash: "10.00" }, luis)).status).toBe(200);
      });

      it("filtra el listado por caja, estado y fechas, y pagina", async () => {
        const c = await caja("sh11");
        const a = (await json(await open(c, "1.00"))).data as Json;
        await close(c, a.id, { countedCash: "1.00" });
        await open(c, "2.00");

        const list = async (q: string) => (await json(await get(`${S}${q}`, c.cookie))) as Json;
        expect((await list("")).data.map((s: Json) => s.openingAmount)).toEqual(["2.00", "1.00"]); // el más reciente primero
        expect((await list("?status=OPEN")).data).toHaveLength(1);
        expect((await list("?status=CLOSED")).data[0].id).toBe(a.id);
        expect((await list(`?terminalId=${randomUUID()}`)).total).toBe(0);
        const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(new Date());
        expect((await list(`?from=${today}&to=${today}`)).total).toBe(2);
        expect((await list("?from=2020-01-01&to=2020-01-02")).total).toBe(0);
        const page = await list("?pageSize=1&page=2");
        expect(page).toMatchObject({ total: 2, page: 2, pageSize: 1 });
        expect(page.data).toHaveLength(1);
        expect((await get(`${S}?status=otro`, c.cookie)).status).toBe(400);
      });

      it("cada empresa ve solo sus turnos", async () => {
        const a = await caja("sh12a");
        const b = await caja("sh12b");
        const shift = (await json(await open(a))).data as Json;
        expect((await get(`${S}/${shift.id}`, b.cookie)).status).toBe(404);
        expect((await close(b, shift.id, { countedCash: "0" })).status).toBe(404);
        expect(((await json(await get(S, b.cookie))).data as Json[])).toEqual([]);
        expect(await current({ ...b, terminal: a.terminal } as Caja, b.cookie)).toBeNull();
      });
    });
  });

  // ───────────── Sincronización con la caja ─────────────

  describe("sincronización con la caja", () => {
    const Y = "/v1/sync";

    async function pos(label: string, seqTo = 100) {
      const b = await billing(label, { seqs: [["E32", 1, seqTo], ["E31", 1, 50]] });
      const t = await post("/v1/terminals", { branchId: b.branch.id, name: "Caja 1", code: "C1" }, b.cookie);
      expect(t.status).toBe(201);
      return { ...b, terminal: (await json(t)).data as Json };
    }
    type Pos = Awaited<ReturnType<typeof pos>>;

    const block = (p: Pos, size: number, type = "E32", terminalId = p.terminal.id, cookie = p.cookie) =>
      post(`${Y}/sequence-blocks`, { terminalId, ecfType: type, size }, cookie);
    const encfOf = (type: string, n: number) => `E${type.slice(1)}${String(n).padStart(10, "0")}`;
    const saleBody = (p: Pos, n: number, over: Json = {}) => ({
      clientId: randomUUID(),
      terminalId: p.terminal.id,
      type: "E32",
      encf: encfOf("E32", n),
      issuedAt: "2026-10-20T15:30:00.000Z",
      lines: [{ productId: p.product.id, name: "Producto 118", quantity: "2", unitPrice: "118.00", tax: "ITBIS18", priceIncludesTax: true }],
      payments: [{ method: "CASH", amount: "236.00" }],
      total: "236.00",
      ...over,
    });
    const upload = (p: Pos, body: Json, cookie = p.cookie) => post(`${Y}/sales`, body, cookie);

    describe("catálogo", () => {
      it("baja productos, clientes, categorías y datos fiscales, y luego solo lo que cambió", async () => {
        const p = await pos("sy1");
        await post("/v1/categories", { name: "Bebidas" }, p.cookie);
        await post("/v1/customers", { name: "Cliente Uno", documentType: "RNC", documentNumber: "131246796" }, p.cookie);

        const first = (await json(await get(`${Y}/catalog`, p.cookie))) as Json;
        expect(first.hasMore).toBe(false);
        expect(first.data.products.map((x: Json) => x.name)).toEqual(["Producto 118"]);
        expect(first.data.products[0]).toMatchObject({ price: "118.00", tax: "ITBIS18", priceIncludesTax: true, active: true, barcode: null });
        expect(first.data.customers[0]).toMatchObject({ name: "Cliente Uno", documentType: "RNC", documentNumber: "131246796" });
        expect(first.data.categories.map((x: Json) => x.name)).toEqual(["Bebidas"]);
        expect(first.data.company).toMatchObject({ legalName: "Empresa de Prueba SRL", rnc: "101001577" });

        // Sin cambios: nada nuevo y el cursor se conserva.
        const same = (await json(await get(`${Y}/catalog?cursor=${first.cursor}`, p.cookie))) as Json;
        expect(same.data.products).toEqual([]);
        expect(same.data.customers).toEqual([]);
        expect(same.cursor).toBe(first.cursor);

        // Un cambio y un producto nuevo (y uno desactivado, que también baja).
        await patch(`/v1/products/${p.product.id}`, { price: "130.00" }, p.cookie);
        const nuevo = (await json(await post("/v1/products", { name: "Agua", price: "50.00", barcode: "7461" }, p.cookie))).data;
        await call(`/v1/products/${nuevo.id}`, { method: "DELETE", cookie: p.cookie });
        const delta = (await json(await get(`${Y}/catalog?cursor=${first.cursor}`, p.cookie))) as Json;
        expect(delta.data.products.map((x: Json) => `${x.name}:${x.price}:${x.active}`)).toEqual(["Producto 118:130.00:true", "Agua:50.00:false"]);
        expect(delta.data.customers).toEqual([]);
      });

      it("pagina con límite sin saltarse ni repetir filas", async () => {
        const p = await pos("sy2");
        for (let i = 0; i < 6; i++) await post("/v1/products", { name: `Prod ${i}`, price: "10.00" }, p.cookie);
        const seen: string[] = [];
        let cursor = "";
        for (let guard = 0; guard < 10; guard++) {
          const page = (await json(await get(`${Y}/catalog?limit=3${cursor ? `&cursor=${cursor}` : ""}`, p.cookie))) as Json;
          seen.push(...page.data.products.map((x: Json) => x.id));
          cursor = page.cursor;
          if (!page.hasMore) break;
        }
        expect(seen).toHaveLength(7); // el de billing() + 6
        expect(new Set(seen).size).toBe(7);
      });

      it("valida el cursor y aísla por empresa", async () => {
        const a = await pos("sy3a");
        const b = await pos("sy3b");
        expect((await get(`${Y}/catalog?cursor=basura`, a.cookie)).status).toBe(422);
        expect((await get(`${Y}/catalog?limit=0`, a.cookie)).status).toBe(400);
        expect((await get(`${Y}/catalog`)).status).toBe(401);
        await post("/v1/products", { name: "Solo de A", price: "1.00" }, a.cookie);
        const names = ((await json(await get(`${Y}/catalog`, b.cookie))).data.products as Json[]).map((x) => x.name);
        expect(names).not.toContain("Solo de A");
      });
    });

    describe("bloques de e-NCF", () => {
      it("corta un bloque del final del rango general y lo entrega a la caja", async () => {
        const p = await pos("sy4");
        const res = await block(p, 30);
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        const b = (await json(res)).data as Json;
        expect(b).toMatchObject({ terminalId: p.terminal.id, ecfType: "E32", fromNumber: 71, toNumber: 100, nextNumber: 71, remaining: 30 });

        const seqs = ((await json(await get("/v1/sequences", p.cookie))).data as Json[]).filter((s) => s.ecfType === "E32");
        const general = seqs.find((s) => !s.terminalId)!;
        expect(general).toMatchObject({ fromNumber: 1, toNumber: 70 });
        expect((await json(await get(`${Y}/sequence-blocks?terminalId=${p.terminal.id}`, p.cookie))).data).toHaveLength(1);

        // La nube nunca asigna números del bloque: al agotar el rango general ya no se puede emitir en línea.
        const sell = async () => {
          const d = await createDraft(p, { terminalId: p.terminal.id });
          return (await issue(p, d.id)).status;
        };
        expect(await sell()).toBe(200);
        const next = (await json(await post("/v1/documents/" + (await createDraft(p)).id + "/issue", {}, p.cookie))).data.encf;
        expect(next).toBe(encfOf("E32", 2)); // sigue por el general, no por el bloque
      });

      it("la emisión en línea no toca el bloque de la caja", async () => {
        const p = await pos("sy5", 10);
        expect((await block(p, 9)).status).toBe(201); // general queda con 1 número
        const d1 = await createDraft(p, { terminalId: p.terminal.id });
        expect((await json(await issue(p, d1.id))).data.encf).toBe(encfOf("E32", 1));
        const d2 = await createDraft(p, { terminalId: p.terminal.id });
        const second = await issue(p, d2.id);
        expect(second.status).toBe(422); // los 9 números del bloque pertenecen a la caja
        expect(await error(second)).toMatch(/No hay una secuencia vigente/);
      });

      it("no entrega más de lo que hay y los bloques simultáneos no se solapan", async () => {
        const p = await pos("sy6", 100);
        expect((await block(p, 101)).status).toBe(422);
        const results = await Promise.all([block(p, 40), block(p, 40), block(p, 40)]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 201, 422]);
        const blocks = (await Promise.all(results.filter((r) => r.status === 201).map(async (r) => (await json(r)).data))) as Json[];
        const [a, b] = blocks.sort((x, y) => x.fromNumber - y.fromNumber);
        expect(a!.toNumber).toBeLessThan(b!.fromNumber);
        expect(a!.toNumber - a!.fromNumber + 1).toBe(40);
      });

      it("rechaza cajas inválidas, tipos que no son de venta y tamaños fuera de rango", async () => {
        const p = await pos("sy7");
        const other = await pos("sy7b");
        expect((await block(p, 10, "E32", randomUUID())).status).toBe(422);
        expect((await block(p, 10, "E32", other.terminal.id)).status).toBe(422); // de otra empresa
        expect((await block(p, 0)).status).toBe(400);
        expect((await block(p, 5001)).status).toBe(400);
        expect((await block(p, 10, "E34")).status).toBe(400);
        expect((await block(p, 10, "E31")).status).toBe(201);
        await patch(`/v1/terminals/${p.terminal.id}`, { active: false }, p.cookie);
        expect((await block(p, 10)).status).toBe(422);
      });

      it("el cajero (member) puede pedir el bloque de su caja", async () => {
        const p = await pos("sy8");
        const u = await signUp("sy8c");
        await prisma.member.create({ data: { id: randomUUID(), organizationId: p.orgId, userId: u.userId, role: "member" } });
        const cookie = await setActive(p.orgId, u.cookie);
        expect((await block(p, 10, "E32", p.terminal.id, cookie)).status).toBe(201);
      });
    });

    describe("subida de ventas", () => {
      it("crea el comprobante emitido con el e-NCF y la fecha de la caja, y avanza el bloque", async () => {
        const p = await pos("sy9");
        const b = (await json(await block(p, 20))).data as Json; // 81..100
        const body = saleBody(p, b.fromNumber);
        const res = await upload(p, body);
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        const doc = (await json(res)).data as Json;
        expect(doc).toMatchObject({ status: "ISSUED", encf: encfOf("E32", 81), type: "E32", duplicate: false, total: "236.00" });
        expect(doc.issuedAt).toBe("2026-10-20T15:30:00.000Z");
        expect(doc.totals).toMatchObject({ subtotal: "200.00", tax: "36.00", total: "236.00" });

        const detail = (await json(await get(`/v1/documents/${doc.id}`, p.cookie))).data;
        expect(detail).toMatchObject({ terminalId: p.terminal.id, shiftId: null });
        expect(detail.payments).toHaveLength(1);
        const after = ((await json(await get(`${Y}/sequence-blocks?terminalId=${p.terminal.id}`, p.cookie))).data as Json[])[0]!;
        expect(after).toMatchObject({ nextNumber: 82, remaining: 19 });
      });

      it("reintentar la misma venta no duplica nada", async () => {
        const p = await pos("sy10");
        const b = (await json(await block(p, 10))).data as Json;
        const body = saleBody(p, b.fromNumber);
        const first = await upload(p, body);
        const again = await upload(p, body);
        expect(first.status).toBe(201);
        expect(again.status).toBe(200);
        const [x, y] = [(await json(first)).data, (await json(again)).data];
        expect(y).toMatchObject({ id: x.id, encf: x.encf, duplicate: true });
        expect((await json(await get("/v1/documents", p.cookie))).total).toBe(1);
      });

      it("subidas simultáneas de la misma venta dan un solo comprobante", async () => {
        const p = await pos("sy11");
        const b = (await json(await block(p, 10))).data as Json;
        const body = saleBody(p, b.fromNumber);
        const results = await Promise.all(Array.from({ length: 4 }, () => upload(p, body)));
        expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
        expect(new Set(await Promise.all(results.map(async (r) => (await json(r)).data.id))).size).toBe(1);
        expect((await json(await get("/v1/documents", p.cookie))).total).toBe(1);
      });

      it("solo acepta e-NCF del bloque de esa caja, del tipo correcto y sin usar", async () => {
        const p = await pos("sy12");
        const other = (await json(await post("/v1/terminals", { branchId: p.branch.id, name: "Caja 2", code: "C2" }, p.cookie))).data as Json;
        const mine = (await json(await block(p, 10))).data as Json; // 91..100
        const theirs = (await json(await block(p, 10, "E32", other.id))).data as Json; // 81..90

        const outside = await upload(p, saleBody(p, 5));
        expect(outside.status).toBe(422);
        expect(await error(outside)).toMatch(/no pertenece a un bloque/);
        expect((await upload(p, saleBody(p, theirs.fromNumber))).status).toBe(422); // número de la otra caja
        expect((await upload(p, saleBody(p, mine.fromNumber, { encf: "E310000000091" }))).status).toBe(422); // tipo distinto del e-NCF
        expect((await upload(p, saleBody(p, mine.fromNumber, { encf: "basura" }))).status).toBe(400);
        expect((await upload(p, saleBody(p, mine.fromNumber, { terminalId: randomUUID() }))).status).toBe(422);

        expect((await upload(p, saleBody(p, mine.fromNumber))).status).toBe(201);
        const reused = await upload(p, saleBody(p, mine.fromNumber)); // otro clientId con el mismo número
        expect(reused.status).toBe(409);
        // Y no se pierde el siguiente número.
        expect((await upload(p, saleBody(p, mine.fromNumber + 1))).status).toBe(201);
      });

      it("el total de la caja debe coincidir con el de la nube", async () => {
        const p = await pos("sy13");
        const b = (await json(await block(p, 10))).data as Json;
        const bad = await upload(p, saleBody(p, b.fromNumber, { total: "235.00" }));
        expect(bad.status).toBe(422);
        expect(await error(bad)).toMatch(/no coincide/);
        const short = await upload(p, saleBody(p, b.fromNumber, { payments: [{ method: "CASH", amount: "100.00" }] }));
        expect(short.status).toBe(422); // los pagos no suman
        expect((await json(await get("/v1/documents", p.cookie))).total).toBe(0);
        // Nada se quemó: el mismo número sirve después.
        expect((await upload(p, saleBody(p, b.fromNumber))).status).toBe(201);
      });

      it("respeta los precios impresos aunque el producto cambie o se desactive, y no rechaza por inventario", async () => {
        const p = await pos("sy14");
        await patch("/v1/inventory/settings", { allowNegativeStock: false }, p.cookie);
        await patch(`/v1/products/${p.product.id}`, { trackInventory: true }, p.cookie);
        const b = (await json(await block(p, 10))).data as Json;

        await patch(`/v1/products/${p.product.id}`, { price: "999.00", active: false }, p.cookie);
        const res = await upload(p, saleBody(p, b.fromNumber));
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
        const doc = (await json(await get(`/v1/documents/${(await json(res)).data.id}`, p.cookie))).data;
        expect(doc.lines[0]).toMatchObject({ unitPrice: "118.00", quantity: "2" });
        // La venta ya ocurrió: el inventario queda en negativo en vez de rechazarla.
        const moves = (await json(await get(`/v1/inventory/movements?productId=${p.product.id}&type=SALE`, p.cookie))).data as Json[];
        expect(moves.map((m) => m.quantity)).toEqual(["-2"]);
        expect(moves[0]!.balanceAfter).toBe("-2");
      });

      it("aplica las reglas del comprador y usa al cliente sincronizado", async () => {
        const p = await pos("sy15");
        const b = (await json(await block(p, 20, "E31"))).data as Json; // 31..50
        const e31 = (n: number, over: Json = {}) => saleBody(p, n, { type: "E31", encf: encfOf("E31", n), ...over });
        const noRnc = await upload(p, e31(b.fromNumber));
        expect(noRnc.status).toBe(422);
        expect(await error(noRnc)).toMatch(/RNC/);

        const customer = (await json(await post("/v1/customers", { name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" }, p.cookie))).data;
        const ok = await upload(p, e31(b.fromNumber, { customerId: customer.id }));
        expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(201);
        expect((await json(ok)).data).toMatchObject({ type: "E31", buyerName: "Acme SRL", encf: encfOf("E31", b.fromNumber) });
      });

      it("la propina legal y los pagos mixtos se suben tal como se cobraron", async () => {
        const p = await pos("sy16");
        const b = (await json(await block(p, 10))).data as Json;
        const res = await upload(
          p,
          saleBody(p, b.fromNumber, {
            propinaLegal: true,
            total: "259.60", // 236.00 + 10 % de 200.00 (subtotal sin ITBIS) = 256.00; con ITBIS de la propina no aplica
            payments: [{ method: "CASH", amount: "100.00" }, { method: "CARD", amount: "156.00" }],
          }),
        );
        expect(res.status, JSON.stringify(await res.clone().json())).toBe(422);
        const ok = await upload(
          p,
          saleBody(p, b.fromNumber, {
            propinaLegal: true,
            total: "256.00",
            payments: [{ method: "CASH", amount: "100.00" }, { method: "CARD", amount: "156.00" }],
          }),
        );
        expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(201);
        expect((await json(ok)).data.totals).toMatchObject({ propina: "20.00", total: "256.00" });
      });

      it("las ventas subidas no se atan al turno abierto y cada empresa queda aislada", async () => {
        const a = await pos("sy17a");
        const other = await pos("sy17b");
        const b = (await json(await block(a, 10))).data as Json;
        await post("/v1/shifts", { terminalId: a.terminal.id, openingAmount: "0" }, a.cookie);
        const doc = (await json(await upload(a, saleBody(a, b.fromNumber)))).data;
        expect((await json(await get(`/v1/documents/${doc.id}`, a.cookie))).data.shiftId).toBeNull();

        // Otra empresa no puede subir al bloque ajeno ni ver el comprobante.
        expect((await upload(other, saleBody(a, b.fromNumber, { terminalId: a.terminal.id }), other.cookie)).status).toBe(422);
        expect((await get(`/v1/documents/${doc.id}`, other.cookie)).status).toBe(404);
        expect((await get(`${Y}/sequence-blocks?terminalId=${a.terminal.id}`, other.cookie)).status).toBe(200);
        expect(((await json(await get(`${Y}/sequence-blocks?terminalId=${a.terminal.id}`, other.cookie))).data as Json[])).toEqual([]);
        expect((await post(`${Y}/sales`, saleBody(a, b.fromNumber))).status).toBe(401);
      });
    });
  });

  describe("bitácora", () => {
    it("registra cada cambio, de forma atómica con el cambio", async () => {
      const { cookie, orgId } = await owner("log");
      const p = (
        await json(await post("/v1/products", { name: "Auditado", price: "10" }, cookie))
      ).data;
      await patch(`/v1/products/${p.id}`, { price: "11" }, cookie);
      await post("/v1/branches", { name: "Sucursal Log", code: "LOG-1" }, cookie);
      // Una operación fallida no debe dejar rastro en la bitácora.
      await post("/v1/branches", { name: "Duplicada", code: "LOG-1" }, cookie);

      const logs = await withTenant(prisma, orgId).auditLog.findMany({
        orderBy: { createdAt: "asc" },
      });
      expect(logs.map((l) => l.action).sort()).toEqual([
        "branch.create",
        "product.create",
        "product.update",
      ]);
      expect(logs.every((l) => l.actorUserId)).toBe(true);
    });
  });
});
