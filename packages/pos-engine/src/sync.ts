import { fromCents } from "@facturacion/core";
import { ApiClient, ApiError, NetworkError, type CloudBlock } from "./api";
import { applyCatalog } from "./catalog";
import { applyCashiers } from "./cashiers";
import { salePayload } from "./sales";
import { all, getMeta, one, run, setMeta, transaction, type Db } from "./store";

export type BlockPolicy = {
  /** Tipos de comprobante que la caja emite (E34 = notas de crédito para devoluciones). */
  types: ("E31" | "E32" | "E34")[];
  /** Tamaño de cada bloque que se pide. */
  size: number;
  /** Se pide un bloque nuevo cuando quedan menos números que esto. */
  low: number;
};
export const DEFAULT_POLICY: BlockPolicy = { types: ["E32", "E31", "E34"], size: 200, low: 40 };

export type SyncReport = {
  /** false = no hubo conexión con la nube (se vende con lo que hay). */
  online: boolean;
  /** true = la sesión expiró: hay que volver a iniciar sesión (los datos locales se conservan). */
  authRequired: boolean;
  catalog: { products: number; customers: number } | null;
  /** Turnos con problemas para subir (p. ej. la nube ya tiene uno abierto en esa caja). Sus ventas esperan. */
  shiftErrors: string[];
  blocks: { requested: number; error: string | null };
  sales: { uploaded: number; duplicates: number; rejected: number; pending: number };
  error: string | null;
};

type BlockRow = { id: string; ecf_type: string; from_number: number; to_number: number; next_number: number; expires_at: string };

const saveBlock = (db: Db, b: CloudBlock) =>
  run(
    db,
    `INSERT INTO seq_block (id, ecf_type, from_number, to_number, next_number, expires_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
    b.id,
    b.ecfType,
    b.fromNumber,
    b.toNumber,
    b.nextNumber,
    b.expiresAt,
  );

/** Cuántos números sin usar quedan de un tipo (bloques vencidos no cuentan). */
export function remainingNumbers(db: Db, type: string, today: string): number {
  return (
    one<{ n: number | null }>(
      db,
      "SELECT SUM(to_number - next_number + 1) AS n FROM seq_block WHERE ecf_type = ? AND expires_at >= ? AND next_number <= to_number",
      type,
      today,
    )?.n ?? 0
  );
}

const todayDr = (now: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Santo_Domingo" }).format(now);

/** Baja los catálogos que cambiaron desde la última vez (con reintento por lotes hasta ponerse al día). */
export async function pullCatalog(db: Db, api: ApiClient): Promise<{ products: number; customers: number }> {
  let cursor = getMeta(db, "catalog_cursor");
  let products = 0;
  let customers = 0;
  for (let page = 0; page < 200; page++) {
    const res = await api.catalog(cursor, 500);
    applyCatalog(db, res.data);
    products += res.data.products.length;
    customers += res.data.customers.length;
    cursor = res.cursor;
    setMeta(db, "catalog_cursor", cursor);
    if (!res.hasMore) break;
  }
  setMeta(db, "catalog_synced_at", new Date().toISOString());
  return { products, customers };
}

/**
 * Mantiene la caja con números de e-NCF para facturar sin conexión:
 *  1) recupera los bloques que la nube ya le entregó y la caja no conoce (p. ej. se perdió la respuesta);
 *  2) pide uno nuevo por cada tipo que esté por agotarse.
 */
export async function topUpBlocks(
  db: Db,
  api: ApiClient,
  terminalId: string,
  policy: BlockPolicy = DEFAULT_POLICY,
  now = new Date(),
): Promise<{ requested: number; error: string | null }> {
  const cloud = await api.blocks(terminalId);
  for (const b of cloud.data) {
    const known = one<{ id: string }>(db, "SELECT id FROM seq_block WHERE id = ?", b.id);
    if (!known) saveBlock(db, b); // nunca usado aquí: el siguiente que dice la nube es el correcto
  }

  let requested = 0;
  let error: string | null = null;
  for (const type of policy.types) {
    if (remainingNumbers(db, type, todayDr(now)) >= policy.low) continue;
    try {
      const res = await api.requestBlock(terminalId, type, policy.size);
      saveBlock(db, res.data);
      requested++;
    } catch (e) {
      // Sin rango disponible en la nube u otro rechazo: se informa, pero no detiene la sincronización.
      if (e instanceof ApiError && e.status !== 401) error = `${type}: ${e.message}`;
      else throw e;
    }
  }
  return { requested, error };
}

/**
 * Sube las ventas pendientes en orden. Cada venta es idempotente (`clientId`), así que un reintento tras un corte
 * nunca duplica. Un rechazo definitivo (422/409) marca la venta como REJECTED con el motivo y sigue con las demás;
 * un corte de red o un error del servidor detiene el envío y las ventas quedan pendientes.
 */
export async function pushSales(db: Db, api: ApiClient, now = new Date(), only?: { shiftId: string | null }) {
  const result = { uploaded: 0, duplicates: 0, rejected: 0 };
  const pending = only
    ? all<{ id: string }>(
        db,
        "SELECT id FROM sale WHERE status = 'PENDING' AND shift_id IS ? ORDER BY created_at, encf",
        only.shiftId,
      )
    : all<{ id: string }>(db, "SELECT id FROM sale WHERE status = 'PENDING' ORDER BY created_at, encf");
  for (const { id } of pending) {
    const outcome = await pushOne(db, api, id, now);
    if (outcome === "uploaded") result.uploaded++;
    else if (outcome === "duplicate") result.duplicates++;
    else if (outcome === "rejected") result.rejected++;
  }
  return result;
}

/** Sube una venta. Un rechazo definitivo se anota y devuelve "rejected"; un fallo de red u otro error se relanza. */
async function pushOne(db: Db, api: ApiClient, id: string, now: Date): Promise<"uploaded" | "duplicate" | "rejected" | "skipped"> {
  const payload = salePayload(db, id);
  if (!payload) return "skipped";
  try {
    const res = await api.uploadSale(payload);
    const ecf = res.data.ecf;
    transaction(db, () =>
      run(
        db,
        "UPDATE sale SET status = 'SYNCED', remote_id = ?, synced_at = ?, last_error = NULL, attempts = attempts + 1, security_code = ?, signed_at = ?, qr_url = ? WHERE id = ?",
        res.data.id,
        now.toISOString(),
        ecf?.securityCode ?? null,
        ecf?.signedAt ?? null,
        ecf?.qrUrl ?? null,
        id,
      ),
    );
    return res.data.duplicate ? "duplicate" : "uploaded";
  } catch (e) {
    if (e instanceof ApiError && (e.status === 422 || e.status === 409 || e.status === 400)) {
      run(db, "UPDATE sale SET status = 'REJECTED', last_error = ?, attempts = attempts + 1 WHERE id = ?", e.message, id);
      return "rejected";
    }
    run(db, "UPDATE sale SET attempts = attempts + 1, last_error = ? WHERE id = ?", e instanceof Error ? e.message : String(e), id);
    throw e; // red caída, sesión vencida o error del servidor: se reintenta en la próxima sincronización
  }
}

/**
 * Intenta subir YA una venta recién hecha para que la nube la firme y el ticket salga con QR. Es un adelanto de la
 * sincronización normal, así que solo actúa si no rompe su orden (ninguna venta anterior pendiente); si su turno aún
 * no está en la nube, lo sube primero (como haría la sincronización). En cualquier otro caso, o si falla la red,
 * devuelve false y la venta sigue pendiente como siempre.
 */
export async function pushSaleNow(db: Db, api: ApiClient, terminalId: string, id: string, now = new Date()): Promise<boolean> {
  const sale = one<{ status: string; created_at: string; shift_id: string | null }>(db, "SELECT status, created_at, shift_id FROM sale WHERE id = ?", id);
  if (!sale) return false;
  if (sale.status === "SYNCED") return true;
  if (sale.status !== "PENDING") return false;
  const earlier = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sale WHERE status = 'PENDING' AND id <> ? AND created_at <= ?", id, sale.created_at);
  if (earlier && earlier.n > 0) return false;
  try {
    if (sale.shift_id) {
      const shift = one<ShiftSyncRow>(db, "SELECT * FROM shift WHERE id = ?", sale.shift_id);
      if (!shift) return false;
      if (shift.open_synced !== 1) {
        await api.putShift(shift.id, shiftBody(shift, terminalId, false));
        run(db, "UPDATE shift SET open_synced = 1, last_error = NULL WHERE id = ?", shift.id);
      }
    }
    return (await pushOne(db, api, id, now)) !== "rejected";
  } catch {
    return false;
  }
}

/** Una ronda completa: ventas hacia arriba, luego catálogos hacia abajo y bloques de e-NCF. Nunca lanza por falta de red. */
export async function runSync(
  db: Db,
  api: ApiClient,
  terminalId: string,
  opts: { policy?: BlockPolicy; now?: Date } = {},
): Promise<SyncReport> {
  const report: SyncReport = {
    online: true,
    authRequired: false,
    catalog: null,
    shiftErrors: [],
    blocks: { requested: 0, error: null },
    sales: { uploaded: 0, duplicates: 0, rejected: 0, pending: 0 },
    error: null,
  };
  try {
    const sum = (r: { uploaded: number; duplicates: number; rejected: number }) => {
      report.sales.uploaded += r.uploaded;
      report.sales.duplicates += r.duplicates;
      report.sales.rejected += r.rejected;
    };
    // Cada turno sube en orden: primero su apertura, luego sus ventas y notas de crédito, y al final su cierre
    // (la nube calcula el cuadre con lo ya subido). Un turno que la nube no acepta deja sus ventas esperando,
    // para no subirlas sin su turno.
    for (const sh of all<ShiftSyncRow>(db, "SELECT * FROM shift ORDER BY opened_at")) {
      const done = sh.open_synced === 1 && (sh.closed_at === null || sh.close_synced === 1);
      if (done && !one(db, "SELECT 1 AS x FROM sale WHERE shift_id = ? AND status = 'PENDING' LIMIT 1", sh.id)) continue;
      try {
        if (sh.open_synced !== 1) {
          await api.putShift(sh.id, shiftBody(sh, terminalId, false));
          run(db, "UPDATE shift SET open_synced = 1, last_error = NULL WHERE id = ?", sh.id);
        }
        sum(await pushSales(db, api, opts.now, { shiftId: sh.id }));
        if (sh.closed_at !== null && sh.close_synced !== 1) {
          await api.putShift(sh.id, shiftBody(sh, terminalId, true));
          run(db, "UPDATE shift SET close_synced = 1, last_error = NULL WHERE id = ?", sh.id);
        }
      } catch (e) {
        if (e instanceof ApiError && (e.status === 409 || e.status === 422 || e.status === 400)) {
          run(db, "UPDATE shift SET last_error = ? WHERE id = ?", e.message, sh.id);
          report.shiftErrors.push(e.message);
          continue;
        }
        throw e;
      }
    }
    sum(await pushSales(db, api, opts.now, { shiftId: null }));
    applyCashiers(db, (await api.cashiers()).data);
    report.catalog = await pullCatalog(db, api);
    report.blocks = await topUpBlocks(db, api, terminalId, opts.policy, opts.now);
  } catch (e) {
    if (e instanceof NetworkError) {
      report.online = false;
      report.error = "Sin conexión con la nube";
    } else if (e instanceof ApiError && e.status === 401) {
      report.authRequired = true;
      report.error = "La sesión expiró: inicia sesión de nuevo";
    } else {
      report.error = e instanceof Error ? e.message : String(e);
    }
  }
  report.sales.pending = one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sale WHERE status = 'PENDING'")?.n ?? 0;
  setMeta(db, "last_sync", JSON.stringify({ at: (opts.now ?? new Date()).toISOString(), ok: report.error === null }));
  return report;
}

type ShiftSyncRow = {
  id: string;
  opened_at: string;
  opened_by: string | null;
  opening_cents: number;
  closed_at: string | null;
  closed_by: string | null;
  counted_cents: number | null;
  notes: string | null;
  open_synced: number;
  close_synced: number;
};

/** Cuerpo de `PUT /v1/sync/shifts/:clientId`. Con `withClose` incluye el cierre. */
function shiftBody(sh: ShiftSyncRow, terminalId: string, withClose: boolean) {
  const cents = (n: number) => fromCents(BigInt(n));
  return {
    terminalId,
    openedAt: sh.opened_at,
    openedById: sh.opened_by,
    openingAmount: cents(sh.opening_cents),
    ...(withClose && sh.closed_at
      ? { close: { closedAt: sh.closed_at, closedById: sh.closed_by, countedCash: cents(sh.counted_cents ?? 0), notes: sh.notes } }
      : {}),
  };
}

export const blocksOverview = (db: Db, now = new Date()) =>
  all<BlockRow>(db, "SELECT * FROM seq_block ORDER BY ecf_type, from_number").map((b) => ({
    id: b.id,
    type: b.ecf_type,
    from: b.from_number,
    to: b.to_number,
    next: b.next_number,
    remaining: b.expires_at >= todayDr(now) ? Math.max(0, b.to_number - b.next_number + 1) : 0,
    expiresAt: b.expires_at,
  }));
