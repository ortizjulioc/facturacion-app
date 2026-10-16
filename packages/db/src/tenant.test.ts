import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, tenantTransaction, withTenant } from "./index";

/**
 * Prueba el aislamiento por empresa DIRECTAMENTE contra Postgres, conectando con el rol de la
 * app (facturacion_app): si RLS falla, estas pruebas lo detectan aunque el código de la API sea correcto.
 * Se omiten si no hay DATABASE_URL.
 */
describe.skipIf(!process.env.DATABASE_URL)("RLS multiempresa", () => {
  const prisma = createPrisma({ connectionString: process.env.DATABASE_URL ?? "", max: 3 });
  const orgA = `test-a-${randomUUID()}`;
  const orgB = `test-b-${randomUUID()}`;

  beforeAll(async () => {
    await prisma.organization.createMany({
      data: [
        { id: orgA, name: "Empresa A", slug: orgA },
        { id: orgB, name: "Empresa B", slug: orgB },
      ],
    });
    await withTenant(prisma, orgA).branch.create({
      data: { organizationId: orgA, name: "Principal A", code: "A1" },
    });
    await withTenant(prisma, orgB).branch.create({
      data: { organizationId: orgB, name: "Principal B", code: "B1" },
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await prisma.$disconnect();
  });

  it("cada empresa solo ve sus propias filas", async () => {
    const a = await withTenant(prisma, orgA).branch.findMany();
    const b = await withTenant(prisma, orgB).branch.findMany();
    expect(a.map((r) => r.code)).toEqual(["A1"]);
    expect(b.map((r) => r.code)).toEqual(["B1"]);
  });

  it("un where explícito no puede saltarse el aislamiento", async () => {
    const leaked = await withTenant(prisma, orgA).branch.findMany({
      where: { organizationId: orgB },
    });
    expect(leaked).toEqual([]);
  });

  it("sin tenant fijado no se devuelve nada (falla cerrado)", async () => {
    const rows = await prisma.branch.findMany({
      where: { organizationId: { in: [orgA, orgB] } },
    });
    expect(rows).toEqual([]);
  });

  it("no se puede insertar datos en otra empresa", async () => {
    await expect(
      withTenant(prisma, orgA).branch.create({
        data: { organizationId: orgB, name: "Intruso", code: "X1" },
      }),
    ).rejects.toThrow();
  });

  it("no se puede modificar ni borrar filas de otra empresa", async () => {
    const asA = withTenant(prisma, orgA);
    const upd = await asA.branch.updateMany({
      where: { organizationId: orgB },
      data: { name: "hackeado" },
    });
    const del = await asA.branch.deleteMany({ where: { organizationId: orgB } });
    expect(upd.count).toBe(0);
    expect(del.count).toBe(0);
    expect(await withTenant(prisma, orgB).branch.count()).toBe(1);
  });

  it("tenantTransaction agrupa varias operaciones bajo el mismo tenant", async () => {
    const count = await tenantTransaction(prisma, orgA, async (tx) => {
      await tx.branch.create({ data: { organizationId: orgA, name: "Segunda A", code: "A2" } });
      return tx.branch.count();
    });
    expect(count).toBe(2);
  });

  it("todas las tablas de negocio están aisladas por empresa", async () => {
    const asA = withTenant(prisma, orgA);
    const asB = withTenant(prisma, orgB);
    const branchA = await asA.branch.findFirstOrThrow();

    await asA.category.create({ data: { organizationId: orgA, name: "Cat A" } });
    await asA.product.create({
      data: { organizationId: orgA, name: "Prod A", price: 1000n, barcode: "RLS-1" },
    });
    await asA.customer.create({ data: { organizationId: orgA, name: "Cliente A" } });
    await asA.terminal.create({
      data: { organizationId: orgA, branchId: branchA.id, name: "Caja A", code: "CA1" },
    });

    for (const model of ["category", "product", "customer", "terminal"] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (asA[model] as any).count(), `${model} visible para su dueño`).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(await (asB[model] as any).count(), `${model} oculto para otra empresa`).toBe(0);
    }

    // Insertar en nombre de otra empresa también falla en todas las tablas.
    await expect(
      asB.product.create({ data: { organizationId: orgA, name: "Intruso", price: 1n } }),
    ).rejects.toThrow();
    await expect(
      asB.customer.create({ data: { organizationId: orgA, name: "Intruso" } }),
    ).rejects.toThrow();
  });

  it("la bitácora es inmutable para el rol de la app", async () => {
    const asA = withTenant(prisma, orgA);
    const log = await asA.auditLog.create({
      data: { organizationId: orgA, action: "test", entity: "test" },
    });
    await expect(
      asA.auditLog.update({ where: { id: log.id }, data: { action: "alterado" } }),
    ).rejects.toThrow();
    await expect(asA.auditLog.delete({ where: { id: log.id } })).rejects.toThrow();
  });
});
