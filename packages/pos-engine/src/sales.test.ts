import { describe, expect, it } from "vitest";
import { createSale, getSale, listSales, receiptOfSale, SaleError } from "./sales";
import { applyCatalog, productByBarcode, searchCustomers, searchProducts } from "./catalog";
import { one, run } from "./store";
import { customer, makeDb, product, TERMINAL } from "./helpers.test-util";

const ctx = (extra: object = {}) => ({ terminalId: TERMINAL, now: new Date("2026-10-21T15:00:00Z"), ...extra });

describe("catálogo local", () => {
  it("es idempotente, conserva lo desactivado fuera de la búsqueda y busca por nombre, SKU y código de barras", () => {
    const a = product({ name: "Agua mineral", sku: "AG-1", barcode: "7461" });
    const b = product({ name: "Cerveza 100%", barcode: "9999" });
    const db = makeDb({ products: [a, b] });
    applyCatalog(db, { products: [a, b], customers: [], categories: [], company: null }); // otra vez: nada cambia
    expect(searchProducts(db, "").map((p) => p.name)).toEqual(["Agua mineral", "Cerveza 100%"]);
    expect(searchProducts(db, "agua").map((p) => p.name)).toEqual(["Agua mineral"]);
    expect(searchProducts(db, "AG-1")).toHaveLength(1);
    expect(productByBarcode(db, "7461")?.name).toBe("Agua mineral");
    expect(productByBarcode(db, "0000")).toBeNull();
    expect(searchProducts(db, "100%").map((p) => p.name)).toEqual(["Cerveza 100%"]); // % se busca literal
    expect(searchProducts(db, "%")).toHaveLength(1);

    applyCatalog(db, { products: [{ ...a, active: false, price: "10.00" }], customers: [], categories: [], company: null });
    expect(searchProducts(db, "agua")).toEqual([]);
    expect(productByBarcode(db, "7461")).toBeNull();
  });

  it("busca clientes por nombre o documento", () => {
    const db = makeDb({ customers: [customer({ name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" }), customer({ name: "Otro", active: false })] });
    expect(searchCustomers(db, "acme")).toHaveLength(1);
    expect(searchCustomers(db, "1312")).toHaveLength(1);
    expect(searchCustomers(db, "otro")).toEqual([]);
    expect(searchCustomers(db, "")).toEqual([]);
  });
});

describe("venta en la caja", () => {
  it("calcula con el motor fiscal, toma el e-NCF del bloque y deja la venta pendiente de subir", () => {
    const p = product();
    const db = makeDb({ products: [p] });
    const receipt = createSale(db, ctx({ newId: () => "00000000-0000-4000-8000-000000000001" }), {
      type: "E32",
      lines: [{ productId: p.id, quantity: "2" }],
      payments: [{ method: "CASH", amount: "236.00" }],
    });
    expect(receipt.sale).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", encf: "E320000000001", status: "PENDING", total: "236.00", type: "E32" });
    expect(receipt.totals).toEqual({ subtotal: "200.00", tax: "36.00", propina: "0.00", total: "236.00" });
    expect(receipt.lines).toEqual([{ name: "Producto 118", quantity: "2", unitPrice: "118.00", total: "236.00" }]);
    expect(receipt.company?.legalName).toBe("Empresa SRL");

    const payload = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sale")!.payload);
    expect(payload).toMatchObject({
      clientId: "00000000-0000-4000-8000-000000000001",
      terminalId: TERMINAL,
      encf: "E320000000001",
      issuedAt: "2026-10-21T15:00:00.000Z",
      total: "236.00",
      lines: [{ productId: p.id, quantity: "2", unitPrice: "118.00", tax: "ITBIS18", priceIncludesTax: true }],
    });
    expect(one<{ next_number: number }>(db, "SELECT next_number FROM seq_block")!.next_number).toBe(2);
  });

  it("numera de forma consecutiva, usa primero el bloque que vence antes y se detiene al agotarse", () => {
    const p = product();
    const db = makeDb({ products: [p], block: { from: 1, to: 2, expires: "2099-12-31" } });
    run(db, "INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES ('b2', 'E32', 500, 500, 500, '2027-01-01')");
    const sell = () =>
      createSale(db, ctx(), { type: "E32", lines: [{ productId: p.id, quantity: "1" }], payments: [{ method: "CARD", amount: "118.00" }] }).sale.encf;
    expect([sell(), sell(), sell()]).toEqual(["E320000000500", "E320000000001", "E320000000002"]);
    expect(() => sell()).toThrow(/No quedan números de E32/);
    expect(listSales(db)).toHaveLength(3);
  });

  it("ignora bloques vencidos y de otro tipo", () => {
    const p = product();
    const db = makeDb({ products: [p], block: { type: "E32", from: 1, to: 10, expires: "2026-10-20" } }); // venció ayer
    run(db, "INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES ('b3', 'E31', 1, 10, 1, '2099-12-31')");
    expect(() =>
      createSale(db, ctx(), { type: "E32", lines: [{ productId: p.id, quantity: "1" }], payments: [{ method: "CASH", amount: "118.00" }] }),
    ).toThrow(SaleError);
  });

  it("si algo falla no se gasta ningún número", () => {
    const p = product();
    const db = makeDb({ products: [p] });
    const bad = (over: object) => () =>
      createSale(db, ctx(), { type: "E32", lines: [{ productId: p.id, quantity: "1" }], payments: [{ method: "CASH", amount: "118.00" }], ...over });
    expect(bad({ payments: [{ method: "CASH", amount: "100.00" }] })).toThrow(/deben sumar/);
    expect(bad({ payments: [{ method: "CASH", amount: "0" }] })).toThrow(/mayores que cero/);
    expect(bad({ lines: [] })).toThrow(/al menos un producto/);
    expect(bad({ lines: [{ productId: p.id, quantity: "0" }] })).toThrow(/mayor que cero/);
    expect(bad({ lines: [{ productId: p.id, quantity: "1.5" }] })).toThrow(/fracciones/);
    expect(bad({ lines: [{ productId: p.id, quantity: "x" }] })).toThrow(/inválida/);
    expect(bad({ lines: [{ productId: "no-existe", quantity: "1" }] })).toThrow(/ya no está disponible/);
    expect(bad({ customerId: "no-existe" })).toThrow(/cliente/);
    expect(bad({ type: "E31" })).toThrow(/RNC/);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sale")!.n).toBe(0);
    expect(one<{ next_number: number }>(db, "SELECT next_number FROM seq_block")!.next_number).toBe(1);
    expect(bad({})().sale.encf).toBe("E320000000001"); // el primero sigue disponible
  });

  it("factura de crédito fiscal con un cliente con RNC, propina legal y pagos mixtos", () => {
    const p = product();
    const acme = customer({ name: "Acme SRL", documentType: "RNC", documentNumber: "131246796" });
    const db = makeDb({ products: [p], customers: [acme], block: { type: "E31", from: 1, to: 5 } });
    const receipt = createSale(db, ctx(), {
      type: "E31",
      customerId: acme.id,
      propinaLegal: true,
      lines: [{ productId: p.id, quantity: "2" }],
      payments: [{ method: "CASH", amount: "100.00" }, { method: "CARD", amount: "156.00" }],
    });
    expect(receipt).toMatchObject({ buyerName: "Acme SRL", buyerDoc: "131246796", totals: { propina: "20.00", total: "256.00" } });
    expect(receipt.sale.encf).toBe("E310000000001");
    const payload = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sale")!.payload);
    expect(payload).toMatchObject({ customerId: acme.id, propinaLegal: true, total: "256.00" });
    expect(payload.payments).toEqual([{ method: "CASH", amount: "100.00" }, { method: "CARD", amount: "156.00" }]);
  });

  it("vende por peso, el comprobante se puede reimprimir igual y el precio queda congelado", () => {
    const kg = product({ name: "Queso", price: "250.00", allowsDecimals: true, unit: "LB" });
    const db = makeDb({ products: [kg] });
    const first = createSale(db, ctx(), { type: "E32", lines: [{ productId: kg.id, quantity: "1.5" }], payments: [{ method: "CASH", amount: "375.00" }] });
    expect(first.totals.total).toBe("375.00");
    // El catálogo cambia después: lo ya vendido conserva su precio.
    applyCatalog(db, { products: [{ ...kg, price: "999.00" }], customers: [], categories: [], company: null });
    const again = receiptOfSale(db, first.sale.id)!;
    expect(again.totals).toEqual(first.totals);
    expect(again.lines).toEqual(first.lines);
    expect(getSale(db, first.sale.id)?.encf).toBe("E320000000001");
    expect(receiptOfSale(db, "nada")).toBeNull();
  });
});
