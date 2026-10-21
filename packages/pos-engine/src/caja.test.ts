import { describe, expect, it } from "vitest";
import { hashPin } from "@facturacion/core";
import { ApiClient } from "./api";
import { applyCashiers, cashiers, PinGate } from "./cashiers";
import { createRefund, returnableLines } from "./refunds";
import { createSale, getSale, SaleError, type SaleCtx, type SaleInput } from "./sales";
import { closeShift, currentShift, openShift, reportOfShift } from "./shifts";
import { one, run, type Db } from "./store";
import { runSync } from "./sync";
import { fakeCloud, makeDb, product, TERMINAL } from "./helpers.test-util";

const T0 = new Date("2026-10-21T13:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function addBlock(db: Db, type: string, from: number, to: number) {
  run(db, "INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES (?, ?, ?, ?, ?, '2099-12-31')", crypto.randomUUID(), type, from, to, from);
}

/** Caja lista: un producto de RD$118.00, bloques E32 y E34. */
function setup() {
  const p = product();
  const q = product({ name: "Producto 50", price: "50.00", tax: "EXENTO", priceIncludesTax: false });
  const db = makeDb({ products: [p, q], block: { type: "E32", from: 1, to: 100 } });
  addBlock(db, "E34", 1, 50);
  let n = 0;
  const ctx = (minutes = 0, extra: Partial<SaleCtx> = {}): SaleCtx => ({
    terminalId: TERMINAL,
    now: at(minutes),
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    cashierId: "u-ana",
    cashierName: "Ana",
    ...extra,
  });
  const sell = (c: SaleCtx, lines: SaleInput["lines"], method: "CASH" | "CARD" = "CASH", total?: string, over: Partial<SaleInput> = {}) =>
    createSale(db, c, {
      type: "E32",
      lines,
      payments: [{ method, amount: total ?? "118.00" }],
      ...over,
    });
  return { db, p, q, ctx, sell };
}

describe("PIN de cajero en la caja", () => {
  async function withCashiers() {
    const db = makeDb();
    applyCashiers(db, [
      { userId: "u-ana", name: "Ana", email: "ana@x.com", role: "member", pin: await hashPin("2580", { iterations: 1000 }) },
      { userId: "u-luis", name: "Luis", email: "luis@x.com", role: "admin", pin: await hashPin("4096", { iterations: 1000 }) },
    ]);
    return db;
  }

  it("identifica con el PIN guardado (sin internet), nunca guarda el PIN y reemplaza la lista al sincronizar", async () => {
    const db = await withCashiers();
    expect(cashiers(db).map((c) => c.name)).toEqual(["Ana", "Luis"]);
    expect(JSON.stringify(one(db, "SELECT group_concat(pin_hash) AS h FROM cashier"))).not.toMatch(/2580|4096/);
    const gate = new PinGate(db);
    expect(await gate.verify("u-ana", "2580")).toEqual({ userId: "u-ana", name: "Ana", role: "member" });
    await expect(gate.verify("u-ana", "4096")).rejects.toThrow("PIN incorrecto");
    await expect(gate.verify("u-nadie", "2580")).rejects.toThrow(/no tiene PIN/);
    applyCashiers(db, [{ userId: "u-luis", name: "Luis", email: "luis@x.com", role: "admin", pin: (one<{ pin_hash: string }>(db, "SELECT pin_hash FROM cashier WHERE user_id = 'u-luis'"))!.pin_hash }]);
    expect(cashiers(db).map((c) => c.name)).toEqual(["Luis"]);
  });

  it("tras 5 fallos seguidos bloquea 30 segundos a esa persona y un acierto reinicia la cuenta", async () => {
    const db = await withCashiers();
    const gate = new PinGate(db);
    const now = 1_000_000;
    for (let i = 1; i <= 4; i++) await expect(gate.verify("u-ana", "0000", now)).rejects.toThrow("PIN incorrecto");
    expect(await gate.verify("u-ana", "2580", now)).toBeTruthy(); // acierta a la cuarta: se reinicia
    for (let i = 1; i <= 4; i++) await expect(gate.verify("u-ana", "0000", now)).rejects.toThrow(/^PIN incorrecto$/);
    await expect(gate.verify("u-ana", "0000", now)).rejects.toThrow(/Espera 30 s/); // quinto fallo
    await expect(gate.verify("u-ana", "2580", now + 10_000)).rejects.toThrow(/espera 20 s/); // ni el PIN correcto entra
    expect(await gate.verify("u-luis", "4096", now + 10_000)).toBeTruthy(); // otra persona no se ve afectada
    expect(await gate.verify("u-ana", "2580", now + 31_000)).toBeTruthy(); // pasado el bloqueo
  });
});

describe("turnos en la caja", () => {
  it("abre con el fondo, no admite dos abiertos y valida el monto", () => {
    const { db, ctx } = setup();
    expect(() => openShift(db, ctx(), "-5")).toThrow(/negativo/);
    expect(() => openShift(db, ctx(), "abc")).toThrow(/inválido/);
    const shift = openShift(db, ctx(0), "1000");
    expect(shift).toMatchObject({ openingAmount: "1000.00", closedAt: null, openedBy: { id: "u-ana" }, synced: false });
    expect(currentShift(db)?.id).toBe(shift.id);
    expect(() => openShift(db, ctx(1), "0")).toThrow(/ya tiene un turno abierto/);
  });

  it("las ventas quedan en el turno y el informe suma cobros, resta devoluciones y calcula el efectivo", () => {
    const { db, p, ctx, sell } = setup();
    const shift = openShift(db, ctx(0), "1000");
    const c = (m: number) => ctx(m, { shiftId: shift.id });
    const s1 = sell(c(5), [{ productId: p.id, quantity: "2" }], "CASH", "236.00");
    sell(c(6), [{ productId: p.id, quantity: "1" }], "CARD", "118.00");
    createRefund(db, c(10), { saleId: s1.sale.id, items: [{ index: 0, quantity: "1" }], method: "CASH" });

    const row = one<{ shift_id: string; cashier_id: string }>(db, "SELECT shift_id, cashier_id FROM sale WHERE id = ?", s1.sale.id)!;
    expect(row).toEqual({ shift_id: shift.id, cashier_id: "u-ana" });
    const { report } = reportOfShift(db, shift.id)!;
    expect(report).toMatchObject({
      documents: 3,
      sales: { subtotal: "300.00", tax: "54.00", total: "354.00" },
      credits: "118.00",
      net: "236.00",
      payments: { CARD: "118.00", CASH: "118.00" }, // 236 − 118 devuelto en efectivo
      cashReceived: "118.00",
      expectedCash: "1118.00",
    });
    expect(report.byType.E34).toEqual({ count: 1, total: "118.00" });
  });

  it("al cerrar exige el motivo si el efectivo no coincide, congela el informe Z y permite abrir otro turno", () => {
    const { db, p, ctx, sell } = setup();
    const shift = openShift(db, ctx(0), "500");
    sell(ctx(1, { shiftId: shift.id }), [{ productId: p.id, quantity: "1" }]); // esperado 618.00

    expect(() => closeShift(db, ctx(30), { countedCash: "600.00" })).toThrow(/indica el motivo/);
    expect(() => closeShift(db, ctx(30), { countedCash: "x" })).toThrow(/inválido/);
    expect(currentShift(db)).not.toBeNull(); // no se cerró

    const { shift: closed, report } = closeShift(db, ctx(30, { cashierId: "u-luis" }), { countedCash: "600.00", notes: "Faltaron 18" });
    expect(closed).toMatchObject({ countedCash: "600.00", expectedCash: "618.00", difference: "-18.00", notes: "Faltaron 18", synced: false });
    expect(report).toMatchObject({ expectedCash: "618.00", countedCash: "600.00", difference: "-18.00" });
    expect(reportOfShift(db, shift.id)!.report).toMatchObject({ difference: "-18.00" }); // el informe Z se puede volver a ver
    expect(currentShift(db)).toBeNull();
    expect(() => closeShift(db, ctx(31), { countedCash: "0" })).toThrow(/No hay un turno abierto/);

    const next = openShift(db, ctx(60), "200");
    expect(next.id).not.toBe(shift.id);
    expect(reportOfShift(db, next.id)!.report).toMatchObject({ documents: 0, expectedCash: "200.00" });

    // Contar justo lo esperado no pide motivo.
    expect(closeShift(db, ctx(90), { countedCash: "200" }).shift.difference).toBe("0.00");
  });

  it("las ventas rechazadas por la nube no cuentan en el informe", () => {
    const { db, p, ctx, sell } = setup();
    const shift = openShift(db, ctx(0), "0");
    const a = sell(ctx(1, { shiftId: shift.id }), [{ productId: p.id, quantity: "1" }]);
    sell(ctx(2, { shiftId: shift.id }), [{ productId: p.id, quantity: "1" }]);
    run(db, "UPDATE sale SET status = 'REJECTED' WHERE id = ?", a.sale.id);
    expect(reportOfShift(db, shift.id)!.report).toMatchObject({ documents: 1, expectedCash: "118.00" });
  });
});

describe("devoluciones desde la caja", () => {
  it("anular la venta completa usa el código 1 con el mismo total, y no se puede repetir", () => {
    const { db, p, ctx, sell } = setup();
    const s = sell(ctx(1), [{ productId: p.id, quantity: "2" }], "CASH", "236.00");
    const refund = createRefund(db, ctx(5), { saleId: s.sale.id, method: "CASH" });
    expect(refund.sale).toMatchObject({ type: "E34", encf: "E340000000001", refundOf: s.sale.encf, total: "236.00" });
    const payload = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", refund.sale.id)!.payload);
    expect(payload).toMatchObject({ referencedEncf: s.sale.encf, modificationCode: 1, returnsStock: false, payments: [{ method: "CASH", amount: "236.00" }] });
    expect(refund.payments).toEqual([{ method: "CASH", amount: "236.00" }]);
    expect(() => createRefund(db, ctx(6), { saleId: s.sale.id, method: "CASH" })).toThrow(/ya se devolvió completa/);
  });

  it("una devolución parcial usa el código 3 con la mercancía, y lo devuelto descuenta lo que queda por devolver", () => {
    const { db, p, q, ctx, sell } = setup();
    const s = sell(ctx(1), [{ productId: p.id, quantity: "3" }, { productId: q.id, quantity: "2" }], "CASH", "454.00"); // 354 + 100
    expect(returnableLines(db, s.sale.id).lines.map((l) => `${l.name}:${l.remaining}`)).toEqual(["Producto 118:3", "Producto 50:2"]);

    const r1 = createRefund(db, ctx(5), { saleId: s.sale.id, items: [{ index: 0, quantity: "1" }], method: "CARD" });
    expect(r1.totals.total).toBe("118.00");
    const p1 = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", r1.sale.id)!.payload);
    expect(p1).toMatchObject({ modificationCode: 3, returnsStock: true });
    expect(returnableLines(db, s.sale.id)).toMatchObject({ hasCredit: true });
    expect(returnableLines(db, s.sale.id).lines.map((l) => `${l.returned}/${l.remaining}`)).toEqual(["1/2", "0/2"]);

    expect(() => createRefund(db, ctx(6), { saleId: s.sale.id, items: [{ index: 0, quantity: "3" }], method: "CASH" })).toThrow(/solo se pueden devolver 2/);
    expect(() => createRefund(db, ctx(6), { saleId: s.sale.id, items: [{ index: 9, quantity: "1" }], method: "CASH" })).toThrow(/no es válida/);
    expect(() => createRefund(db, ctx(6), { saleId: s.sale.id, items: [{ index: 0, quantity: "0" }], method: "CASH" })).toThrow(/mayor que cero/);
    expect(() => createRefund(db, ctx(6), { saleId: s.sale.id, items: [{ index: 0, quantity: "1" }, { index: 0, quantity: "1" }], method: "CASH" })).toThrow(/no es válida/);

    // Sin `items` devuelve todo lo que falta; como ya hubo una nota, no es una anulación (código 3).
    const rest = createRefund(db, ctx(7), { saleId: s.sale.id, method: "CASH", returnsStock: false });
    expect(rest.totals.total).toBe("336.00"); // 2 × 118 + 2 × 50
    const p2 = JSON.parse(one<{ payload: string }>(db, "SELECT payload FROM sale WHERE id = ?", rest.sale.id)!.payload);
    expect(p2).toMatchObject({ modificationCode: 3, returnsStock: false });
    expect(() => createRefund(db, ctx(8), { saleId: s.sale.id, method: "CASH" })).toThrow(/ya se devolvió completa/);
  });

  it("devuelve al precio y con la propina de la venta original, aunque hoy cambie el catálogo", () => {
    const { db, p, ctx, sell } = setup();
    const s = sell(ctx(1), [{ productId: p.id, quantity: "2" }], "CASH", "256.00", { propinaLegal: true });
    run(db, "UPDATE product SET price_cents = 99900 WHERE id = ?", p.id);
    const r = createRefund(db, ctx(5), { saleId: s.sale.id, items: [{ index: 0, quantity: "1" }], method: "CASH" });
    expect(r.totals).toEqual({ subtotal: "100.00", tax: "18.00", propina: "10.00", total: "128.00" }); // la mitad de 256.00
    // Anular todo da exactamente el total original (con propina).
    const full = sell(ctx(6), [{ productId: p.id, quantity: "1" }], "CASH", "1083.66", { propinaLegal: true }); // precio nuevo: 999 + 10 % del subtotal (846.61)
    expect(createRefund(db, ctx(7), { saleId: full.sale.id, method: "CASH" }).totals.total).toBe("1083.66");
  });

  it("no devuelve ventas rechazadas ni notas de crédito, y las notas rechazadas no cuentan", () => {
    const { db, p, ctx, sell } = setup();
    const s = sell(ctx(1), [{ productId: p.id, quantity: "1" }]);
    const r = createRefund(db, ctx(2), { saleId: s.sale.id, method: "CASH" });
    expect(() => createRefund(db, ctx(3), { saleId: r.sale.id, method: "CASH" })).toThrow(/Esa venta no se puede devolver|no se puede devolver/);
    // La nube rechazó la nota: la venta vuelve a poder devolverse.
    run(db, "UPDATE sale SET status = 'REJECTED' WHERE id = ?", r.sale.id);
    expect(returnableLines(db, s.sale.id).lines[0]!.remaining).toBe("1");
    expect(createRefund(db, ctx(4), { saleId: s.sale.id, method: "CASH" }).sale.type).toBe("E34");
    run(db, "UPDATE sale SET status = 'REJECTED' WHERE id = ?", s.sale.id);
    expect(() => createRefund(db, ctx(5), { saleId: s.sale.id, method: "CASH" })).toThrow(/rechazada/);
    expect(() => createRefund(db, ctx(5), { saleId: "no-existe", method: "CASH" })).toThrow(/No se encontró/);
  });

  it("sin números de nota de crédito no se gasta nada y se explica por qué", () => {
    const db = makeDb({ products: [product()], block: { type: "E32", from: 1, to: 10 } }); // sin bloque E34
    const p = one<{ id: string }>(db, "SELECT id FROM product")!;
    const s = createSale(db, { terminalId: TERMINAL, now: T0 }, { type: "E32", lines: [{ productId: p.id, quantity: "1" }], payments: [{ method: "CASH", amount: "118.00" }] });
    expect(() => createRefund(db, { terminalId: TERMINAL, now: T0 }, { saleId: s.sale.id, method: "CASH" })).toThrow(SaleError);
    expect(() => createRefund(db, { terminalId: TERMINAL, now: T0 }, { saleId: s.sale.id, method: "CASH" })).toThrow(/E34/);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sale")!.n).toBe(1);
    expect(getSale(db, s.sale.id)?.status).toBe("PENDING");
  });
});

describe("sincronización de turnos y devoluciones", () => {
  const ok = (id: string, encf: string) => Response.json({ data: { id, encf, duplicate: false } }, { status: 201 });
  const catalog = () => Response.json({ data: { products: [], customers: [], categories: [], company: null }, cursor: "c", hasMore: false, serverTime: T0.toISOString() });

  it("sube cada turno en orden (apertura, ventas y notas, cierre) y baja la lista de cajeros", async () => {
    const { db, p, ctx, sell } = setup();
    const shift = openShift(db, ctx(0), "1000");
    const c = (m: number) => ctx(m, { shiftId: shift.id });
    const s = sell(c(1), [{ productId: p.id, quantity: "1" }]);
    createRefund(db, c(2), { saleId: s.sale.id, method: "CASH" });
    closeShift(db, c(20), { countedCash: "1000.00" });
    sell(ctx(30), [{ productId: p.id, quantity: "1" }]); // venta sin turno

    const order: string[] = [];
    const { fetch } = fakeCloud({
      [`PUT /v1/sync/shifts/${shift.id}`]: ({ body }) => {
        order.push((body as { close?: unknown }).close ? "shift:close" : "shift:open");
        return Response.json({ data: { id: "r-shift", clientId: shift.id, status: "OPEN", expectedCash: null, difference: null } });
      },
      "POST /v1/sync/sales": ({ body }) => {
        const b = body as { type: string; encf: string; shiftClientId: string | null; referencedEncf?: string; cashierId: string };
        order.push(`${b.type}:${b.shiftClientId ? "turno" : "sin-turno"}`);
        if (b.type === "E34") expect(b.referencedEncf).toBe(s.sale.encf);
        expect(b.cashierId).toBe("u-ana");
        return ok(`r-${b.encf}`, b.encf);
      },
      "GET /v1/sync/cashiers": () => Response.json({ data: [{ userId: "u-ana", name: "Ana", email: "a@x.com", role: "member", pin: "pbkdf2$sha256$1$AA==$AA==" }] }),
      "GET /v1/sync/catalog": catalog,
      "GET /v1/sync/sequence-blocks": () => Response.json({ data: [] }),
    });
    const report = await runSync(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { policy: { types: [], size: 10, low: 1 }, now: at(40) });
    expect(order).toEqual(["shift:open", "E32:turno", "E34:turno", "shift:close", "E32:sin-turno"]);
    expect(report).toMatchObject({ online: true, error: null, shiftErrors: [], sales: { uploaded: 3, pending: 0 } });
    expect(currentShift(db)).toBeNull();
    expect(one<{ open_synced: number; close_synced: number }>(db, "SELECT open_synced, close_synced FROM shift")).toEqual({ open_synced: 1, close_synced: 1 });
    expect(cashiers(db).map((x) => x.name)).toEqual(["Ana"]);

    // Otra ronda no vuelve a tocar el turno.
    order.length = 0;
    await runSync(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { policy: { types: [], size: 10, low: 1 }, now: at(50) });
    expect(order).toEqual([]);
  });

  it("si la nube no acepta el turno, sus ventas esperan (no se suben sin turno) y se avisa", async () => {
    const { db, p, ctx, sell } = setup();
    const shift = openShift(db, ctx(0), "0");
    sell(ctx(1, { shiftId: shift.id }), [{ productId: p.id, quantity: "1" }]);
    let calls = 0;
    const { fetch } = fakeCloud({
      [`PUT /v1/sync/shifts/${shift.id}`]: () => Response.json({ error: "Esa caja ya tiene un turno abierto en la nube" }, { status: 409 }),
      "POST /v1/sync/sales": () => {
        calls++;
        return ok("x", "x");
      },
      "GET /v1/sync/cashiers": () => Response.json({ data: [] }),
      "GET /v1/sync/catalog": catalog,
      "GET /v1/sync/sequence-blocks": () => Response.json({ data: [] }),
    });
    const report = await runSync(db, new ApiClient("https://api.test", { fetch }), TERMINAL, { policy: { types: [], size: 10, low: 1 }, now: at(5) });
    expect(calls).toBe(0);
    expect(report.shiftErrors).toEqual(["Esa caja ya tiene un turno abierto en la nube"]);
    expect(report.sales.pending).toBe(1);
    expect(currentShift(db)?.syncError).toMatch(/ya tiene un turno abierto/);
  });
});
