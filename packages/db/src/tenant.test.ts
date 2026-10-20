import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrisma, tenantTransaction, withTenant } from "./index";

/**
 * Prueba el aislamiento por empresa DIRECTAMENTE contra Postgres, conectando con el rol de la
 * app (facturacion_app): si RLS falla, estas pruebas lo detectan aunque el código de la API sea correcto.
 * Se omiten si no hay DATABASE_URL.
 */
describe.skipIf(!process.env.DATABASE_URL)("RLS multiempresa", () => {
  const prisma = createPrisma({
    connectionString: process.env.DATABASE_URL ?? "",
    max: 3,
  });
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
      await tx.branch.create({
        data: { organizationId: orgA, name: "Segunda A", code: "A2" },
      });
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
      expect(await (asB[model] as any).count(), `${model} oculto para otra empresa`).toBe(
        0,
      );
    }

    // Insertar en nombre de otra empresa también falla en todas las tablas.
    await expect(
      asB.product.create({ data: { organizationId: orgA, name: "Intruso", price: 1n } }),
    ).rejects.toThrow();
    await expect(
      asB.customer.create({ data: { organizationId: orgA, name: "Intruso" } }),
    ).rejects.toThrow();
  });

  describe("documentos fiscales", () => {
    const draftDoc = async (org: string) => {
      const as = withTenant(prisma, org);
      const branch = await as.branch.findFirstOrThrow();
      return as.document.create({
        data: {
          organizationId: org,
          type: "E32",
          branchId: branch.id,
          createdById: "test-user",
          total: 11800n,
          lines: {
            create: [
              {
                organizationId: org,
                lineNumber: 1,
                name: "Producto",
                quantity: 1000n,
                unitPrice: 11800n,
                priceIncludesTax: true,
                tax: "ITBIS18",
                gross: 11800n,
                discount: 0n,
                base: 10000n,
                taxAmount: 1800n,
                total: 11800n,
              },
            ],
          },
          payments: { create: [{ organizationId: org, method: "CASH", amount: 11800n }] },
        },
      });
    };

    it("aísla documentos, líneas, pagos, secuencias y empresa por tenant", async () => {
      const doc = await draftDoc(orgA);
      const asA = withTenant(prisma, orgA);
      const asB = withTenant(prisma, orgB);
      await asA.sequence.create({
        data: {
          organizationId: orgA,
          ecfType: "E32",
          fromNumber: 1n,
          toNumber: 10n,
          nextNumber: 1n,
          expiresAt: new Date("2099-12-31"),
        },
      });
      await asA.companyProfile.create({
        data: {
          organizationId: orgA,
          rnc: "101001577",
          legalName: "A SRL",
          address: "Calle 1",
        },
      });

      for (const model of [
        "document",
        "documentLine",
        "payment",
        "sequence",
        "companyProfile",
      ] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(
          await (asA[model] as any).count(),
          `${model} visible para su dueño`,
        ).toBeGreaterThan(0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(
          await (asB[model] as any).count(),
          `${model} oculto para otra empresa`,
        ).toBe(0);
      }
      expect(await asB.document.findFirst({ where: { id: doc.id } })).toBeNull();
    });

    it("un borrador se puede editar y eliminar", async () => {
      const doc = await draftDoc(orgA);
      const asA = withTenant(prisma, orgA);
      await asA.document.update({
        where: { id: doc.id },
        data: { notes: "cambio permitido" },
      });
      await asA.payment.deleteMany({ where: { documentId: doc.id } });
      await asA.document.delete({ where: { id: doc.id } });
      expect(await asA.document.findFirst({ where: { id: doc.id } })).toBeNull();
    });

    it("un comprobante emitido queda congelado en la base de datos", async () => {
      const doc = await draftDoc(orgA);
      const asA = withTenant(prisma, orgA);
      const issued = await asA.document.update({
        where: { id: doc.id },
        data: { status: "ISSUED", encf: "E320000000001", issuedAt: new Date() },
      });
      expect(issued.status).toBe("ISSUED");

      // No se puede alterar ningún dato…
      await expect(
        asA.document.update({ where: { id: doc.id }, data: { total: 1n } }),
      ).rejects.toThrow(/no se puede modificar/);
      await expect(
        asA.document.update({ where: { id: doc.id }, data: { notes: "x" } }),
      ).rejects.toThrow();
      // …ni volver a borrador, ni borrarlo.
      await expect(
        asA.document.update({ where: { id: doc.id }, data: { status: "DRAFT" } }),
      ).rejects.toThrow(/volver a borrador/);
      await expect(asA.document.delete({ where: { id: doc.id } })).rejects.toThrow(
        /no se puede eliminar/,
      );
      // Tampoco sus líneas ni sus pagos.
      await expect(
        asA.documentLine.updateMany({
          where: { documentId: doc.id },
          data: { unitPrice: 1n },
        }),
      ).rejects.toThrow(/no se pueden modificar/);
      await expect(
        asA.payment.deleteMany({ where: { documentId: doc.id } }),
      ).rejects.toThrow();
      await expect(
        asA.payment.create({
          data: { organizationId: orgA, documentId: doc.id, method: "CASH", amount: 1n },
        }),
      ).rejects.toThrow();

      // Lo único que puede avanzar es el estado fiscal.
      const sent = await asA.document.update({
        where: { id: doc.id },
        data: { status: "SENT" },
      });
      expect(sent.status).toBe("SENT");
    });

    it("rechaza e-NCF mal formados, de otro tipo o ausentes al emitir", async () => {
      const asA = withTenant(prisma, orgA);
      const bad = async (data: object) => {
        const doc = await draftDoc(orgA);
        return asA.document.update({ where: { id: doc.id }, data });
      };
      await expect(bad({ encf: "B0100000001" })).rejects.toThrow();
      await expect(bad({ encf: "E310000000002" })).rejects.toThrow(); // E31 en un documento E32
      await expect(bad({ status: "ISSUED" })).rejects.toThrow(); // emitido sin e-NCF
    });

    it("no permite repetir un e-NCF dentro de la empresa", async () => {
      const asA = withTenant(prisma, orgA);
      const first = await draftDoc(orgA);
      const second = await draftDoc(orgA);
      await asA.document.update({
        where: { id: first.id },
        data: { status: "ISSUED", encf: "E320000000777" },
      });
      await expect(
        asA.document.update({
          where: { id: second.id },
          data: { status: "ISSUED", encf: "E320000000777" },
        }),
      ).rejects.toThrow();
    });

    it("las secuencias solo avanzan y un rango en uso no se reescribe", async () => {
      const asA = withTenant(prisma, orgA);
      const seq = await asA.sequence.create({
        data: {
          organizationId: orgA,
          ecfType: "E31",
          fromNumber: 100n,
          toNumber: 110n,
          nextNumber: 100n,
          expiresAt: new Date("2099-12-31"),
        },
      });
      await asA.sequence.update({ where: { id: seq.id }, data: { nextNumber: 103n } });
      await expect(
        asA.sequence.update({ where: { id: seq.id }, data: { nextNumber: 101n } }),
      ).rejects.toThrow(/no puede retroceder/);
      await expect(
        asA.sequence.update({ where: { id: seq.id }, data: { fromNumber: 50n } }),
      ).rejects.toThrow();
      await expect(asA.sequence.delete({ where: { id: seq.id } })).rejects.toThrow(
        /ya se usó/,
      );
      // Rangos incoherentes los rechaza la restricción CHECK.
      await expect(
        asA.sequence.create({
          data: {
            organizationId: orgA,
            ecfType: "E34",
            fromNumber: 10n,
            toNumber: 5n,
            nextNumber: 10n,
            expiresAt: new Date("2099-12-31"),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("inventario", () => {
    const setup = async (org: string, code: string) => {
      const as = withTenant(prisma, org);
      const branch = await as.branch.findFirstOrThrow();
      const product = await as.product.create({
        data: {
          organizationId: org,
          name: `Prod ${code}`,
          price: 1000n,
          trackInventory: true,
          minStock: 5000n,
        },
      });
      return { as, branch, product };
    };
    const movement = (
      org: string,
      productId: string,
      branchId: string,
      over: object = {},
    ) => ({
      organizationId: org,
      productId,
      branchId,
      type: "RECEIPT" as const,
      quantity: 10_000n,
      balanceAfter: 10_000n,
      createdById: "test-user",
      ...over,
    });

    it("aísla existencias y movimientos por empresa", async () => {
      const a = await setup(orgA, "A");
      await a.as.stockLevel.create({
        data: {
          organizationId: orgA,
          productId: a.product.id,
          branchId: a.branch.id,
          quantity: 10_000n,
        },
      });
      await a.as.stockMovement.create({
        data: movement(orgA, a.product.id, a.branch.id),
      });

      const asB = withTenant(prisma, orgB);
      expect(await a.as.stockLevel.count()).toBeGreaterThan(0);
      expect(await a.as.stockMovement.count()).toBeGreaterThan(0);
      expect(await asB.stockLevel.count()).toBe(0);
      expect(await asB.stockMovement.count()).toBe(0);
      await expect(
        asB.stockLevel.create({
          data: {
            organizationId: orgA,
            productId: a.product.id,
            branchId: a.branch.id,
            quantity: 1n,
          },
        }),
      ).rejects.toThrow();
    });

    it("un producto tiene una sola fila de existencia por sucursal", async () => {
      const a = await setup(orgA, "U");
      const data = {
        organizationId: orgA,
        productId: a.product.id,
        branchId: a.branch.id,
        quantity: 0n,
      };
      await a.as.stockLevel.create({ data });
      await expect(a.as.stockLevel.create({ data })).rejects.toThrow();
    });

    it("el libro de movimientos no se modifica ni se borra", async () => {
      const a = await setup(orgA, "M");
      const m = await a.as.stockMovement.create({
        data: movement(orgA, a.product.id, a.branch.id),
      });
      await expect(
        a.as.stockMovement.update({ where: { id: m.id }, data: { quantity: 1n } }),
      ).rejects.toThrow(/no se pueden modificar ni eliminar/);
      await expect(a.as.stockMovement.delete({ where: { id: m.id } })).rejects.toThrow();
      await expect(
        a.as.stockMovement.deleteMany({ where: { productId: a.product.id } }),
      ).rejects.toThrow();
    });

    it("el signo del movimiento debe coincidir con su tipo y nunca es cero", async () => {
      const a = await setup(orgA, "S");
      const create = (over: object) =>
        a.as.stockMovement.create({
          data: movement(orgA, a.product.id, a.branch.id, over),
        });

      await expect(create({ type: "SALE", quantity: 1_000n })).rejects.toThrow(); // una venta no suma
      await expect(create({ type: "RECEIPT", quantity: -1_000n })).rejects.toThrow(); // una entrada no resta
      await expect(create({ type: "RETURN", quantity: -1_000n })).rejects.toThrow();
      await expect(create({ type: "ADJUSTMENT", quantity: 0n })).rejects.toThrow();
      await expect(
        create({ type: "SALE", quantity: -2_000n, balanceAfter: 8_000n }),
      ).resolves.toBeTruthy();
      await expect(
        create({ type: "ADJUSTMENT", quantity: -500n, balanceAfter: 7_500n }),
      ).resolves.toBeTruthy();
    });

    it("la existencia mínima no puede ser negativa", async () => {
      const a = await setup(orgA, "N");
      await expect(
        a.as.product.update({ where: { id: a.product.id }, data: { minStock: -1n } }),
      ).rejects.toThrow();
    });
  });

  describe("compras", () => {
    const base = async (org: string) => {
      const as = withTenant(prisma, org);
      const branch = await as.branch.findFirstOrThrow();
      const supplier = await as.supplier.create({
        data: { organizationId: org, name: `Proveedor ${randomUUID().slice(0, 6)}` },
      });
      let n = 0;
      const purchase = (over: object = {}) =>
        as.purchase.create({
          data: {
            organizationId: org,
            kind: "SUPPLIER_INVOICE",
            branchId: branch.id,
            supplierId: supplier.id,
            ncf: `B01${String(Date.now() % 1e7).padStart(7, "0")}${++n}`.slice(0, 11),
            invoiceDate: new Date("2026-10-01"),
            createdById: "test-user",
            total: 11800n,
            subtotal: 10000n,
            totalTax: 1800n,
            ...over,
          },
        });
      const line = (purchaseId: string) => ({
        organizationId: org,
        purchaseId,
        lineNumber: 1,
        name: "Producto",
        quantity: 1000n,
        unitCost: 10000n,
        priceIncludesTax: false,
        tax: "ITBIS18" as const,
        gross: 10000n,
        discount: 0n,
        base: 10000n,
        taxAmount: 1800n,
        total: 11800n,
      });
      return { as, branch, supplier, purchase, line };
    };

    it("aísla proveedores, compras y líneas por empresa", async () => {
      const a = await base(orgA);
      const p = await a.purchase();
      await a.as.purchaseLine.create({ data: a.line(p.id) });
      const asB = withTenant(prisma, orgB);
      for (const model of ["supplier", "purchase", "purchaseLine"] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(
          await (a.as[model] as any).count(),
          `${model} visible para su dueño`,
        ).toBeGreaterThan(0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(
          await (asB[model] as any).count(),
          `${model} oculto para otra empresa`,
        ).toBe(0);
      }
      await expect(
        asB.supplier.create({ data: { organizationId: orgA, name: "Intruso" } }),
      ).rejects.toThrow();
    });

    it("un borrador se edita y se elimina; una compra registrada queda congelada", async () => {
      const a = await base(orgA);
      const draft = await a.purchase();
      await a.as.purchaseLine.create({ data: a.line(draft.id) });
      await a.as.purchase.update({
        where: { id: draft.id },
        data: { notes: "cambio permitido" },
      });

      const posted = await a.as.purchase.update({
        where: { id: draft.id },
        data: { status: "POSTED", postedAt: new Date() },
      });
      expect(posted.status).toBe("POSTED");

      await expect(
        a.as.purchase.update({ where: { id: draft.id }, data: { total: 1n } }),
      ).rejects.toThrow(/no se puede modificar/);
      await expect(
        a.as.purchase.update({ where: { id: draft.id }, data: { status: "DRAFT" } }),
      ).rejects.toThrow();
      await expect(a.as.purchase.delete({ where: { id: draft.id } })).rejects.toThrow(
        /no se puede eliminar/,
      );
      await expect(
        a.as.purchaseLine.updateMany({
          where: { purchaseId: draft.id },
          data: { unitCost: 1n },
        }),
      ).rejects.toThrow(/no se pueden modificar/);
      await expect(
        a.as.purchaseLine.deleteMany({ where: { purchaseId: draft.id } }),
      ).rejects.toThrow();
      await expect(
        a.as.purchaseLine.create({ data: { ...a.line(draft.id), lineNumber: 2 } }),
      ).rejects.toThrow();

      const other = await a.purchase();
      await a.as.purchaseLine.create({ data: a.line(other.id) });
      await a.as.purchaseLine.deleteMany({ where: { purchaseId: other.id } });
      await a.as.purchase.delete({ where: { id: other.id } });
    });

    it("el NCF debe tener el formato de su tipo y toda compra registrada lleva NCF", async () => {
      const a = await base(orgA);
      await expect(a.purchase({ ncf: "X0100000001" })).rejects.toThrow(); // formato de proveedor inválido
      await expect(a.purchase({ kind: "E41", ncf: "B0100000001" })).rejects.toThrow(); // E41 exige e-NCF E41…
      await expect(a.purchase({ kind: "E43", ncf: "E410000000001" })).rejects.toThrow(); // y E43 el E43…
      await expect(
        a.purchase({ kind: "E43", ncf: "E430000000001", supplierId: null }),
      ).resolves.toBeTruthy();
      await expect(a.purchase({ ncf: "E310000000045" })).resolves.toBeTruthy(); // e-CF de un proveedor formal

      const noNcf = await a.purchase({ ncf: null });
      await expect(
        a.as.purchase.update({
          where: { id: noNcf.id },
          data: { status: "POSTED", postedAt: new Date() },
        }),
      ).rejects.toThrow();
      const noDate = await a.purchase();
      await expect(
        a.as.purchase.update({ where: { id: noDate.id }, data: { status: "POSTED" } }),
      ).rejects.toThrow();
    });

    it("no repite el NCF de un proveedor ni el e-NCF propio de la empresa", async () => {
      const a = await base(orgA);
      await a.purchase({ ncf: "B0100000777" });
      await expect(a.purchase({ ncf: "B0100000777" })).rejects.toThrow(); // mismo proveedor
      const other = await a.as.supplier.create({
        data: { organizationId: orgA, name: "Otro proveedor" },
      });
      await expect(
        a.purchase({ ncf: "B0100000777", supplierId: other.id }),
      ).resolves.toBeTruthy(); // otro proveedor

      await a.purchase({ kind: "E41", ncf: "E410000000777", supplierId: other.id });
      await expect(
        a.purchase({ kind: "E41", ncf: "E410000000777", supplierId: null }),
      ).rejects.toThrow(); // e-NCF propio único
      await expect(
        a.purchase({ kind: "E43", ncf: "E430000000777", supplierId: null }),
      ).resolves.toBeTruthy();
    });

    it("rechaza retenciones y tipos de gasto fuera de rango", async () => {
      const a = await base(orgA);
      const n = () =>
        `B01${Math.floor(Math.random() * 1e8)
          .toString()
          .padStart(8, "0")}`; // B + 10 dígitos
      await expect(a.purchase({ ncf: n(), itbisWithheld: 1801n })).rejects.toThrow(); // más que el ITBIS (1800)
      await expect(a.purchase({ ncf: n(), isrWithheld: 10001n })).rejects.toThrow(); // más que la base
      await expect(a.purchase({ ncf: n(), itbisWithheld: -1n })).rejects.toThrow();
      await expect(a.purchase({ ncf: n(), expenseType: 0 })).rejects.toThrow();
      await expect(a.purchase({ ncf: n(), expenseType: 12 })).rejects.toThrow();
      await expect(
        a.purchase({
          ncf: n(),
          itbisWithheld: 1800n,
          isrWithheld: 10000n,
          expenseType: 11,
        }),
      ).resolves.toBeTruthy();
    });

    it("E41 y E43 solo numeran compras: un documento de venta no puede ser de esos tipos", async () => {
      const a = await base(orgA);
      await expect(
        a.as.document.create({
          data: {
            organizationId: orgA,
            type: "E41",
            branchId: a.branch.id,
            createdById: "test-user",
          },
        }),
      ).rejects.toThrow();
      // …pero sí pueden tener secuencia propia.
      await expect(
        a.as.sequence.create({
          data: {
            organizationId: orgA,
            ecfType: "E41",
            fromNumber: 1n,
            toNumber: 10n,
            nextNumber: 1n,
            expiresAt: new Date("2099-12-31"),
          },
        }),
      ).resolves.toBeTruthy();
    });

    it("una entrada al inventario puede enlazar su compra de origen", async () => {
      const a = await base(orgA);
      const p = await a.purchase();
      const product = await a.as.product.create({
        data: {
          organizationId: orgA,
          name: `Prod ${p.id.slice(0, 6)}`,
          price: 1n,
          trackInventory: true,
        },
      });
      const m = await a.as.stockMovement.create({
        data: {
          organizationId: orgA,
          productId: product.id,
          branchId: a.branch.id,
          type: "RECEIPT",
          quantity: 5_000n,
          balanceAfter: 5_000n,
          unitCost: 5_000n,
          purchaseId: p.id,
          createdById: "test-user",
        },
      });
      expect(m.purchaseId).toBe(p.id);
    });
  });

  describe("restaurante", () => {
    let seq = 0;
    const setup = async (org: string) => {
      const as = withTenant(prisma, org);
      const branch = await as.branch.findFirstOrThrow();
      const table = await as.diningTable.create({
        data: { organizationId: org, branchId: branch.id, name: `Mesa ${randomUUID().slice(0, 6)}` },
      });
      const order = (over: object = {}, tableId = table.id) =>
        as.restaurantOrder.create({
          data: {
            organizationId: org,
            branchId: branch.id,
            tableId,
            number: 1_000_000 + Math.floor(Math.random() * 1_000_000_000) + ++seq,
            openedById: "test-user",
            ...over,
          },
        });
      const item = (orderId: string, over: object = {}) =>
        as.orderItem.create({
          data: {
            organizationId: org,
            orderId,
            name: "Pollo",
            quantity: 2_000n,
            unitPrice: 35_000n,
            priceIncludesTax: true,
            tax: "ITBIS18",
            createdById: "test-user",
            ...over,
          },
        });
      return { as, branch, table, order, item };
    };

    it("mesas, comandas y productos anotados están aislados por empresa", async () => {
      const a = await setup(orgA);
      const b = await setup(orgB);
      const o = await a.order();
      await a.item(o.id);

      for (const model of ["diningTable", "restaurantOrder", "orderItem"] as const) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await (a.as[model] as any).count(), `${model} visible para su dueño`).toBeGreaterThan(0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(await (b.as[model] as any).count({ where: { organizationId: orgA } }), `${model} oculto`).toBe(0);
      }
      await expect(
        b.as.restaurantOrder.create({
          data: { organizationId: orgA, branchId: b.branch.id, tableId: b.table.id, number: 1, openedById: "x" },
        }),
      ).rejects.toThrow();
    });

    it("una mesa solo puede tener una comanda abierta", async () => {
      const { table, order, as } = await setup(orgA);
      const first = await order();
      await expect(order()).rejects.toThrow(/restaurant_order_one_open_per_table|unique/i);
      // Al cerrar la primera, la mesa vuelve a estar disponible.
      await as.restaurantOrder.update({ where: { id: first.id }, data: { status: "CLOSED", closedAt: new Date() } });
      const second = await order();
      expect(second.tableId).toBe(table.id);
    });

    it("valida los datos de mesas y comandas", async () => {
      const { as, branch, order } = await setup(orgA);
      await expect(
        as.diningTable.create({ data: { organizationId: orgA, branchId: branch.id, name: "Mesa 0", seats: 0 } }),
      ).rejects.toThrow();
      const t = await as.diningTable.create({ data: { organizationId: orgA, branchId: branch.id, name: `Dup ${randomUUID().slice(0, 6)}` } });
      await expect(
        as.diningTable.create({ data: { organizationId: orgA, branchId: branch.id, name: t.name } }),
      ).rejects.toThrow();
      await expect(order({ covers: 0 }, t.id)).rejects.toThrow();
      await expect(order({ number: 0 }, t.id)).rejects.toThrow();
      // Cerrada sin fecha de cierre / abierta con fecha / cancelada sin motivo.
      await expect(order({ status: "CLOSED" }, t.id)).rejects.toThrow();
      await expect(order({ closedAt: new Date() }, t.id)).rejects.toThrow();
      await expect(order({ status: "CANCELLED", closedAt: new Date() }, t.id)).rejects.toThrow();
    });

    it("una comanda cerrada o cancelada queda congelada y no se borra", async () => {
      const { as, order, item } = await setup(orgA);
      const o = await order();
      const i = await item(o.id);

      await expect(as.restaurantOrder.delete({ where: { id: o.id } })).rejects.toThrow();
      await as.restaurantOrder.update({ where: { id: o.id }, data: { status: "CLOSED", closedAt: new Date() } });

      await expect(as.restaurantOrder.update({ where: { id: o.id }, data: { notes: "tarde" } })).rejects.toThrow();
      await expect(as.restaurantOrder.delete({ where: { id: o.id } })).rejects.toThrow();
      await expect(item(o.id)).rejects.toThrow();
      await expect(as.orderItem.update({ where: { id: i.id }, data: { quantity: 9_000n } })).rejects.toThrow();
      await expect(as.orderItem.delete({ where: { id: i.id } })).rejects.toThrow();
    });

    it("reglas de los productos anotados", async () => {
      const { as, order, item } = await setup(orgA);
      const o = await order();

      await expect(item(o.id, { quantity: 0n })).rejects.toThrow();
      await expect(item(o.id, { unitPrice: -1n })).rejects.toThrow();
      await expect(item(o.id, { billedQuantity: 3_000n })).rejects.toThrow(); // más de lo anotado
      await expect(item(o.id, { status: "VOID" })).rejects.toThrow(); // anular exige motivo

      // Anulado con motivo: no se reactiva.
      const voided = await item(o.id, { status: "VOID", voidReason: "Error" });
      await expect(as.orderItem.update({ where: { id: voided.id }, data: { status: "PENDING" } })).rejects.toThrow();

      // Lo ya cobrado no se puede quitar, pero lo no cobrado sí.
      const billed = await item(o.id, { billedQuantity: 1_000n });
      await expect(as.orderItem.delete({ where: { id: billed.id } })).rejects.toThrow();
      const free = await item(o.id);
      await as.orderItem.delete({ where: { id: free.id } });
      expect(await as.orderItem.findUnique({ where: { id: free.id } })).toBeNull();
    });
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
