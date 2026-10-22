import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Base de datos local de la caja (SQLite, archivo único). Todo lo que la caja necesita para vender sin conexión
 * vive aquí: catálogo, clientes, bloques de e-NCF y las ventas pendientes de subir.
 *
 * Las migraciones son una lista ordenada de scripts; `PRAGMA user_version` guarda cuántos ya se aplicaron.
 * Nunca se editan las ya publicadas: se agrega una nueva al final.
 */
export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE category (id TEXT PRIMARY KEY, name TEXT NOT NULL);

  CREATE TABLE product (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sku TEXT,
    barcode TEXT,
    category_id TEXT,
    price_cents INTEGER NOT NULL,
    price_includes_tax INTEGER NOT NULL,
    tax TEXT NOT NULL,
    unit TEXT NOT NULL,
    allows_decimals INTEGER NOT NULL,
    track_inventory INTEGER NOT NULL,
    active INTEGER NOT NULL
  );
  CREATE INDEX product_barcode ON product (barcode);
  CREATE INDEX product_name ON product (name);

  CREATE TABLE customer (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    document_type TEXT,
    document_number TEXT,
    email TEXT,
    phone TEXT,
    active INTEGER NOT NULL
  );
  CREATE INDEX customer_name ON customer (name);
  CREATE INDEX customer_document ON customer (document_number);

  -- Bloques de e-NCF entregados a esta caja. next_number es el próximo a usar (from <= next <= to + 1).
  CREATE TABLE seq_block (
    id TEXT PRIMARY KEY,
    ecf_type TEXT NOT NULL,
    from_number INTEGER NOT NULL,
    to_number INTEGER NOT NULL,
    next_number INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    CHECK (from_number <= next_number AND next_number <= to_number + 1)
  );

  -- Ventas hechas en esta caja. 'payload' es exactamente lo que se sube a la nube.
  CREATE TABLE sale (
    id TEXT PRIMARY KEY,
    encf TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    issued_at TEXT NOT NULL,
    total_cents INTEGER NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SYNCED', 'REJECTED')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    remote_id TEXT,
    synced_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX sale_status ON sale (status, created_at);
  `,
  /* 2: cajeros con PIN, turnos de la caja y notas de crédito */ `
  -- Quienes pueden identificarse en esta caja (con el resumen del PIN, que se verifica sin internet).
  CREATE TABLE cashier (
    user_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    pin_hash TEXT NOT NULL
  );

  -- Turnos. 'id' es el clientId que se sube a la nube. Solo puede haber UNO abierto en esta caja.
  CREATE TABLE shift (
    id TEXT PRIMARY KEY,
    opened_at TEXT NOT NULL,
    opened_by TEXT,
    opening_cents INTEGER NOT NULL CHECK (opening_cents >= 0),
    closed_at TEXT,
    closed_by TEXT,
    counted_cents INTEGER,
    expected_cents INTEGER,
    difference_cents INTEGER,
    notes TEXT,
    open_synced INTEGER NOT NULL DEFAULT 0,
    close_synced INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    CHECK ((closed_at IS NULL) = (counted_cents IS NULL))
  );
  CREATE UNIQUE INDEX shift_one_open ON shift ((closed_at IS NULL)) WHERE closed_at IS NULL;

  ALTER TABLE sale ADD COLUMN shift_id TEXT REFERENCES shift (id);
  ALTER TABLE sale ADD COLUMN cashier_id TEXT;
  -- Solo notas de crédito: e-NCF del comprobante que modifican.
  ALTER TABLE sale ADD COLUMN refund_of TEXT;
  CREATE INDEX sale_shift ON sale (shift_id);
  CREATE INDEX sale_refund ON sale (refund_of);
  `,
  /* 4 */ `
  -- Firma del e-CF: la nube la devuelve al subir la venta (si la empresa tiene certificado digital).
  ALTER TABLE sale ADD COLUMN security_code TEXT;
  ALTER TABLE sale ADD COLUMN signed_at TEXT;
  ALTER TABLE sale ADD COLUMN qr_url TEXT;
  `,
  /* 5 */ `
  -- e-CF firmado en la caja (sin conexión): se sube con la venta para que la nube guarde ESE XML, el del código del QR.
  ALTER TABLE sale ADD COLUMN ecf_xml TEXT;
  `,
];

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

function migrate(db: Db) {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Ejecuta `fn` en una transacción que toma el candado de escritura desde el inicio (nadie se cuela entre leer y escribir). */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const all = <T>(db: Db, sql: string, ...params: SQLInputValue[]) =>
  db.prepare(sql).all(...params) as unknown as T[];
export const one = <T>(db: Db, sql: string, ...params: SQLInputValue[]) =>
  (db.prepare(sql).get(...params) as unknown as T | undefined) ?? undefined;
export const run = (db: Db, sql: string, ...params: SQLInputValue[]) => db.prepare(sql).run(...params);

export function getMeta(db: Db, key: string): string | null {
  return one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key)?.value ?? null;
}
export function setMeta(db: Db, key: string, value: string | null) {
  if (value === null) run(db, "DELETE FROM meta WHERE key = ?", key);
  else run(db, "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
}
