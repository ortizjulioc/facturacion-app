import { toCents } from "@facturacion/core";
import type { CatalogResponse } from "./api";
import { all, getMeta, one, run, setMeta, transaction, type Db } from "./store";

export type LocalProduct = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  categoryId: string | null;
  priceCents: number;
  priceIncludesTax: boolean;
  tax: string;
  unit: string;
  allowsDecimals: boolean;
  trackInventory: boolean;
};

export type LocalCustomer = {
  id: string;
  name: string;
  documentType: string | null;
  documentNumber: string | null;
  email: string | null;
  phone: string | null;
};

type ProductRow = {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category_id: string | null;
  price_cents: number;
  price_includes_tax: number;
  tax: string;
  unit: string;
  allows_decimals: number;
  track_inventory: number;
};

const productOf = (r: ProductRow): LocalProduct => ({
  id: r.id,
  name: r.name,
  sku: r.sku,
  barcode: r.barcode,
  categoryId: r.category_id,
  priceCents: r.price_cents,
  priceIncludesTax: r.price_includes_tax === 1,
  tax: r.tax,
  unit: r.unit,
  allowsDecimals: r.allows_decimals === 1,
  trackInventory: r.track_inventory === 1,
});

/**
 * Aplica un lote del catálogo de la nube. Es idempotente (upsert por id): bajar dos veces lo mismo no cambia nada,
 * y un producto desactivado en la nube queda inactivo aquí (no se borra: las ventas viejas lo referencian).
 */
export function applyCatalog(db: Db, page: CatalogResponse["data"]) {
  transaction(db, () => {
    for (const p of page.products) {
      run(
        db,
        `INSERT INTO product (id, name, sku, barcode, category_id, price_cents, price_includes_tax, tax, unit, allows_decimals, track_inventory, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
           category_id = excluded.category_id, price_cents = excluded.price_cents, price_includes_tax = excluded.price_includes_tax,
           tax = excluded.tax, unit = excluded.unit, allows_decimals = excluded.allows_decimals,
           track_inventory = excluded.track_inventory, active = excluded.active`,
        p.id,
        p.name,
        p.sku,
        p.barcode,
        p.categoryId,
        Number(toCents(p.price)),
        p.priceIncludesTax ? 1 : 0,
        p.tax,
        p.unit,
        p.allowsDecimals ? 1 : 0,
        p.trackInventory ? 1 : 0,
        p.active ? 1 : 0,
      );
    }
    for (const c of page.customers) {
      run(
        db,
        `INSERT INTO customer (id, name, document_type, document_number, email, phone, active)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, document_type = excluded.document_type,
           document_number = excluded.document_number, email = excluded.email, phone = excluded.phone, active = excluded.active`,
        c.id,
        c.name,
        c.documentType,
        c.documentNumber,
        c.email,
        c.phone,
        c.active ? 1 : 0,
      );
    }
    // Las categorías llegan completas en cada bajada: se reemplazan.
    run(db, "DELETE FROM category");
    for (const c of page.categories) run(db, "INSERT INTO category (id, name) VALUES (?, ?)", c.id, c.name);
    if (page.company) setMeta(db, "company", JSON.stringify(page.company));
  });
}

export type Company = NonNullable<CatalogResponse["data"]["company"]>;
export const getCompany = (db: Db): Company | null => {
  const raw = getMeta(db, "company");
  return raw ? (JSON.parse(raw) as Company) : null;
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

/** Búsqueda por nombre, SKU o código de barras (solo productos activos). */
export function searchProducts(db: Db, q: string, opts: { categoryId?: string; limit?: number } = {}): LocalProduct[] {
  const term = q.trim();
  const rows = all<ProductRow>(
    db,
    `SELECT * FROM product
     WHERE active = 1
       AND (? = '' OR name LIKE ? ESCAPE '\\' OR sku LIKE ? ESCAPE '\\' OR barcode = ?)
       AND (? IS NULL OR category_id = ?)
     ORDER BY name COLLATE NOCASE LIMIT ?`,
    term,
    like(term),
    like(term),
    term,
    opts.categoryId ?? null,
    opts.categoryId ?? null,
    opts.limit ?? 60,
  );
  return rows.map(productOf);
}

/** Producto por código de barras exacto (lector). */
export function productByBarcode(db: Db, code: string): LocalProduct | null {
  const r = one<ProductRow>(db, "SELECT * FROM product WHERE active = 1 AND barcode = ? LIMIT 1", code.trim());
  return r ? productOf(r) : null;
}

export function getProduct(db: Db, id: string): (LocalProduct & { active: boolean }) | null {
  const r = one<ProductRow & { active: number }>(db, "SELECT * FROM product WHERE id = ?", id);
  return r ? { ...productOf(r), active: r.active === 1 } : null;
}

export function searchCustomers(db: Db, q: string, limit = 8): LocalCustomer[] {
  const term = q.trim();
  if (!term) return [];
  return all<{
    id: string;
    name: string;
    document_type: string | null;
    document_number: string | null;
    email: string | null;
    phone: string | null;
  }>(
    db,
    `SELECT * FROM customer WHERE active = 1 AND (name LIKE ? ESCAPE '\\' OR document_number LIKE ? ESCAPE '\\')
     ORDER BY name COLLATE NOCASE LIMIT ?`,
    like(term),
    like(term),
    limit,
  ).map((r) => ({
    id: r.id,
    name: r.name,
    documentType: r.document_type,
    documentNumber: r.document_number,
    email: r.email,
    phone: r.phone,
  }));
}

export function getCustomer(db: Db, id: string): LocalCustomer | null {
  return searchCustomersById(db, id);
}
function searchCustomersById(db: Db, id: string): LocalCustomer | null {
  const r = one<{ id: string; name: string; document_type: string | null; document_number: string | null; email: string | null; phone: string | null }>(
    db,
    "SELECT * FROM customer WHERE id = ?",
    id,
  );
  return r
    ? { id: r.id, name: r.name, documentType: r.document_type, documentNumber: r.document_number, email: r.email, phone: r.phone }
    : null;
}

export const categories = (db: Db) => all<{ id: string; name: string }>(db, "SELECT id, name FROM category ORDER BY name COLLATE NOCASE");
export const productCount = (db: Db) => one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM product WHERE active = 1")?.n ?? 0;
