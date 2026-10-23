# Plan: sistema de facturación (República Dominicana)

Sistema de facturación y punto de venta **multiempresa y multigiro** (tienda, restaurante, servicios…), con **facturación electrónica e-CF de la DGII**, que funciona **en la nube y también sin internet en la caja**.

---

## 0. Estado actual y cómo continuar

> **Última actualización:** 2026-10-21 · **Repositorio:** `github.com/ortizjulioc/facturacion-app` (rama `main`)
> **Regla del proyecto:** el despliegue en Dokploy se hace **cuando el producto esté terminado y pulido**, no antes. Mientras tanto se desarrolla y prueba todo en local.

### 0.1 Resumen en una mirada

| Fase | Estado |
|---|---|
| 0 · Fundamentos (monorepo, BD, auth, CI, Dockerfiles) | ✅ hecha en local · ⏸ despliegue de prueba en Dokploy **aplazado a propósito** |
| 1 · Núcleo de negocio | 🔶 **~85 %**: catálogo, clientes, cajas, motor de cálculo, **datos fiscales, secuencias e-NCF y facturas (E31/E32/E33/E34) emitibles y congeladas**; **cada comprobante se firma al emitirse si la empresa sube su certificado `.p12` (cifrado), con QR y código de seguridad; **el envío a la DGII ya está conectado (cola con reintentos, TrackId y estados ACEPTADO/RECHAZADO), probado solo con una DGII simulada; incluye el resumen RFCE de las facturas de consumo < RD$250,000; **recibe e-CF de proveedores (acuse de recibo y aprobación comercial)**; falta TesteCF y los XSD** y validar RNC contra el padrón; **equipo e invitaciones ya funcionan** |
| 2 · Facturación en la web | 🔶 emisión desde el back-office **hecha** (sin enviar a la DGII); faltan PDF con QR, envío por correo y workers |
| 5 · Inventario y compras | 🔶 **inventario y compras hechos** (existencias por sucursal, descuento al vender, proveedores, facturas de proveedor, E41, E43, retenciones, último costo, reporte de compras tipo 606); faltan transferencias entre sucursales, cuentas por pagar, costo promedio y la recepción de e-CF de proveedores |
| 6 · Restaurante | 🔶 **mesas, comandas, cocina/bar, cobro con propina legal y cuenta dividida hechos** (salón, comanda, pantalla de cocina, cobro que emite E32/E31); **modificadores con precio, cursos (envío por tiempos) y combos hechos**; faltan impresión de comanda/pre-cuenta (llega con la caja Electron), unir/dividir mesas, reservas y PWA de meseros |
| 3 · Caja offline | 🔶 **caja Electron funcionando (`apps/pos`)**: SQLite local, venta sin internet con e-NCF de un bloque propio, cobro mixto, ticket, sincronización idempotente (catálogo hacia abajo, ventas hacia arriba) y reconexión; **turnos de caja** con informe X/Z en la nube. **login con PIN, turnos dentro de la caja (sincronizados) y devoluciones con nota de crédito** también funcionan sin internet, e **imprime en térmica ESC/POS** (red o impresora de Windows, con apertura de gaveta). El ticket sale **con el QR de la DGII** cuando hay conexión (la nube firma la venta antes de imprimir) y lo trae al reimprimir; **la caja firma sola, sin internet**, con el certificado de la empresa guardado en el almacén seguro del sistema (el ticket sale con QR aunque no haya conexión); **se instala con un instalador de Windows (NSIS) y se actualiza sola** (la API publica las versiones; la caja las descarga en segundo plano y el cajero decide cuándo reiniciar); **abre sola al encender la PC** y el proceso de **firma de código** está listo (falta el certificado); falta restaurante y existencias en la caja |
| 4, 7, 8 | ⬜ sin empezar (la 7 tiene el reporte de ventas y los **formatos 606/607/608 de la DGII**) |

Calidad actual (todo en verde): `lint`, `typecheck`, `build` y **561 pruebas** (77 `core` + 38 de BD + 49 del motor de la caja + 14 de la caja (auto-actualización y arranque) + 21 de impresión + 69 de `ecf` + 293 de la API contra Postgres real, incluida la caja completa). Verificado además a mano en el navegador: registro → datos fiscales → secuencias → factura con código de barras → emisión → nota de crédito → factura de crédito fiscal con RNC → reportes → invitar a un cajero, que crea su cuenta con el enlace y trabaja con permisos limitados → inventario (entrada, venta que descuenta, stock bajo, bloqueo de ventas sin existencia) → proveedores y compras (factura de proveedor que da entrada al inventario con costo, E43, E41 con retenciones, reporte de compras) → restaurante (crear mesas, abrir mesa, anotar, enviar a cocina, marcar listo, cobrar una parte y luego el resto con pago dividido, la mesa queda libre, E31 exige cliente con RNC) → carta (grupos «Término» obligatorio y «Extras» con recargo, hamburguesa con opciones a RD$410, combo con partes que van a cocina y bar, envío «solo plato fuerte», factura que detalla las opciones) → caja Electron (configurar contra la API, escanear código de barras, vender con pago dividido, ticket de 80 mm con el e-NCF del bloque, sincronizar y ver la venta ya emitida en la nube) → caja con PIN, turno y devolución (identificarse con el teclado de la pantalla, PIN equivocado rechazado, turno obligatorio, vender, devolver 1 de 2 en efectivo, cerrar con diferencia que pide motivo, informe Z, sincronizar y bloquear) → impresión térmica (configurar una impresora de red simulada desde la pantalla, imprimir la prueba, ticket de venta con gaveta, nota de crédito, informe Z, y una impresora apagada que no frena la venta y se reintenta) → turnos de caja (abrir con fondo, vender en esa caja, informe X en vivo, cerrar con diferencia que exige motivo, informe Z imprimible).

### 0.2 Retomar el trabajo en otra PC

**Requisitos:** Git, **Node 24**, **pnpm 11** (`npm i -g pnpm@11.23.0` o `corepack enable`), **PostgreSQL 18** con `psql` en el `PATH` (o Docker Desktop) y, si usas Claude Code, que el repo esté abierto en esa carpeta.

```bash
git clone https://github.com/ortizjulioc/facturacion-app.git
cd facturacion-app
pnpm install
```

**Base de datos (elige una):**

- *Postgres instalado en la PC:* crea un archivo `.env` en la raíz con una sola línea (usuario administrador, solo lo usa el script de bootstrap):
  ```env
  DATABASE_URL_ADMIN="postgresql://postgres:TU_CLAVE@localhost:5432/postgres"
  ```
- *Docker:* `docker compose -f docker/docker-compose.dev.yml up -d` y usa
  ```env
  DATABASE_URL_ADMIN="postgresql://postgres:postgres@localhost:5433/postgres"
  ```

```bash
pnpm db:bootstrap   # crea la base "facturacion", los roles y completa el .env (DATABASE_URL, DATABASE_URL_MIGRATE, BETTER_AUTH_SECRET)
pnpm db:deploy      # aplica las migraciones
pnpm dev            # web en http://localhost:3000 y API en http://localhost:3001
```

Abre `http://localhost:3000/registro`, crea una empresa y ya tienes un entorno completo. Comprobación final: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.

> El `.env` **no está en git** (contiene secretos). En la PC nueva se genera con `pnpm db:bootstrap`; no copies el de la otra PC.
> Los datos de desarrollo (empresas de prueba) **no viajan**: cada PC tiene su propia base.

### 0.3 Comandos del día a día

| Comando | Qué hace |
|---|---|
| `pnpm dev` | Web + API con recarga en caliente (genera el cliente Prisma antes) |
| `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build` | Calidad (Turborepo, con caché) |
| `pnpm db:deploy` | Aplica migraciones pendientes (con el rol dueño) |
| `pnpm db:diff` | Imprime el SQL de los cambios hechos en `schema.prisma` (ver §0.3.1) |
| `pnpm db:studio` | Prisma Studio |
| `pnpm --filter @facturacion/api test` | Solo las pruebas de la API (necesitan Postgres y el `.env`) |
| `pnpm --filter @facturacion/core test` | Solo el motor fiscal (no necesita BD) |

**Variables de entorno** (ver `.env.example`): `DATABASE_URL` (rol `facturacion_app`, la usa la API), `DATABASE_URL_MIGRATE` (rol `facturacion_migrator`, dueño de las tablas), `DATABASE_URL_ADMIN` (solo bootstrap local), `BETTER_AUTH_SECRET`, `API_PORT`, `API_PUBLIC_URL`, `WEB_ORIGIN`, `COOKIE_DOMAIN` (vacío en local), `NEXT_PUBLIC_API_URL`.

### 0.3.1 Cómo crear una migración nueva

`prisma migrate dev` **no funciona aquí** (comprobado: *"Prisma Migrate could not create the shadow database"*): necesita crear una *shadow database* y el rol `facturacion_migrator` no tiene permiso `CREATEDB`, a propósito, igual que en producción. Por eso no existe un script `db:migrate`. El flujo probado es:

```bash
cd packages/db
# 1. edita prisma/schema.prisma
# 2. genera el SQL comparando contra la BD viva (sin shadow DB):
mkdir prisma/migrations/AAAAMMDDHHMMSS_nombre
pnpm db:diff > prisma/migrations/AAAAMMDDHHMMSS_nombre/migration.sql
# 3. al final de ese archivo agrega a mano el bloque RLS de cada tabla nueva (ver migraciones existentes)
# 4. aplica y regenera el cliente
pnpm db:deploy && pnpm exec prisma generate
```

**Toda tabla de negocio nueva debe llevar `organizationId` + políticas RLS** y una prueba en `packages/db/src/tenant.test.ts`.

### 0.4 Lo que ya está hecho

**Infraestructura**
- Monorepo pnpm + Turborepo (`apps/web`, `apps/api`, `packages/core`, `packages/db`), TypeScript estricto, Prettier, `.nvmrc` (Node 24).
- Postgres 18 con **RLS por empresa**: la API se conecta con un rol sin privilegios y cada consulta fija `app.tenant_id` dentro de su transacción (`withTenant` / `tenantTransaction`). Sin tenant, las tablas aparecen vacías (falla cerrado). La bitácora (`audit_log`) es inmutable para el rol de la app.
- Better Auth: registro, login, **organizaciones = empresas**, sesión por cookie, roles `owner` / `admin` / `member`.
- Dockerfiles arm64 (`docker/Dockerfile.api`, `Dockerfile.web`), `docker-compose.dev.yml` (Postgres + MinIO), workflows de CI y de despliegue (`.github/workflows`) y guía [DESPLIEGUE.md](DESPLIEGUE.md). **Los Dockerfiles y el workflow de despliegue nunca se han ejecutado** (la PC de desarrollo no tiene Docker).

**`packages/core`** (lógica fiscal pura, sin frameworks): dinero en centavos `bigint`, cantidades en milésimas, impuestos `ITBIS18 / ITBIS16 / ITBIS0 / EXENTO` con etiquetas, `calculateLine` y `calculateDocument` (precio con o sin ITBIS, descuentos por % o monto, redondeo mitad-arriba **por línea**, totales agrupados por tasa como en el e-CF, propina legal 10 %) normalización/formato de RNC, cédula y pasaporte (solo formato; sin dígito verificador a propósito) y **`ecf.ts`**: tipos E31/E32/E33/E34, formato y lectura del **e-NCF** (`E` + tipo + 10 dígitos), umbral de RD$250,000 para identificar al comprador, reglas del comprador por tipo, códigos de modificación de las notas y cálculo de lo que queda por acreditar.

**`packages/db`**: tablas `user/session/account/verification/organization/member/invitation` (Better Auth), `branch`, `terminal`, `category`, `product`, `customer`, `audit_log`, y las fiscales **`company_profile`, `sequence`, `document`, `document_line`, `payment`**; y las de restaurante **`dining_table`, `restaurant_order`, `order_item`** (+ `Product.prepStation/course/isCombo`, `Document.orderId`) **`cashier_pin`** (PIN de cajero, solo el resumen PBKDF2), `CashShift.clientId` (turnos subidos desde la caja), `Document.returnsStock` (nota de crédito que devuelve mercancía), `CompanyProfile.requireShift` (turno obligatorio), las de la caja offline (**`Sequence.offline`**: bloques de e-NCF exclusivos de una caja; **`Document.clientId`**: idempotencia de la subida), las de turnos **`cash_shift`** (+ `Document.shiftId`, enum `ShiftStatus`) y las de la carta **`modifier_group`, `modifier`, `product_modifier_group`, `combo_component`** (+ `order_item.course/modifiers/parentItemId`); enums `TaxCode`, `DocumentType`, `EcfType`, `DocumentStatus`, `PaymentMethod`, `EcfEnvironment`, `PrepStation`, `OrderStatus`, `OrderItemStatus`; 13 migraciones (la última, `pos_pin_shifts_returns`; antes, `offline_sync`; antes, `cash_shifts`; antes, `restaurant_menu`; antes, `restaurant`; antes, `purchases`: `supplier`, `purchase`, `purchase_line`, `lastCost` en el producto y `purchaseId` en los movimientos; la anterior, `inventory`: `stock_level` y `stock_movement`, campos `trackInventory` y `minStock` en el producto y `allowNegativeStock` en la empresa). La base de datos **impide por sí misma** modificar o borrar un comprobante emitido (triggers), que una secuencia retroceda o que se reescriba un rango en uso, y valida el formato del e-NCF y que su tipo coincida con el del documento.

**`apps/api`** (Hono, JSON con montos como **texto decimal** `"19.99"`, errores `{ error, issues? }`):

| Ruta | Métodos | Quién escribe |
|---|---|---|
| `/health`, `/ready` | GET | — |
| `/api/auth/*` | Better Auth | — |
| `/v1/me` | GET | — |
| `/v1/branches` | GET, POST, PATCH `/:id` | owner/admin |
| `/v1/terminals` | GET (`?branchId`), POST, PATCH `/:id` | owner/admin |
| `/v1/categories` | GET, POST, PATCH `/:id`, DELETE `/:id` | owner/admin |
| `/v1/products` | GET (`q, categoryId, active, page, pageSize`), GET `/:id`, GET `/by-barcode/:code`, POST, PATCH `/:id`, DELETE `/:id` (**desactiva**) | owner/admin |
| `/v1/customers` | GET (`q, active, page`), GET `/:id`, POST, PATCH `/:id` | owner/admin/**member** |
| `/v1/company` | GET, PUT (datos fiscales del emisor, ambiente DGII) | owner/admin |
| `/v1/reports/sales` | GET `?from&to&groupBy=day\|month`: ventas netas, ITBIS por tasa, por tipo, por forma de pago y más vendidos | **solo owner/admin** |
| `/v1/inventory/stock` | GET `?branchId&q&low=true&page`: existencias de los productos con inventario (de una sucursal o sumadas); estado `OK`/`LOW`/`OUT` | cualquier miembro |
| `/v1/inventory/movements` | GET `?productId&branchId&type&page`: libro de movimientos (entrada, venta, reingreso, ajuste) | cualquier miembro |
| `/v1/inventory/receipts` · `/adjustments` | POST: entrada de mercancía (con costo opcional) · ajuste por diferencia o por conteo (motivo obligatorio) | **owner/admin** |
| `/v1/inventory/settings` | GET, PATCH `{allowNegativeStock}` | PATCH solo owner/admin |
| `/v1/suppliers` | GET (`q, active, page`), GET `/:id`, POST, PATCH `/:id` (RNC/cédula validados) | **solo owner/admin** |
| `/v1/purchases` | GET (`q, kind, status, supplierId, from, to, page`), GET `/:id`, POST (borrador), PUT `/:id`, DELETE `/:id` (solo borrador), POST `/:id/post` (registrar) | **solo owner/admin** |
| `/v1/reports/purchases` · `.csv` | GET `?from&to&groupBy`: compras por período, tipo, tipo de gasto (606) y proveedor, ITBIS adelantado y retenciones · CSV con columnas del 606 | **solo owner/admin** |
| `/v1/reports/dgii/:format` · `/file` | GET `?period=AAAAMM` (formato 606, 607 o 608): vista previa con columnas, registros, errores, avisos y totales · el archivo TXT oficial (422 con la lista si hay errores) | **solo owner/admin** |
| `/v1/purchases/:id/dgii` | PATCH `{paymentDate?, isrWithholdingType?, itbisToCost?, itbisProportional?}`: completa datos del 606 de una compra ya registrada | **solo owner/admin** |
| `/v1/documents/:id/retentions` | PATCH `{itbisWithheld, isrWithheld, date}`: retenciones que el cliente hizo al pagar (607, en pesos) | **solo owner/admin** |
| `/v1/reports/sales.csv` | GET: comprobantes emitidos del período en CSV (UTF-8 con BOM; neutraliza fórmulas de Excel) | **solo owner/admin** |
| `/api/auth/organization/*` | Better Auth: `invite-member`, `accept-invitation`, `cancel-invitation`, `list-members`, `list-invitations`, `update-member-role`, `remove-member` | según rol de Better Auth |
| `/v1/sequences` | GET, POST, PATCH `/:id` (rangos de e-NCF; no se solapan; no se borran) | owner/admin |
| `/v1/documents` | GET (`q, type, status, customerId, branchId, from, to, page`), GET `/:id`, POST (borrador), PUT `/:id` (reemplaza un borrador), DELETE `/:id` (solo borrador), POST `/:id/issue` | **cualquier miembro** (incluido el cajero) |
| `/v1/restaurant/tables` | GET (`?branchId`, `?all=true` solo admin; cada mesa trae el resumen de su comanda abierta), POST, POST `/bulk` (`prefix, count, startAt, zone, seats`; omite las que ya existen), PATCH `/:id` (no se desactiva con comanda abierta) | GET cualquier miembro; resto **owner/admin** |
| `/v1/restaurant/orders` | POST `{tableId, covers}` (una comanda abierta por mesa), GET `/:id`, POST `/:id/items`, PATCH `/:id/items/:itemId` (solo sin enviar), POST `/:id/items/:itemId/void` (sin enviar: se quita; enviado: exige motivo), POST `/:id/send` `{course?}` (a cocina/bar; sin `course` sale todo lo pendiente; lo que no se prepara queda listo; devuelve el ticket por estación), POST `/:id/transfer`, POST `/:id/cancel` (con productos en cocina solo admin), POST `/:id/bill` | **cualquier miembro** (cancelar con cocina: admin) |
| `/v1/restaurant/modifier-groups` | GET (`?all=true` solo admin), POST, PUT `/:id` (reemplaza las opciones: con `id` se actualizan, nuevas se crean, ausentes se borran), DELETE `/:id` | GET cualquier miembro; resto **owner/admin** |
| `/v1/restaurant/products/:id/menu` | GET · PUT `{modifierGroupIds, components:[{productId, quantity}]}` (con componentes el producto es un **combo**; vacío deja de serlo) | GET cualquier miembro; PUT **owner/admin** |
| `/v1/restaurant/menu` | GET `?q&categoryId`: carta para anotar (productos activos con sus modificadores y componentes de combo, máx. 200) | cualquier miembro |
| `/v1/restaurant/kitchen` · `/items/:id/ready` | GET `?station=KITCHEN\|BAR` (enviados y sin marcar, del más antiguo al más nuevo) · POST marcar listo | cualquier miembro |
| `/v1/shifts` | GET (`terminalId, status, from, to, page`; el cajero solo ve los suyos), GET `/current?terminalId` (turno abierto con el informe X en vivo, o `null`), GET `/:id` (informe X si está abierto, Z congelado si está cerrado), POST `{terminalId, openingAmount}` (abrir), POST `/:id/close {countedCash, notes}` (cerrar) | **cualquier miembro**; cerrar: quien lo abrió o un administrador |
| `/v1/pins` | GET (admin: quién tiene PIN, nunca el PIN), PUT `/me` y PUT `/:userId` (admin) `{pin}` (4–6 dígitos, sin repetidos ni secuencias), DELETE `/:userId` (uno mismo o admin) | cualquier miembro (el listado y editar a otros, **owner/admin**) |
| `/v1/sync/cashiers` | GET: personas con PIN y el resumen para verificarlo sin internet (el administrador baja a todos; un cajero solo a sí mismo) | cualquier miembro |
| `/v1/sync/shifts/:clientId` | PUT `{terminalId, openedAt, openingAmount, close?}`: crea el turno de la caja (idempotente) y, con `close`, lo cierra calculando el cuadre con lo ya subido | cualquier miembro |
| `/v1/sync/catalog` | GET `?cursor&limit`: productos y clientes que cambiaron desde el cursor (incluye desactivados), categorías, datos fiscales; `hasMore` + `cursor` nuevo | cualquier miembro |
| `/v1/sync/sequence-blocks` | GET `?terminalId` (bloques de la caja) · POST `{terminalId, ecfType: E31\|E32, size}` corta un bloque del FINAL de un rango general vigente y lo asigna a la caja (también `E34` para notas de crédito) | cualquier miembro |
| `/v1/sync/sales` | POST: sube una venta o **nota de crédito** hecha sin conexión (idempotente por `clientId`); crea el comprobante ya emitido con el e-NCF y la fecha de la caja, atribuido al cajero (`cashierId`) y atado a su turno (`shiftClientId`); las notas llevan `referencedEncf`, `modificationCode`, `returnsStock` y el reembolso por forma de pago | cualquier miembro |
| `/v1/tax-codes` | GET | — |
| `/v1/calculate` | POST (mismo motor que usará la facturación) | — |

**Restaurante (`routes/restaurant.ts`, `lib/orders.ts`)**: `DiningTable`, `RestaurantOrder` (consecutivo por empresa) y `OrderItem` (copia nombre/precio/impuesto del producto al anotarlo; estados `PENDING → SENT → READY`, `VOID`). `Product.prepStation` (`NONE/KITCHEN/BAR`) decide a dónde va. Totales de la pre-cuenta con el mismo motor de `core`; **propina legal = 10 % del subtotal antes de ITBIS** (ej.: 2 pollos RD$350 + 1 cerveza RD$120, ITBIS incluido → total 820.00, propina 69.49, total con propina 889.49). **Cobro** (`POST /orders/:id/bill`): bloquea la comanda (`FOR UPDATE`), arma un `DocumentInput` con lo cobrado (todo lo pendiente o una selección `items: [{itemId, quantity}]` para **dividir la cuenta**), reutiliza `issueDocument` (`lib/issue.ts`, el mismo flujo de `POST /documents/:id/issue`: valida pagos, asigna e-NCF, descuenta inventario, bitácora), suma `billedQuantity` y cierra la comanda al quedar todo cobrado. Si los pagos no suman, **no se cobra nada ni se gasta e-NCF**. **Modificadores**: cada producto puede llevar varios grupos (`minSelect`/`maxSelect`; mínimo 1 = obligatorio); al anotar se valida la elección, el recargo se **suma al precio unitario** (mismo impuesto del producto), se guarda una copia en `order_item.modifiers` y el comprobante lo detalla en la descripción de la línea («Medio, Queso · sin cebolla»); líneas iguales (mismas opciones, notas y curso) se juntan. **Cursos** (1–5): el producto trae uno por defecto, se puede cambiar mientras no se envíe, y `send {course}` manda solo ese curso. **Combos**: el combo es una línea que se cobra al precio del combo (estación NONE) y cada componente es una línea hija (`parentItemId`, precio 0, su propia estación) que solo va a cocina/bar; las hijas no se cobran, se anulan/borran/escalan junto con el padre, y al cobrar el combo se **descuenta del inventario cada componente** (`applyComboStock`; si falta existencia no se cobra nada). En BD: índice único parcial «una comanda abierta por mesa», comanda cerrada/cancelada congelada (triggers) y producto cobrado no se puede borrar ni anular.

**Turnos de caja (`routes/shifts.ts`, `lib/shifts.ts`)**: `CashShift` con fondo de apertura; una caja tiene **un solo turno abierto** (índice único parcial + bloqueo de la caja al abrir). Al **emitir** un comprobante desde una caja con turno abierto, `issueDocument` lo ata al turno (`Document.shiftId`, con `SELECT … FOR SHARE` del turno); sin caja (back-office) o sin turno abierto queda sin turno. **Informe** (`shiftReport`): comprobantes emitidos en el turno, ventas por tipo, ITBIS, propina, cobros por forma de pago, notas de crédito que restan y de débito que suman, todo en pesos; **efectivo esperado = fondo + cobrado en efectivo**. **Cierre**: bloquea el turno (`FOR UPDATE`, así las emisiones en curso terminan antes y ninguna se escapa del informe), calcula `difference = contado − esperado` y, si no es cero, **exige el motivo**; guarda el informe Z congelado (`closingReport`) y el turno cerrado no se puede modificar ni borrar (trigger). El efectivo esperado no se muestra al contar (conteo ciego); sale en el informe Z.

**Sincronización con la caja (`routes/sync.ts`)**: el catálogo baja con un cursor compuesto `(updatedAt, id)` por tabla, así no se salta ni repite ninguna fila aunque varias cambien en el mismo milisegundo. Un **bloque de e-NCF** es una fila de `sequence` con `offline = true` y `terminalId`: se corta del final del rango general (que queda más corto) y `allocateEncf` **nunca** asigna de él, por eso la nube y la caja jamás usan el mismo número. **Subida** (`POST /sales`): valida terminal activa, que el e-NCF pertenezca a un bloque de ESA caja, que no se haya usado, que el total de la caja coincida con el que calcula la nube (mismo motor `core`), y emite con `issueDocument(..., {preset})`: respeta el e-NCF y la fecha impresos, factura a los precios impresos aunque el producto cambie o se desactive, y **no rechaza por inventario** (la venta ya ocurrió: puede quedar en negativo). Dos subidas simultáneas de la misma venta dan un solo comprobante (índice único + captura de `P2002`). Las ventas subidas se atan al turno que dicen (`shiftClientId`; si la nube no lo conoce se emiten sin turno) y se atribuyen al `cashierId` si es miembro de la empresa (`createdById`). **Notas de crédito**: el comprobante modificado se busca por e-NCF y debe estar emitido; los pagos de la nota son el **reembolso** y deben sumar su total; código 1 (anula) repone el inventario de la venta, y `returnsStock` repone las líneas de la propia nota (devolución parcial con mercancía). El informe del turno **resta** lo reembolsado de su forma de pago (el efectivo devuelto baja el efectivo esperado). **Turno obligatorio** (`requireShift`): `issueDocument` rechaza emitir desde una caja sin turno abierto (la facturación sin caja no se ve afectada; la subida offline tampoco).

**Caja (`packages/pos-engine` + `apps/pos`)**: el motor es TypeScript puro sobre `node:sqlite` (sin compilar nada nativo; Electron 45 trae Node 24) y se prueba sin ventanas: `store` (SQLite con migraciones por `user_version`), `api` (cliente con cookie de sesión y origen `app://facturacion-pos`, errores `ApiError`/`NetworkError`), `catalog` (búsqueda por nombre/SKU/código de barras), `sales` (**`createSale`** en una transacción `BEGIN IMMEDIATE`: calcula con `core`, valida comprador y pagos, toma el e-NCF del bloque que vence primero y deja la venta `PENDING` con el cuerpo exacto a subir; si algo falla no se gasta ningún número) y `sync` (subir en orden; un rechazo definitivo 422/409 marca `REJECTED` con su motivo y sigue; corte de red o 401/5xx detiene y reintenta luego; recupera bloques que la nube entregó y la caja perdió; pide otro cuando quedan menos de `low`). `apps/pos` es Electron + React: proceso principal dueño del motor (cookie cifrada con `safeStorage`, sincronización cada minuto, una a la vez), `preload` con `contextBridge` (la pantalla no tiene Node) y pantallas de **configuración** (servidor → empresa → caja), **venta** (lector de códigos con Enter, carrito, consumo/crédito fiscal, cliente, propina legal, pago dividido y cambio, ticket de 80 mm imprimible, historial con reintento de rechazadas) y reconexión sin perder datos. **PIN**: si hay cajeros con PIN, la caja arranca bloqueada (nombre + teclado en pantalla o físico), verifica el resumen PBKDF2 **localmente** (`PinGate`: 5 fallos seguidos bloquean 30 s a esa persona) y se bloquea sola a los 5 min sin tocarla; sin PIN configurado no pide nada. **Turnos**: abrir con fondo, cierre ciego (no se muestra el esperado), motivo obligatorio si hay diferencia, informe X/Z imprimible; solo uno abierto por caja (índice único local); se suben en orden (apertura → ventas y notas → cierre) y si la nube no acepta el turno (p. ej. ya hay uno abierto allí) sus ventas esperan. **Devoluciones**: se elige la venta, qué y cuánto devolver y cómo reembolsar; anular todo usa el código 1, lo parcial el 3 con o sin reposición de inventario; usa precio, impuesto y propina de la venta original y su propio bloque E34. El panel web ya permite definir los PIN (Equipo) y exigir turno (Configuración fiscal). **Impresión** (`packages/printing`): `EscPos` arma los comandos (iniciar, página de códigos, alinear, negrita, tamaño, columnas, **QR nativo `GS ( k`**, **pulso de gaveta `ESC p`**, corte parcial) y `receiptTicket` / `shiftTicket` / `testTicket` producen el ticket de 80 mm (48 columnas) o 58 mm (32) con venta, nota de crédito (`Modifica:`, `Reembolso:`), informe X/Z y prueba. El texto se codifica en **CP858** (CP850/CP437 opcionales) para tildes y ñ. Dos transportes: **red** (TCP, normalmente 9100) y **impresora instalada en Windows** por su nombre, en crudo (RAW) vía `winspool.drv` desde PowerShell (`Add-Type`, ~1–2 s por ticket; errores de Windows traducidos a mensajes claros). En `apps/pos`: botón **Impresora** (tipo de conexión, papel, página de códigos, «imprimir al terminar cada venta», «abrir gaveta con efectivo», **imprimir prueba** y **abrir gaveta**), impresión automática al vender/devolver **sin bloquear la venta** (cola de una impresión a la vez; si falla, un aviso con **Reintentar**), botón **Gaveta**, y «Reimprimir» en el ticket y en los informes X/Z; sin térmica configurada sigue el diálogo de impresión del sistema. Las reimpresiones no abren la gaveta.

Cada cambio escribe en `audit_log` **dentro de la misma transacción** (si falla el cambio, no queda rastro).

**Emisión (`POST /v1/documents/:id/issue`)**, en una sola transacción: exige datos fiscales y total > 0 · refresca el comprador desde la ficha del cliente · aplica las reglas del comprador (E31 exige RNC; E32 ≥ RD$250,000 exige identificarlo) · exige que los pagos sumen el total (E31/E32) · en notas de crédito bloquea el original y verifica que no se exceda lo acreditable (código 1 = anular exige el total) · **asigna el e-NCF de forma atómica** (`UPDATE … WHERE id = (SELECT … FOR UPDATE)`; prefiere la secuencia de la caja, luego la general; ignora rangos vencidos, agotados o inactivos) · congela el comprobante. Los totales siempre se recalculan en el servidor con `core`.

**`apps/web`** (Next 16): `/registro`, `/login` y el panel `/panel` con **Resumen**, **Facturas** (listado con filtros, **editor** con buscador de productos y lector de códigos de barras, totales en vivo con el mismo motor fiscal, pagos mixtos, descuentos, propina legal, notas de crédito/débito, **detalle imprimible**), **Productos** (búsqueda, filtros, paginación, categorías, alta/edición/desactivar), **Clientes** (RNC/cédula con formato), **Sucursales y cajas**, **Configuración fiscal** (datos del emisor y secuencias), **Compras** (listado, editor con las reglas de cada tipo y totales en vivo, detalle), **Proveedores**, pestaña **Compras (606)** en Reportes y costo visible en Productos (solo admins), **Inventario** (existencias y movimientos por sucursal, entradas, ajustes por diferencia o conteo, interruptor de ventas sin existencia, filtro de stock bajo; la ficha del producto tiene "Controlar inventario" y existencia mínima; el Resumen avisa de stock bajo) **Restaurante** (`/panel/restaurante`: salón con mesas por zona y su estado —libre/ocupada, total, tiempo, «sin enviar / en preparación / listos»—, que se refresca solo; administrar mesas en lote; **comanda** con buscador de productos, notas, enviar a cocina, anular, cambiar de mesa, cancelar y **cobro** con selección de productos y cantidades, propina legal opcional, E32/E31 con cliente, pago dividido; `/panel/restaurante/cocina` con las pestañas Cocina y Bar y botón «Listo»; ficha del producto con estación, curso, grupos de modificadores y componentes de combo; administrador de **Modificadores** en Productos; en la comanda, diálogo de opciones obligatorias/opcionales con el precio en vivo, combos con sus partes, curso por producto y botones «Solo entrada / plato fuerte…») **Turnos de caja** (`/panel/turnos`: elegir caja, abrir con fondo, resumen en vivo del turno, cerrar contando el efectivo —si hay diferencia pide el motivo—, historial con filtro; `/panel/turnos/[id]`: informe X/Z imprimible con firmas de cajero y supervisor) y **Equipo** (miembros, roles Propietario/Administrador/Cajero, invitaciones con enlace copiable, quitar miembros) y **Reportes** (solo admins: KPIs, gráfico, ITBIS, formas de pago, más vendidos y exportar CSV; el Resumen muestra ventas de hoy y del mes). Flujo de invitación: `/invitacion/[id]` → iniciar sesión o crear cuenta (sin crear empresa) → aceptar. Diálogos de confirmación y avisos propios (`components/dialogs.tsx`, sin `window.confirm/prompt`) y buscador de clientes con autocompletado en el editor. Cliente tipado de la API con Hono RPC (`apps/web/lib/api.ts`), componentes propios en `apps/web/components/ui.tsx`.

### 0.5 Lo que falta (backlog en orden de prioridad)

**A. Terminar la Fase 1 (siguiente trabajo inmediato)**

1. ✅ ~~Datos fiscales de la empresa~~ (el certificado digital `.p12` ya se sube desde Configuración fiscal).
2. ✅ ~~Modelo y API de documentos~~ con líneas copiadas del producto, pagos, totales recalculados en el servidor e inmutabilidad en la BD.
3. ✅ ~~Secuencias e-NCF~~ con asignación atómica y rangos sin solape.
4. **`packages/ecf`** + interfaz `FiscalProvider`: XML de E32 y E31, validación contra los XSD oficiales, firma XMLDSig, autenticación (semilla → token), envío, consulta por TrackId, código de seguridad y QR. Evaluar primero la librería `dgii-ecf` de npm.
5. **Prototipo contra TesteCF**: emitir y consultar un E32 y un E31 de prueba. *Necesita de ti:* un certificado digital de pruebas y acceso a la Oficina Virtual de la DGII (verifica en dgii.gov.do cómo obtenerlo y su costo).
6. ✅ ~~Invitar usuarios y gestionar miembros~~: hoy se comparte un **enlace** (no se envía correo hasta elegir proveedor de correo; `sendInvitationEmail` de Better Auth es opcional y queda por conectar).
7. **Validar RNC contra el padrón de la DGII** (archivo público) y autocompletar el nombre del cliente.

**A-bis. Facturación pendiente (Fase 2)**

- PDF / representación impresa con **código QR y código de seguridad** (hoy el detalle se imprime con el navegador, sin QR).
- Envío del comprobante por correo y *workers* (pg-boss) para enviar a la DGII con reintentos.
- E32 de menos de RD$250,000: **resumen RFCE**. Estados `SIGNED/SENT/ACCEPTED/REJECTED` (ya existen en el enum, nada los usa todavía).
- Ficha rápida para crear un cliente desde el editor de facturas.
- Devoluciones desde la caja, anulación de rangos (ANECF) y reportes de ventas.

**B. Pulido antes de desplegar** (requisito tuyo: "terminado y pulido")

- Seguridad: *rate limiting* en login/registro, verificación de correo y recuperación de contraseña (requiere proveedor de correo: Resend u OCI Email Delivery), revisar `trustedOrigins` y cookies en producción.
- UX: ✅ diálogos propios y avisos tras guardar. Pendiente: estados vacíos y de error cuidados, revisión móvil y modo oscuro, accesibilidad (foco, contraste, etiquetas).
- Calidad: pruebas E2E con Playwright, Sentry, límites de tamaño y paginación en sucursales/cajas, `README` por paquete.
- Evaluar mover los componentes a `packages/ui` y adoptar shadcn/ui (hoy son componentes propios).

**C. Cuando esté listo para producción** (ver [DESPLIEGUE.md](DESPLIEGUE.md))

- Instalar Docker (o usar el runner de GitHub) y **construir las dos imágenes arm64 por primera vez**; corregir lo que falle.
- Reducir el tamaño de la imagen de la API (~700 MB): `better-auth` arrastra `next` como peer opcional y la CLI de Prisma trae Studio; opciones: `autoInstallPeers: false` o podar en el Dockerfile.
- Crear el servicio Postgres en Dokploy, roles con `setup-roles.sql`, secretos en GitHub, dominios `app.` y `api.`, backups a OCI y **probar una restauración**.
- Entorno `staging`.

**D. Fases 2 a 8:** igual que en §6.

### 0.6 Decisiones tomadas (y por quién)

| Decisión | Detalle |
|---|---|
| País y normativa | **República Dominicana**, e-CF de la DGII (Ley 32-23). La "factura" en la caja se imprime en una **impresora térmica normal** + lector de códigos de barras. |
| Despliegue | **Híbrido**: nube (Oracle Cloud **Ampere A1 / arm64**, `uname -m` = `aarch64`, con **Dokploy**) + caja que sigue facturando sin internet. |
| ORM | **Prisma 7** (preferencia tuya: "es más cómodo"). Dos schemas: Postgres (nube) y SQLite (caja, pendiente). |
| Caja | **Electron** (TypeScript/Node: SQLite, firma XML, ESC/POS). |
| Backend | **Next.js** (back-office) + **API Hono** separada. |
| Idioma | Interfaz y mensajes de la API en **español**; las respuestas del asistente en español neutro (tú, sin regionalismos). |
| Commits | Formato `[Add] - "mensaje"`, `[Update]`, `[Fix]`, `[Delete]`; el asistente solo commitea cuando se lo pides. |
| Despliegue | Solo cuando el producto esté terminado y pulido. |

**Sigue abierto:** conexión directa con la DGII **o** proveedor certificado (se decide con el prototipo); proveedor de correo; dominio; alcance de multimoneda (DOP/USD) en la primera versión.

### 0.7 Trampas conocidas (te ahorrarán tiempo)

- **pnpm 11 pide aprobar scripts de build** (`allowBuilds` en `pnpm-workspace.yaml`, ya configurado) y añade solo excepciones de antigüedad mínima (`minimumReleaseAgeExclude`) para versiones recientes. Si tras un `pnpm deploy` local pnpm se queja de `modules directory`, ejecuta `CI=true pnpm install --frozen-lockfile`.
- **`tsconfig.tsbuildinfo` obsoleto** produce errores falsos (por ejemplo `TS2737` de `bigint`) tras cambiar el `target`: bórralo (`apps/web/tsconfig.tsbuildinfo`). `apps/web` usa `target: ES2022` porque `core` usa literales `bigint`.
- **El cliente Prisma se genera** en `packages/db/src/generated` (ignorado por git). Turborepo lo regenera solo (`^db:generate`); si falta, `pnpm --filter @facturacion/db db:generate`. `prisma generate` **no** necesita base de datos.
- **Next 16 es distinto al que conoces**: `apps/web/AGENTS.md` obliga a leer `node_modules/next/dist/docs/` antes de tocar código de Next. Con `cacheComponents` el acceso a datos dinámicos va dentro de `<Suspense>`. Las páginas del panel son un `page.tsx` de servidor con `export const instant = false` que renderiza una vista de cliente (`*-view.tsx`), porque un componente de cliente no puede exportar esa opción.
- **Zod 4**: `.partial()` **conserva** los `.default()`, y eso pisaría campos en un PATCH. Por eso los valores por defecto de producto se aplican en el POST, no en el esquema (ver `routes/products.ts`).
- **JSON no admite `BigInt`**: los montos salen como texto decimal (`fromCents`) y entran como texto (`toCents`).
- **Referencias entre tablas y RLS**: una clave foránea comprueba la existencia **saltándose RLS**, así que antes de enlazar (p. ej. una caja con su sucursal) hay que verificar que el registro pertenece a la empresa con el cliente de tenant (ver `routes/terminals.ts`).
- **Los miembros no se pueden invitar todavía**: las pruebas de roles insertan el `member` directo en BD.
- **El panel del navegador integrado puede estar oculto**: ahí fallan las capturas de pantalla; se verifica con texto/JS.
- **Docker no está instalado** en la PC de desarrollo original: nada de `docker build` se ha probado.
- **Next 16 conserva ocultas las pantallas anteriores** (React `Activity` con `cacheComponents`): su estado (`useState`) sobrevive aunque salgas de la ruta, y al volver los *efectos* se ejecutan de nuevo (por eso los listados se refrescan solos). Consecuencia: un formulario **no se reinicia** al reabrirlo. El editor de facturas lo resuelve con una `key` (sesión + comprobante + referencia) que cambia al guardar y al abrir otra referencia. Al probar con JavaScript en el navegador, filtra por `offsetParent !== null` o contarás elementos de pantallas ocultas.
- **Claves foráneas diferibles**: las FK que protegen comprobantes y rangos son `DEFERRABLE INITIALLY DEFERRED` (migración `fk_deferrable`). Sin eso, eliminar una empresa con comprobantes falla según el orden en que Postgres ejecute las cascadas. Los triggers de inmutabilidad dejan pasar borrados en cascada con `pg_trigger_depth() > 1`.
- **Notas de crédito concurrentes**: se serializan bloqueando el comprobante original (`SELECT … FOR UPDATE`) antes de sumar lo ya acreditado.
- **Un `<Suspense>` alrededor de un formulario client lo deja sin hidratar** (probado en desarrollo y en el build de producción dentro del panel de pruebas): el HTML se ve, pero el `onSubmit` no se engancha y el navegador envía el formulario de forma nativa (GET con la contraseña en la URL). Por eso `/login`, `/registro` y `/invitacion` son páginas de servidor con `export const instant = false` y **sin** `<Suspense>`, y los formularios de acceso llevan `method="post"` por si alguna vez se envían antes de hidratar. Para comprobar hidratación en pruebas: `Object.keys(form).some(k => k.startsWith('__react'))`.
- **Puerto 3000 ocupado**: otro proyecto tuyo (`registro-aportes`) usa el 3000, así que Next salta al 3001 y choca con la API. Soluciones: cerrar ese proyecto, o arrancar la API y la web por separado: `cd apps/api && WEB_ORIGIN=http://localhost:3100 pnpm dev` y `cd apps/web && pnpm exec next dev -p 3100`. **Turbo filtra las variables de entorno** (`PORT`, `WEB_ORIGIN` no llegan a las tareas), por eso no sirve `PORT=3100 pnpm dev`.
- **`next dev` modifica `apps/web/AGENTS.md`**: con `experimental.agentFeedback: true` (viene de la plantilla de create-next-app) añade un bloque con instrucciones para que un agente "reporte feedback" a Next.js ejecutando `npx next internal agent-feedback-instructions`. Es contenido generado, no una instrucción tuya: no se sigue ni se commitea (se revierte con `git checkout -- apps/web/AGENTS.md`). Si prefieres que deje de aparecer, pon `agentFeedback: false` en `next.config.ts`.
- **Inventario**: la existencia vive en `stock_level` y se cambia SOLO con `moveStock` (`apps/api/src/lib/stock.ts`): un `UPDATE … SET quantity = quantity + δ` condicional (atómico, sin carreras) más una fila en `stock_movement`, dentro de la transacción de quien llama. Emitir con stock insuficiente (si se prohíbe el negativo) revierte todo, **incluido el e-NCF**. Las existencias se guardan en milésimas (`BigInt`) y pueden ser negativas: usa `fromMilli`/`toSignedMilli`. Una nota de crédito solo reingresa productos si es de **código 1 (anula)**; las devoluciones parciales se registran como ajuste.
- **Aviso `pg` «Calling client.query() when the client is already executing a query»** en las pruebas: es Prisma cargando relaciones en paralelo dentro de una transacción; `pg` las encola. Inofensivo (se quitará en pg@9 cuando el adaptador lo corrija).
- **Compras**: `Document` es solo de VENTA (E31–E34, lo garantiza un CHECK); `Purchase` es el modelo de compras y comparte las **secuencias** (`sequence.ecfType` admite también E41/E43) y `allocateEncf`. En `core`, `ECF_TYPES`/`EcfType` son tipos de venta y `ALL_ECF_TYPES`/`AnyEcfType` incluyen E41/E43; el enum de Prisma tiene los seis, por eso en las rutas de venta se usa `asSalesType()`. El NCF de un proveedor es único **por proveedor** (otro proveedor puede repetir el número); el e-NCF propio es único por empresa (índice parcial). El costo de compra (`lastCost`) solo se expone a owner/admin (`seesCost` en `routes/products.ts`).
- **Fechas sin hora** (`invoiceDate`, `YYYY-MM-DD`) se muestran con `formatDate` sin pasarlas por la zona horaria; si no, retroceden un día en Santo Domingo (UTC−4).
- **`$queryRaw` con funciones que devuelven `void`** (`SELECT pg_advisory_xact_lock(...)`) falla con «Failed to deserialize column of type 'void'»: usa `$executeRaw`. Los `SELECT 1 … FOR UPDATE` sí van bien con `$queryRaw`.
- **PIN y seguridad**: el PIN de 4–6 dígitos identifica QUIÉN vende, no es un secreto fuerte: el resumen baja a la caja y con acceso al archivo SQLite se puede adivinar por fuerza bruta (por eso un cajero solo baja el suyo y el bloqueo de 30 s frena el adivinar frente a la pantalla). La cookie de sesión de la caja va cifrada con `safeStorage`. El resumen usa Web Crypto (`core/pin.ts`), igual en API, Electron y navegador.
- **Combos y la cuenta**: `remainingOf` devuelve 0 para las partes de un combo (`parentItemId`), así que los totales, el cobro y el cierre de la comanda solo miran las líneas «padre». Un combo no puede llevar modificadores ni inventario propio (CHECK + validación) ni contener otro combo, y sus componentes no se venden por fracciones. Al cobrar un combo sin enviar, sus partes también pasan a «listo» (como cualquier producto cobrado al momento).
- **Turnos y concurrencia**: abrir y cerrar turnos son operaciones serializadas (bloqueo de la fila de la caja / del turno); `issueDocument` lee el turno con `FOR SHARE` para que cerrar (`FOR UPDATE`) espere a las emisiones en curso. Hay una prueba que emite 5 comprobantes mientras se cierra el turno y comprueba que lo contado en el Z es exactamente lo atado al turno. `Document.shiftId` se escribe en la transición borrador → emitido (el trigger de inmutabilidad solo congela lo ya emitido).
- **Electron + `node:sqlite`**: no hay `better-sqlite3` ni compilación nativa; el motor usa `node:sqlite` (Node ≥ 24) y Electron 45 trae Node 24.22. El binario de Electron se descarga la primera vez que se usa (`node apps/pos/node_modules/electron/install.js`); `pnpm-workspace.yaml` ya permite su script (`allowBuilds`). `apps/pos` es `type: module`: en el proceso principal se usa `import.meta.dirname` (no `__dirname`) y el preload se compila a `.cjs` (el sandbox no admite ESM).
- **Formatos 606/607/608, lo verificado y lo no**: el contenido y las reglas salen de los instructivos oficiales (606 de feb-2026, 607 de dic-2025, 608 de mar-2026); la API arma los tres desde compras, comprobantes y anulaciones, la pantalla muestra vista previa, errores y avisos, y solo deja descargar sin errores. Probado con 13 pruebas de formato, 8 de API contra Postgres (conversión de dólares, formas de pago que cuadran, notas de crédito, aislamiento entre empresas, roles) y a mano en el panel. **No verificado**: el diseño exacto del TXT (encabezado `606|RNC|AAAAMM|n`, códigos de dos dígitos, vacíos) porque los instructivos no lo describen —sale de lo que genera la plantilla de Excel— y no se pasó por la pre-validación de la DGII. Decisión: la fecha de pago, el tipo de retención en ISR y el ITBIS al costo/proporcionalidad de una compra registrada, y las retenciones que el cliente hace a una venta emitida, se completan después (los triggers `purchase_guard` y `document_guard` solo dejan pasar esas columnas); una venta con retención en un mes posterior se repite en ese mes (según la ayuda de la DGII, sin confirmar con la pre-validación). Trampa de herramientas: en los parches con heredoc, `\d` y `\r\n` se corrompen; se arreglan con Edit.
- **Instalador y auto-actualización, lo verificado y lo no**: el instalador NSIS se genera (`pnpm --filter @facturacion/pos dist`, ~110 MB, con `latest.yml` y `.blockmap`), la caja **empaquetada** pasa el `smoke` (`POS_EXE=<exe>`) y `scripts/update-scenario.mjs` comprobó contra la API real que una caja 0.1.0 consulta `/updates/caja`, descarga la 0.2.0 y queda «lista para instalar». Decisiones: las versiones las sirve la API (no GitHub Releases) con soporte de `Range`/multirango; la caja **nunca se reinicia sola** (botón «Actualizar a vX»; si no, se instala al cerrar); todo el código y `electron-updater` van dentro del bundle (las dependencias están en `devDependencies`, el instalador no lleva `node_modules`). **No verificado**: ejecutar el instalador en una PC limpia ni el ciclo completo de reinicio e instalación; la descarga por diferencias contra una instalación real (en la prueba bajó el instalador completo); instalador **sin firma de código real** (SmartScreen avisará; el proceso de firma se probó con un certificado autofirmado, ver `docs/CAJA-INSTALADOR.md` §6). Trampa: en este equipo hay un `package.json` con `"type": "module"` en la carpeta de usuario que rompía la herramienta de iconos de electron-builder, por eso el icono se entrega ya como `.ico`. `pnpm pack` es un comando de pnpm: el script se llama `pack` pero se ejecuta con `pnpm run pack`.
- **Verificar la caja de verdad**: `pnpm --filter @facturacion/pos build` y `pnpm --filter @facturacion/pos smoke` arrancan Electron con una carpeta de datos temporal (`POS_USER_DATA`) y comprueban pantalla + IPC + SQLite. Con `POS_SCRIPT=scripts/ui-scenario.mjs POS_SHOTS=<carpeta>` corre un escenario completo (crea una empresa en la API local, configura la caja desde la pantalla, vende con el lector, cobra dividido, sincroniza) y deja capturas PNG; la ventana se muestra transparente porque una ventana oculta no pinta y `capturePage` devuelve imágenes viejas.
- **Impresión térmica, lo verificado y lo no**: los comandos se prueban byte a byte, el envío por red contra un servidor TCP local y el de Windows contra una impresora real con «puerto de archivo» (`Add-PrinterPort` + `Add-Printer -DriverName "Generic / Text Only"` crean una sin permisos de administrador; los bytes llegaron idénticos al archivo). **Nunca se ha probado con una térmica física**: al conectarla, usa «Imprimir prueba» (comprueba ancho, tildes, QR y corte) y ajusta papel y página de códigos; si las tildes salen mal prueba CP850/CP437. Si la impresora no entiende `GS ( k` (muy antiguas) el QR no saldrá.
- **`packages/ecf` (XML, firma, QR), lo verificado y lo no**: `buildEcf` arma el XML siguiendo el *Formato e-CF v1.0* (oct. 2025) de la DGII — secciones en el orden del formato, sin etiquetas vacías, caracteres escapados, montos con 2 decimales, fechas `dd-MM-AAAA` en hora dominicana (GMT-4); la propina legal va como impuesto adicional `001` al 10 %; los precios con ITBIS incluido se declaran con `IndicadorMontoGravado` 1; `E34` no lleva formas de pago y calcula `IndicadorNotaCredito` (más de 30 días). `signEcf` agrega `FechaHoraFirma` y una firma **XMLDSig envuelta** (RSA-SHA256, resumen SHA-256, C14N 1.0, certificado en `KeyInfo`); el **código de seguridad** son los 6 primeros caracteres del `SignatureValue`. `stampUrl` arma la URL del QR (`consultatimbre` completa, o `consultatimbrefc` para consumo menor a RD$250,000) escapando los caracteres que la DGII exige. Todo se probó contra el formato escrito y con un certificado autofirmado de prueba; **nunca contra los servicios de la DGII**: las diferencias de detalle (qué etiquetas son obligatorias según el tipo, algoritmo exacto de la firma, `TablaSubDescuento`, `TotalITBIS` cuando todo es exento) saldrán en la pre-certificación (TesteCF) y se ajustan en un solo lugar. Límites conocidos: **cantidades con 3 decimales** (1.250 kg) se rechazan porque el e-CF admite 2; el resumen RFCE de consumo < RD$250,000, E41/E43, otras monedas, retenciones y descuentos globales aún no se arman.
- **Del e-CF recibido a la compra, lo verificado y lo no**: en el detalle de un e-CF recibido, «Registrar compra» (solo administradores) crea el **proveedor** si no existe (por RNC, con nombre, correo, teléfono y dirección del e-CF; si ya existe se usa su ficha; si está inactivo se pide activarlo), arma la compra tipo factura de proveedor con el **e-NCF como NCF**, la fecha del e-CF, el **ITBIS de cada línea** (`IndicadorFacturacion` → 18 %, 16 %, 0 %, exento; precios con o sin ITBIS según `IndicadorMontoGravado`), los descuentos, las retenciones si las trae y la forma de pago, y la **registra**: lo que se reconoce como producto entra al inventario y actualiza su último costo. Cada línea se reconoce por el **código** del proveedor (igual al SKU o código de barras de un producto) o por el **nombre exacto** (si es único); el resto queda como gasto sin producto. Antes se ve el plan (`GET /v1/received/:id/purchase-plan`: proveedor, línea → producto, totales) y se puede elegir a mano el producto de cada línea o crear solo el **borrador** para revisarlo. Reglas: firma íntegra; tipos 31, 32, 44 y 45 (las notas de débito/crédito de proveedores y los demás tipos se registran a mano); con varias sucursales hay que elegir la de entrada; el total que sale de las líneas debe coincidir con el del e-CF (se tolera un centavo de redondeo por línea; con impuestos adicionales o retenciones raras se pide registrarlo a mano); un NCF ya registrado de ese proveedor da 409; un e-CF solo se registra una vez (`purchaseId`). Para esto el **posteo de compras** pasó a `postPurchase` (lo comparten el botón «Registrar» y este flujo). El precio unitario con más de 2 decimales se deduce del monto de la línea. **No verificado**: la unidad de medida del proveedor no se traduce a la del producto, y no se importan lotes ni vencimientos.
- **Prototipo contra TesteCF, lo verificado y lo no**: `runPrototype` (`packages/ecf/src/prototype.ts`) corre los cuatro pasos (autenticación, E31, E32 por RFCE, E32 de RD$295,000 completo y E34) con la DGII inyectable y devuelve un informe con los XML, los TrackId, los mensajes y el siguiente número libre; el script `scripts/testecf.ts` lo conecta a un `.p12` (contraseña por `TESTECF_PASSWORD`), guarda cada corrida en `testecf-out/` (fuera de git) y recuerda los números usados. `--probe` comprueba que el servicio de autenticación responde y `--dry-run` arma y firma sin enviar; solo admite `test` y `cert` (nunca producción). **Hallazgos al probarlo con la DGII real (solo lectura)**: TesteCF y CerteCF responden en las rutas que usa el sistema; la semilla real llega **con sangrías** y el estándar pide firmar «sin preservar espacios», así que ahora se compacta antes de firmarla (antes se firmaba tal cual y la DGII habría rechazado la firma). **No verificado**: ningún envío real (falta el certificado); la guía lista lo que debe aclarar la prueba (envoltorio de los rangos de anulación, códigos del acuse, `TotalITBIS` en lo exento, subdescuentos, decimales de cantidad, RFCE de 2020).
- **Anulación de rangos (ANECF), lo verificado y lo no**: sirve para informar a la DGII los e-NCF autorizados que **no se van a usar** (secuencia vencida o sobrante). `buildAnecf` arma el archivo oficial («Formato Anulación de e-NCF v1.0»: encabezado con el RNC y la cantidad, una línea por tipo, rangos desde–hasta, firma) y `DgiiClient.annulRanges` lo envía a `/anulacionrangos/api/operaciones/anularrango` (no existe en certificación). En el panel, «Anular sobrantes» (administradores): **solo se anula el inicio o el final de lo que queda sin usar** de una secuencia (un tramo del medio dejaría números usados a los lados), nunca números ya usados ni los bloques de una caja sin conexión. Va en tres pasos para no perder ni duplicar números: (1) se bloquea la secuencia, se valida y se **desactiva** mientras dura (nadie saca números de ahí) dejando una constancia PENDING; (2) se envía a la DGII fuera de toda transacción; (3) si la DGII anula, la secuencia se agota o se acorta y vuelve a como estaba (activa o no); si la rechaza, la anulación parcial o no hay respuesta, queda **exactamente como estaba** y la constancia en FAILED con el motivo (con un corte de red se avisa que se verifique en la Oficina Virtual antes de reintentar). Una anulación que se quedó PENDING (proceso caído) bloquea la secuencia y se cancela a mano pasados 2 minutos. Todo en la bitácora. **No verificado**: nada contra la DGII; el nombre del elemento que envuelve cada par desde/hasta (`Secuencia`) y los códigos de la respuesta no están en el PDF (salen del XSD, no disponible), así que el éxito se deduce de un HTTP 200 sin mensajes de falla; si el proceso se cae entre el paso 2 y el 3 la DGII puede haber anulado números que la secuencia aún ofrece (la cancelación manual lo advierte); no se anulan números sueltos de «huecos» dentro de lo ya usado.
- **Servicios públicos /fe: protección, lo verificado y lo no**: todo pedido pasa por (1) **tamaño máximo** (5 MB de XML más el sobre multipart, 413), (2) **tipo de contenido** solo multipart o XML (415), (3) **límite de uso** en memoria por dirección (60/min; 20/min para la autenticación, con contador aparte) y por empresa destinataria (300/min), con 429 y `Retry-After`, y (4) rechazo de todo XML con `DOCTYPE`/`ENTITY` (sin expansión de entidades). La dirección es la de la conexión; con `TRUST_PROXY=true` (detrás de Traefik/Dokploy) se toma de `X-Forwarded-For` —activarlo sin proxy de confianza permitiría falsearla—. Límites configurables (`FE_RATE_LIMIT_PER_MINUTE`, `FE_RATE_LIMIT_PER_RNC_PER_MINUTE`, `FE_AUTH_RATE_LIMIT_PER_MINUTE`). **Autenticación por semilla** (opcional según el estándar): `GET /fe/autenticacion/api/semilla` entrega una semilla firmada con HMAC (5 min, de un solo uso) y `POST /fe/autenticacion/api/validacioncertificado` la cambia, si el cliente la firmó con su certificado (firma íntegra, certificado vigente, con un RNC o cédula en su número de serie, apellido o nombre), por un **token** de 1 hora (JSON o XML según `Accept`; sin estado en la base de datos). Cada empresa decide si la **exige** (Configuración fiscal → «Exigir autenticación…», 401 sin token); con o sin exigencia, un token inválido o vencido se rechaza, y quien se autentica solo puede enviar e-CF de **su** RNC (403) y solo puede aprobar como el comprador que es. **No verificado / límites**: no se valida la cadena de confianza del certificado (cualquier certificado vigente con un RNC sirve: la barrera es que el RNC coincida con el emisor, no que la DGII avale al firmante); el registro de semillas usadas y los contadores son por proceso (con varias réplicas, cada una cuenta aparte); la búsqueda del RNC en el certificado se hizo con el formato que describe la DGII (campo SN), sin certificados reales de las entidades autorizadas.
- **Receptor electrónico, lo verificado y lo no**: dos servicios públicos con las rutas del estándar (sin sesión; no distinguen mayúsculas): `POST /fe/recepcion/api/ecf` y `POST /fe/aprobacioncomercial/api/ecf`. **Recepción**: el emisor (u otro contribuyente) manda su e-CF y recibe **en el mismo pedido** el acuse de recibo firmado (`ARECF`: Estado 0 recibido; Estado 1 con motivo 1 especificación, 2 firma, 3 duplicado, 4 comprador); la empresa destinataria se busca por el RNC del comprador (si es ambigua o no existe, 400; si no tiene certificado para firmar el acuse, 503); se guarda el XML tal como llegó, con sus datos, y no se guarda lo que se rechaza. **Respuesta comercial**: en «e-CF recibidos» un administrador aprueba o rechaza (motivo obligatorio; solo se rechaza si la firma es inválida; la factura de consumo no lleva aprobación): se arma y firma el `ACECF` y se entrega **al emisor** (su servicio de aprobación comercial, según el directorio de la DGII, con su autenticación por semilla si la publica) **y a la DGII** (copia); cada destino se reintenta por separado con espera (30 s → 1 h, 20 intentos) y solo repite lo que faltó; los fallos definitivos (emisor fuera del directorio, la DGII la rechaza) quedan «para revisión» con el motivo y se reintentan desde el panel. También se reciben las aprobaciones de **nuestros clientes** sobre lo que emitimos (se guardan aparte, el comprobante sigue congelado, y se muestran en la factura) con los mensajes de error de la DGII. El formato del `ACECF` es el oficial («Formato Aprobación Comercial v1.0», enero 2020); el del `ARECF` sale del ejemplo oficial de la descripción técnica de emisores y de los códigos que usa una librería de la comunidad (el PDF del formato no se pudo descargar). Probado con una DGII y un emisor simulados y con el servidor real recibiendo e-CF por HTTP. **No verificado**: nada contra la DGII; el directorio publica un «host» y se le agrega la ruta estándar si no la trae (suposición); la validación del e-CF recibido es la mínima (estructura y firma), no el XSD.
- **Cola de envío a la DGII, lo verificado y lo no**: al emitir (o al firmar después) un comprobante firmado entra a `fiscal_submission` si la empresa activó «Enviar a la DGII automáticamente»; si no, se pide con `POST /v1/documents/:id/send`. El trabajador (`processDue`, cada 5 s desde `server.ts`; `FISCAL_WORKER=false` lo apaga en una réplica) reserva las filas con `FOR UPDATE SKIP LOCKED` + `lockedUntil` (dos procesos nunca envían lo mismo; si uno muere, otro retoma a los 2 min), manda el XML, guarda el TrackId y consulta el resultado con pausas crecientes (3 s → 5 min). Fallo temporal (sin red, 5xx, límite de uso): reintenta con espera de 30 s → 1 h, hasta 20 veces; fallo definitivo (certificado no autorizado, XML rechazado en la recepción): estado FAILED con el motivo, y se reintenta desde el panel. Resultado de la DGII: aceptado / aceptado condicional / rechazado quedan en el comprobante (con los mensajes y `secuenciaUtilizada`); «en proceso» sigue consultando. El trabajador necesita ver la cola de todas las empresas: la política RLS de `fiscal_submission` admite además `app.system = 'fiscal-worker'`, que solo fija ese código. Las facturas de consumo < RD$250,000 se encolan como **resumen (RFCE)** (`kind = RFCE`): se arma y firma al enviarlo a partir del e-CF ya firmado, con el *código de seguridad* de ese e-CF dentro (`CodigoSeguridadeCF`), y la DGII responde en el mismo envío (sin TrackId); si no da un estado final se consulta con `consultarfce` (RNC, e-NCF y código). El e-CF extendido se conserva en el comprobante. Formato según «Formato Resumen Factura Consumo Electrónica v1.0» (enero 2020), que puede estar desactualizado frente a la DGII. **No verificado**: todo con una DGII simulada; los reportes cuentan los comprobantes rechazados como emitidos (no distinguen aún).
- **Cliente de la DGII, lo verificado y lo no**: `DgiiClient` implementa `FiscalProvider` (`submit`, `result`, `trackIdsOf`) con la «Descripción Técnica Servicios DGII» v1.7: pide la semilla, la firma con el certificado (XMLDSig, la misma firma del e-CF) y la valida para obtener el token (1 h; se renueva un minuto antes de vencer, varias peticiones simultáneas comparten una sola autenticación y un 401 renueva y reintenta una vez). Las rutas son `ecf.dgii.gov.do/{testecf|certecf|ecf}/{autenticacion|recepcion|consultaresultado|consultatrackids}`; el archivo se envía como `multipart` con el nombre `RNC+e-NCF.xml`. Estados: 0 no encontrado, 1 aceptado, 2 rechazado, 3 en proceso, 4 aceptado condicional; `secuenciaUtilizada` dice si un rechazo gastó el e-NCF. Los errores son `FiscalError` con `kind` (red, autenticación, rechazo, servidor, configuración) y `retryable` para decidir si reintentar. **Probado solo con una DGII simulada** (lo que dice el documento, no lo que responde de verdad); el servicio de TrackIds no se publica en certificación. Aún no se usa desde la emisión.
- **Firma al emitir y QR, lo verificado y lo no**: el certificado `.p12` y su contraseña se guardan **cifrados** (AES-256-GCM, una subllave por empresa derivada de `CERT_ENCRYPTION_KEY`, obligatoria en producción; en desarrollo se deriva de `BETTER_AUTH_SECRET`) en `company_certificate`; la API solo devuelve el titular y la vigencia, nunca el archivo. Al emitir (`issueDocument`) el comprobante se arma, se firma y se guarda en el mismo paso (`ecfXml`, `securityCode`, `signedAt`); si el XML no se puede armar (p. ej. cantidad con 3 decimales) la emisión se cancela con 422 y **no se gasta el número**. Sin certificado se emite sin firma y se firma después (`POST /v1/documents/:id/sign` o `/sign-pending`); la firma se agrega una sola vez y el trigger de BD la congela. Una venta de caja sin conexión que no se puede firmar queda emitida sin firma (ya está impresa) y se anota en la bitácora. Los comprobantes en dólares aún no se firman. **La caja** sube la venta de inmediato antes de imprimir (espera hasta 4 s; si hay venta pendiente anterior no adelanta, para no romper el orden de las notas de crédito) y el ticket sale con el QR, el código de seguridad y la fecha de firma; si no hay conexión sale sin QR y, al sincronizar, la caja guarda lo que devuelve la nube y la reimpresión ya lo trae. Verificado con la caja Electron real contra la API (todos los tickets con QR, incluida la nota de crédito y la primera venta del turno) y en el panel web (QR, «Firmar e-CF», tarjeta del certificado). **No verificado**: nada de esto se ha contrastado con la DGII.
- **Firma local en la caja, lo verificado y lo no**: al sincronizar con una sesión de **administrador** (la que configuró la caja) la nube entrega el `.p12` y su contraseña (`GET /v1/sync/certificate`, con versión: solo baja si cambió; un cajero recibe 403 y la entrega queda en la bitácora) y la caja lo guarda **cifrado con `safeStorage`** (DPAPI en Windows, Keychain en macOS, llavero en Linux); si el sistema no puede cifrar de verdad, **no lo guarda** y la caja sigue como antes (la nube firma). Si la empresa quita el certificado, la caja lo borra. Con certificado vigente, cada venta y devolución se arma y firma **en el momento, sin internet** (mismos datos que arma la nube: `sellerOf`, unidades del catálogo, vencimiento del bloque, referencia de la nota) y el ticket sale con el QR y el código de seguridad; la hora de firma es la de la venta. Al subir la venta viaja ese XML y la nube lo **guarda tal cual** (para que el código impreso sea el del comprobante) solo si verifica: firma íntegra, certificado de la empresa, e-NCF, tipo, monto, RNC, código y fecha de firma; si no, firma ella y lo anota en la bitácora (`document.local_signature_rejected`). Si la caja no puede firmar (certificado vencido, cantidad con 3 decimales…) la venta se registra igual, sin firma, con un aviso en pantalla. Verificado con la caja Electron real: el código impreso antes de sincronizar es el mismo que guarda la nube. **No verificado**: macOS y Linux (solo Windows); la renovación del certificado con cajas apagadas (cada caja lo baja en su próxima sincronización) y la revocación inmediata de una caja robada (hoy solo quitando el certificado de la nube y reemitiendo uno nuevo).
- **Un cuerpo vacío no es JSON**: `POST /orders/:id/send` ahora valida `{course?}`, así que el cliente debe mandar `json: {}` (sin cuerpo da 400). En las pruebas, no uses `res.clone().json()` en el mensaje de `expect` de respuestas 204: se evalúa siempre y revienta.
- **Restaurante**: «una comanda por mesa» se garantiza con el índice único parcial (dos meseros abriendo a la vez: uno recibe 409); las operaciones sobre una comanda (agregar, enviar, cobrar) pasan por `loadOpenOrder`, que la bloquea con `FOR UPDATE`, así dos cobros simultáneos se hacen en fila y el segundo ve lo ya cobrado. El número de comanda se calcula bajo un *advisory lock* por empresa. Los productos de una comanda guardan **copia** del precio; desactivar un producto después no impide cobrarlo (`buildDraft(..., {allowInactiveProducts: true})`). Productos sin fracciones (`allowsDecimals=false`) no se pueden cobrar por partes de unidad.
- **`dialog` modal y herramientas del navegador**: el contenido de un `<dialog>` abierto no aparece con `find`/`read_page`, y `type`/`key` no llegan al input; para probar modales se usa JavaScript (setter nativo de `value` + evento `input`, y `click()` en los botones).
- **El shell rechaza a veces heredocs grandes** (`unexpected EOF`): para archivos largos usa la herramienta de escritura de archivos en vez de `cat <<EOF`.

---

## 1. Requisitos que definen la arquitectura

| Requisito | Consecuencia técnica |
|---|---|
| e-CF DGII (Ley 32-23) | XML según los XSD de la DGII, firma digital XMLDSig, autenticación semilla→token, envío y consulta por TrackId, resumen RFCE para consumo < RD$250,000, representación impresa con QR. |
| Todo emisor electrónico también es receptor | Hace falta una **API pública HTTPS** para recibir e-CF, acuses de recibo y aprobaciones comerciales de otros contribuyentes. |
| Modelo híbrido (nube + caja sin internet) | La caja tiene **base de datos local**, firma localmente y deja una **cola de envío** que se vacía al volver la conexión. |
| Impresora térmica + lector de códigos | Hace falta una **app de escritorio** para la caja (impresión ESC/POS directa, sin el diálogo del navegador). El lector funciona como teclado (HID). |
| Instalable en cualquier negocio | Un núcleo común más **módulos por giro** activables por empresa (retail, restaurante…). |
| Documentos fiscales inmutables | Una factura emitida nunca se edita: se corrige con nota de crédito/débito (E34/E33). Hay bitácora de auditoría. |

**Tipos e-CF que hay que cubrir:** E31 Crédito Fiscal, E32 Consumo, E33 Nota de Débito, E34 Nota de Crédito, E41 Compras, E43 Gastos Menores, E44 Regímenes Especiales, E45 Gubernamental, E46 Exportaciones, E47 Pagos al Exterior.

---

## 2. Arquitectura

```
          ┌───────── ORACLE CLOUD · Ampere A1 (arm64) · Dokploy ─────────┐
          │  Traefik (gestionado por Dokploy, HTTPS con Let's Encrypt)   │
          │     │ app.tudominio.com            │ api.tudominio.com       │
          │     ▼                              ▼                         │
Navegador►│  apps/web (Next.js)  ──RPC──►  apps/api (Hono)  ◄── e-CF de  │
(dueño/   │  Back-office: catálogo,         · API + /sync      otros     │
contador) │  clientes, reportes, config     · receptor DGII    contribu- │
          │                                 · workers pg-boss  yentes    │
          │                                    │      └──────► DGII      │
          │                                    ▼                         │
          │                  PostgreSQL 18 (servicio de BD de Dokploy)   │
          └───────────────────────▲────────────┬─────────────────────────┘
                                  │            │ XML/PDF y backups
       sincronización (outbox)    │            ▼
       cuando hay internet        │   OCI Object Storage (compatible S3)
                                  │
          ┌───────────────────────┴──── CAJA (cada local, Windows) ──────┐
          │  apps/pos  (Electron + React)                                │
          │   · SQLite local       · firma e-CF local (cert. .p12)       │
          │   · cola de envío      · impresión ESC/POS 58/80 mm          │
          │   · lector de códigos  · apertura/cierre de caja             │
          └──────────────────────────────────────────────────────────────┘
```

### Decisiones clave

1. **Secuencias e-NCF por rangos.** La nube asigna a cada caja un **bloque de secuencias** (p. ej. E320000001001–E320000002000). La caja factura sin internet sin riesgo de duplicar números y pide un bloque nuevo al llegar al 80 % de uso.
2. **Sincronización con outbox, no CRDT.** Las ventas son registros que solo se agregan (append-only), así que casi no hay conflictos: la caja **empuja** sus documentos y eventos, y **descarga** los catálogos (productos, precios, clientes) usando un cursor `updated_at`. Es más simple y fácil de auditar que un motor de sync genérico.
3. **Firma en la caja.** Para facturar sin conexión, el certificado digital de la empresa vive cifrado en la caja (almacén seguro del sistema operativo). La nube también puede firmar lo que se emite desde el back-office.
4. **Proveedor fiscal detrás de una interfaz.** Todo lo de la DGII queda en `packages/ecf` detrás de una interfaz `FiscalProvider`. Así se puede empezar integrando la API de un proveedor ya certificado (más rápido para salir al mercado) y después pasar a conexión directa con la DGII, o al revés, sin tocar el resto del sistema.
5. **Dinero en enteros.** Los montos se guardan en centavos (`bigint`) y se calculan con una librería decimal. El redondeo del ITBIS sigue las reglas de la DGII (por línea y totales).

---

## 3. Tecnologías

Estado: ✅ decidido · 🔶 se decide en la fase indicada

| Capa | Elección | Estado | Por qué |
|---|---|---|---|
| Lenguaje y runtime | **TypeScript** + **Node 24 LTS** | ✅ | Un solo lenguaje en web, API, caja y librería fiscal. La imagen `node:24-slim` es multiarquitectura (arm64). |
| Monorepo | **pnpm workspaces + Turborepo** | ✅ | Comparte tipos, esquemas, UI y lógica fiscal. `turbo prune` genera imágenes Docker pequeñas por app. |
| Back-office web | **Next.js 16** (ya instalado) + React 19, `output: "standalone"` | ✅ | Panel administrativo y reportes. El modo standalone produce una imagen de ~150 MB. |
| UI | **Tailwind v4** + componentes propios (`apps/web/components/ui.tsx`); mover a `packages/ui` y valorar **shadcn/ui** | 🔶 Pulido | Hoy la web usa componentes propios sencillos. Se compartirán con la caja cuando exista `apps/pos`. |
| API y workers | **Hono** sobre Node + **pg-boss** | ✅ | Es ligero. pg-boss maneja colas y reintentos usando Postgres, sin sumar Redis al servidor. Los endpoints receptor de la DGII quedan separados del front. |
| Contrato API | **Zod** + **Hono RPC** | ✅ | Validación y tipos de punta a punta entre la web, la caja y la API. |
| BD nube | **PostgreSQL 18** (servicio de BD de Dokploy) con **Row-Level Security** por `tenant_id` | ✅ | Aísla los datos entre empresas a nivel de base de datos. Dokploy hace los backups. |
| BD caja | **SQLite** (`better-sqlite3`, modo WAL) | ✅ | Embebida, rápida y sin instalación. |
| ORM | **Prisma 7** (cliente sin motor Rust + driver adapters: `@prisma/adapter-pg` en la nube, `@prisma/adapter-better-sqlite3` en la caja) | ✅ | Esquema declarativo cómodo, Prisma Studio y migraciones. Sin binarios nativos de Prisma, así que no hay problemas con arm64 ni con el empaquetado de Electron. Ver §3.2. |
| Autenticación | **Better Auth** (plugin de organizaciones) | ✅ | Multiempresa y roles integrados. En la caja se entra con **PIN de cajero** (funciona sin internet). |
| App de caja | **Electron + electron-vite + React** | ✅ | Node nativo: firma XML, SQLite e impresión ESC/POS sin escribir Rust. |
| Instalador y actualizaciones | `electron-builder` (NSIS) + `electron-updater` publicadas por **nuestra propia API** (`/updates/caja`, carpeta `POS_RELEASES_DIR`) | ✅ | Instalador `.exe` para Windows y actualización automática en cada local, sin depender de GitHub. Guía: `docs/CAJA-INSTALADOR.md`. |
| e-CF | `xmlbuilder2`, `xml-crypto` (XMLDSig RSA-SHA256), `node-forge` (.p12), validación XSD con `xmllint-wasm` | ✅ | Generación, firma y validación contra los XSD oficiales. |
| Librería e-CF existente | Evaluar **`dgii-ecf`** (npm) | 🔶 Fase 1 | Si está bien mantenida, ahorra semanas. Si no, se usa como referencia. |
| Conexión DGII | Directa o proveedor certificado (PSFE), detrás de `FiscalProvider` | 🔶 Fase 1 | Se decide después del prototipo (ver §7). |
| Impresión | `node-thermal-printer` (ESC/POS, QR nativo) | ✅ | Tickets 58/80 mm, comandas de cocina y apertura de gaveta. |
| PDF (E31, A4/carta) | `@react-pdf/renderer` | ✅ | Representación impresa formal, sin necesidad de Chromium en el servidor. |
| Archivos | **OCI Object Storage** (API compatible con S3) con `@aws-sdk/client-s3`. En desarrollo, MinIO | ✅ | XML firmados y PDF, conservados 10 años. Incluido en la capa gratuita de Oracle (20 GB). |
| Correo | **Resend** (o OCI Email Delivery) | ✅ | Envío del e-CF (XML + PDF) al cliente. |
| Pruebas | **Vitest** (unitarias), **Playwright** (E2E) | ✅ | Las pruebas fiscales usan los casos del set de certificación de la DGII. |
| Errores | **Sentry** (plan gratuito) + logs con `pino` | ✅ | Errores de la caja y de los envíos a la DGII. *(Alternativa autoalojada en Dokploy: GlitchTip.)* |
| Despliegue | **Dokploy** en Oracle Cloud (Ampere A1, **arm64**), Traefik + Let's Encrypt | ✅ | Ver §3.1. |
| CI/CD | **GitHub Actions** → imágenes arm64 en **GHCR** → Dokploy | ✅ | Compilar fuera del servidor evita que el build de Next consuma la RAM de producción. |

### 3.1 Despliegue en Oracle Cloud + Dokploy

**Servicios en Dokploy (un proyecto, entorno `production` y luego `staging`):**

| Servicio Dokploy | Tipo | Dominio | Notas |
|---|---|---|---|
| `web` | Application (imagen Docker) | `app.tudominio.com` | Next.js standalone, puerto 3000. |
| `api` | Application (imagen Docker) | `api.tudominio.com` | Hono, puerto 3001. Health check en `/health`. |
| `worker` | Application (misma imagen que `api`, otro comando) | — | Procesa la cola pg-boss: envíos a la DGII, reintentos, correos. Se puede escalar aparte. |
| `postgres` | Database → PostgreSQL 18 | interno | Backups programados de Dokploy hacia OCI Object Storage. |

**Flujo de despliegue:**

1. Push a `main` → GitHub Actions ejecuta lint, pruebas y build.
2. `docker buildx` genera las imágenes **`linux/arm64`** de `web` y `api` (con `turbo prune`) y las sube a `ghcr.io/<usuario>/facturacion-*`.
3. Actions llama al **webhook de redeploy** de Dokploy, que descarga la imagen nueva y reinicia el servicio.
4. `prisma migrate deploy` corre al iniciar `api` (comando previo en el contenedor), antes de aceptar tráfico.

**Detalles de arm64 a tener en cuenta:**
- Usar runners ARM de GitHub (`ubuntu-24.04-arm`) si están disponibles para el repo; si no, `buildx` con QEMU (más lento, pero funciona).
- Evitar dependencias nativas en el servidor: por eso la validación XSD usa `xmllint-wasm` (WebAssembly) y no un binding nativo de libxml2.
- Al inicio se puede dejar que Dokploy compile directamente desde el repo con el Dockerfile y pasar a GHCR cuando el build empiece a molestar.

**Configuración de OCI Object Storage:**
- Crear *Customer Secret Keys* en el usuario de OCI (son el access key / secret de S3).
- Endpoint: `https://<namespace>.compat.objectstorage.<región>.oraclecloud.com`, con `forcePathStyle: true`.
- Dos buckets: `facturacion-docs` (XML/PDF, privado, con versionado) y `facturacion-backups`.

**La caja (Electron) no se despliega en Dokploy:** se compila en un runner Windows de GitHub Actions y se publica en GitHub Releases, de donde `electron-updater` descarga las actualizaciones.

### 3.2 Cómo se usa Prisma en este proyecto

- **Dos schemas, no uno.** Prisma admite un solo proveedor por schema, así que hay dos paquetes:
  - `packages/db` → `schema.prisma` con `provider = "postgresql"` (la nube, completo).
  - `packages/db-local` → `schema.prisma` con `provider = "sqlite"` (la caja, solo lo que necesita: catálogo, clientes, documentos, cola de sync, turnos).
  - Los tipos de dominio compartidos (por ejemplo `DocumentoFiscal`) viven en `packages/core` y cada lado los mapea desde su modelo Prisma.
- **Multiempresa con RLS.** Las políticas `CREATE POLICY` se escriben en SQL al final de cada migración (flujo en §0.3.1; `prisma migrate dev` no se usa). Una *client extension* abre cada consulta en una transacción con `SELECT set_config('app.tenant_id', $1, true)`, así Postgres filtra por empresa aunque una consulta olvide el `where`.
- **Dinero:** campos `BigInt` en centavos (no `Float`). Las tasas de impuesto, en `Decimal`.
- **Migraciones en la caja:** las PCs de los locales no tienen la CLI de Prisma. La app incluye la carpeta `migrations/` y, al arrancar, aplica en orden los `.sql` pendientes (registrándolos en una tabla de control) antes de abrir la base.
- **Better Auth** usa su adaptador de Prisma, así que las tablas de usuarios y organizaciones viven en el mismo schema.
- Fijar `output` del cliente generado dentro de cada paquete (requisito de Prisma 7) y ejecutar `prisma generate` en el `postinstall`/build de Turborepo.


---

## 4. Estructura del monorepo

✅ = existe · ⬜ = pendiente

```
facturacion/
├─ apps/
│  ├─ web/        ✅ Next.js – back-office
│  ├─ api/        ✅ Hono – API, auth, rutas /v1  (⬜ sync, receptor DGII, workers)
│  └─ pos/        ⬜ Electron – caja offline
├─ packages/
│  ├─ db/         ✅ Prisma: schema de la nube (Postgres), migraciones, RLS, tenant
│  ├─ db-local/   ⬜ Prisma: schema de la caja (SQLite) y migraciones
│  ├─ core/       ✅ Lógica de negocio pura: dinero, cantidades, impuestos, totales, documentos de identidad
│  │              (⬜ pagos mixtos, multimoneda)
│  ├─ ecf/        🔶 XML e-CF (E31/E32/E33/E34), firma XMLDSig, código de seguridad y QR · cliente DGII directo (`DgiiClient`) detrás de `FiscalProvider` · resumen RFCE (consumo < RD$250,000)
│  ├─ printing/   ✅ ESC/POS: texto CP858, QR, corte, gaveta, tickets y envío (red / Windows)
│  ├─ ui/         ⬜ Componentes compartidos
│  └─ config/     ⬜ (hoy la config compartida es tsconfig.base.json en la raíz)
├─ docker/        ✅ Dockerfiles arm64, entrypoint con migraciones, compose de desarrollo
├─ docs/          ✅ PLAN.md (este archivo) y DESPLIEGUE.md
└─ .github/       ✅ workflows CI y despliegue  (instalador de la caja: ver docs/CAJA-INSTALADOR.md)
```

`packages/core` y `packages/ecf` **no dependen de ningún framework**. Así se ejecutan igual en la API, en la caja y en las pruebas.

---

## 5. Modelo de datos (núcleo)

- **Organización**: empresa (RNC, razón social, régimen), sucursales, cajas/terminales, usuarios, roles y permisos.
- **Fiscal**: certificados, rangos de secuencias e-NCF autorizados y asignados a cada caja, configuración de impuestos (ITBIS 18 % / 16 % / exento, ISC, propina legal 10 %).
- **Catálogo**: productos, variantes, códigos de barras, unidades, categorías, listas de precios, combos y modificadores (restaurante).
- **Terceros**: clientes y proveedores (RNC/cédula validados contra el padrón de la DGII).
- **Documentos**: cotización, pedido, factura (e-CF), nota de crédito/débito, compra, gasto menor. Cada uno tiene líneas, impuestos por línea, pagos (efectivo, tarjeta, transferencia, mixto) y su estado fiscal (`borrador → firmado → enviado → aceptado / aceptado condicional / rechazado`).
- **Caja**: turnos (apertura, cierre, cuadre), entradas y salidas de efectivo.
- **Inventario**: almacenes, movimientos (kardex), ajustes, transferencias.
- **Auditoría**: bitácora inmutable de quién hizo qué y cuándo.

---

## 6. Fases

> **Ruta crítica: el módulo e-CF.** La certificación ante la DGII (ambientes TesteCF → CerteCF → producción) toma semanas. Por eso arranca en paralelo desde la fase 1.

### Fase 0 – Fundamentos (1–2 semanas) · ✅ hecha en local · ⏸ despliegue aplazado
- [x] Monorepo (pnpm + Turborepo) con el Next movido a `apps/web`.
- [x] Configuración compartida (TS estricto, ESLint, Prettier), Vitest y CI en GitHub Actions.
- [x] `docker-compose.dev.yml` con Postgres 18 + MinIO *(escrito, no ejecutado: falta Docker)*.
- [x] Dockerfiles de `web` y `api` (arm64) y workflow GitHub Actions → GHCR → webhook de Dokploy *(escritos; **sin ejecutar**)*.
- [x] `packages/db` con Prisma: schema, migraciones, políticas RLS y extensión de cliente que fija el tenant.
- [x] Better Auth: registro de empresa, login, organizaciones y roles.
- [x] Script `pnpm db:bootstrap` para preparar la BD local.
- [ ] ⏸ Desplegar un "hola mundo" de `web` y `api` en Dokploy (`app.` / `api.`) — **aplazado hasta que el producto esté pulido** (ver §0.5-C).

### Fase 1 – Núcleo de negocio + prototipo fiscal (3–4 semanas) · 🔶 ~85 %
**Hecho**
- [x] `packages/core`: motor de cálculo (ITBIS 18/16/0/exento, precio con o sin impuesto, descuentos, propina legal, redondeo por línea) con 35 pruebas, más normalización de RNC/cédula/pasaporte.
- [x] Schema y RLS de sucursales, cajas, categorías, productos y clientes; bitácora inmutable.
- [x] API `/v1`: sucursales, cajas, categorías, productos (búsqueda, código de barras), clientes, `tax-codes` y `calculate`; roles y bitácora atómica; 24 pruebas contra Postgres real.
- [x] Panel web: resumen, productos, clientes, sucursales y cajas.

**Pendiente** (detalle en §0.5-A)
- [x] Datos fiscales de la empresa *(falta el certificado `.p12`)*.
- [x] Modelo y API de documentos (E31, E32, E33, E34) con líneas, pagos y totales recalculados en el servidor; emisión con e-NCF atómico e inmutabilidad en la BD.
- [x] Secuencias e-NCF con asignación atómica.
- [x] `packages/ecf`: XML de E31/E32/E33/E34, firma XMLDSig con `.p12`, código de seguridad y URL del QR.
- [x] Cliente de la DGII en `packages/ecf` (`DgiiClient`: semilla firmada → token con renovación, recepción, consulta de resultado y de TrackIds) detrás de la interfaz `FiscalProvider`; probado con una DGII simulada.
- [x] **Conectado a la emisión**: cola de envío con reintentos (`fiscal_submission`), TrackId y respuesta de la DGII guardados, el comprobante pasa de ISSUED a SENT y a ACCEPTED / ACCEPTED_CONDITIONAL / REJECTED; envío automático opcional (Configuración fiscal) o manual («Enviar a la DGII»), «Consultar ahora» y «Reintentar envío».
- [x] **RFCE** (resumen de factura de consumo < RD$250,000): formato, firma, envío y consulta; la cola lo envía solo.
- [x] **Anulación de rangos de e-NCF (ANECF)**: Configuración fiscal → «Anular sobrantes» (ver la nota «Anulación de rangos»).
- [x] **Prototipo contra TesteCF preparado**: script `pnpm --filter @facturacion/ecf testecf` y guía `docs/PRUEBA-TESTECF.md` (E31, E32 por resumen, E32 grande y nota de crédito; simulacro sin enviar; informe y archivos de cada corrida).
- [ ] **Correr el prototipo con el certificado real** (necesita de ti: el `.p12`, su contraseña y la empresa habilitada en la pre-certificación), corregir lo que la DGII rechace, validar contra los XSD oficiales y reglas ante rechazos (reemitir cuando `secuenciaUtilizada` es falso).
- [ ] **Decisión:** proveedor certificado o conexión directa con la DGII (ver §7).
- [ ] Invitar usuarios y gestionar miembros; validar RNC contra el padrón de la DGII.

### Fase 2 – Facturación en la web (3 semanas) · 🔶 emisión hecha, falta el envío a la DGII
- [x] Emisión desde el back-office: E31, E32, E34, E33 con pagos y multimoneda (DOP/USD).
- Workers: envío, reintentos, consulta de estado, RFCE para consumo < RD$250,000.
- Representación impresa: PDF (A4) con QR y código de seguridad.
- Envío al cliente por correo.

### Fase 3 – Caja offline (4–5 semanas) · 🔶 caja funcionando, falta pulirla
- [x] App Electron (`apps/pos`): configuración contra la API, venta rápida, búsqueda por código de barras, pagos mixtos, cobro con cambio, consumo y crédito fiscal, propina legal, ticket de 80 mm (se imprime con el diálogo del sistema), historial.
- [x] Login con **PIN** de cajero y bloqueo de pantalla (también sin internet), y devoluciones/notas de crédito desde la caja.
- [ ] Descuentos por línea, ventas en espera, clientes nuevos desde la caja, devolver ventas de otra caja o de la nube (hoy solo las de esta caja).
- [x] SQLite local (`node:sqlite`, en `packages/pos-engine`), **bloques de e-NCF por caja** (la nube corta un bloque del rango general y lo asigna), cola de envío con reintentos.
- [x] Firma del e-CF al emitir desde la nube (certificado cifrado, XML, código de seguridad y fecha guardados), firma posterior y QR en el panel y en el ticket.
- [x] **Firma local** del e-CF en la caja sin conexión (certificado cifrado en el almacén seguro del sistema operativo); la nube envía a la DGII al sincronizar.
- [x] Motor de sync: subir comprobantes idempotentes y bajar catálogos con cursor; estado de conexión, números restantes y ventas por subir en la barra superior.
- [x] Turnos dentro de la caja, sincronizados (apertura, ventas, cierre) con el mismo cuadre que la nube.
- [ ] Sync: bajar existencias (avisar de stock agotado sin conexión), restaurante (mesas/comandas) y precios por lista; retiros/ingresos de efectivo durante el turno.
- [x] Impresión **térmica ESC/POS** 80/58 mm directa (red y Windows), con apertura de gaveta, reimpresión, informes X/Z y aviso con reintento.
- [x] **QR de la DGII** en el ticket (con conexión) y en la factura del panel.
- [ ] Comanda de cocina y pre-cuenta del restaurante, impresora USB/serie directa, logo en el ticket y probar con hardware real.
- [x] **Instalador (electron-builder, NSIS, Windows) y auto-actualización** (`electron-updater`): la API publica `latest.yml`/instalador/`.blockmap` en `/updates/caja` (carpeta `POS_RELEASES_DIR`, con `Range`), la caja revisa al abrir y cada 4 h, descarga en segundo plano y ofrece «Actualizar a vX» sin reiniciar nunca sola. Ver `docs/CAJA-INSTALADOR.md`.
- [x] **Arranque con el sistema** (se registra la primera vez en la caja instalada; botón «Abrir al encender» en la pantalla) y **proceso de firma de código** (`dist:signed`: exige `CSC_LINK`/`CSC_KEY_PASSWORD`, verifica la firma, y `POS_PUBLISHER_NAME` hace que la auto-actualización solo acepte instaladores de ese firmante).
- [ ] **Comprar el certificado de firma de código** (aparte del de la DGII; EV o estándar) y probar una actualización firmada en una PC real.
- [x] Turnos de caja: apertura con fondo, cierre con cuadre y motivo de la diferencia, informe X/Z imprimible (API y panel web).
- [x] Turno obligatorio por empresa (`requireShift`).
- [ ] Cierre por forma de pago (tarjeta/transferencia contra voucher) y varias cajas con turnos simultáneos en una misma PC.

### Fase 4 – Certificación DGII (2–4 semanas, se solapa con la 3)
- Set de pruebas de la DGII, representaciones impresas, URLs de los servicios receptor.
- [x] Endpoints receptor públicos: recepción de e-CF con acuse de recibo y aprobación comercial (ver la nota «Receptor electrónico»).
- [x] Registrar un e-CF recibido como **compra** con un clic (proveedor, ITBIS por línea y entrada al inventario; ver la nota «Del e-CF recibido a la compra»).
- [x] Límite de uso, endurecimiento y autenticación por semilla opcional en los servicios públicos `/fe` (ver la nota «Servicios públicos /fe»).
- [ ] Validar la cadena de confianza del certificado de quien se autentica (raíces de las entidades autorizadas por la DGII) y compartir los contadores de límite entre réplicas (hoy son por proceso).
- Contingencia: qué pasa cuando la DGII o internet no responden.

### Fase 5 – Inventario y compras (3 semanas)
- [x] Existencias por sucursal, libro de movimientos inmutable, entradas, ajustes, descuento al emitir, reingreso al anular (nota de crédito código 1), alertas de stock mínimo.
- [ ] Transferencias entre sucursales, costo promedio y valorización, lotes/vencimientos, conteos programados.
- [x] Proveedores; compras de tres tipos: **factura de proveedor** (trae su NCF; único por proveedor), **E41** comprobante de compras (lo emite la empresa a un proveedor informal; exige proveedor con cédula/RNC) y **E43** gastos menores (sin proveedor ni inventario). E41 y E43 reciben e-NCF de sus propias secuencias; admiten retenciones de ITBIS/ISR (E41 y factura de proveedor); tipo de gasto 606 y forma de pago.
- [x] Al registrar: entrada al inventario con **costo unitario neto en pesos** (promedio dentro del mismo comprobante), actualización del **último costo** del producto y compra congelada (trigger).
- [x] Reporte de compras y CSV tipo 606 (borrador para el contador, no el archivo oficial de la DGII).
- [ ] Cuentas por pagar (pagos a crédito y vencimientos), anulación de compras (hoy se corrige con un ajuste de inventario), costo promedio ponderado y valorización del inventario.
- [ ] Recepción de e-CF de proveedores directamente en el sistema (Fase 4: endpoints receptor de la DGII).
- [x] **Archivos oficiales 606, 607 y 608 de la DGII** (texto con `|`, validaciones de los instructivos, vista previa en Reportes → Formatos DGII). Ver `docs/FORMATOS-DGII.md`.
- [ ] Probar los archivos con la Herramienta de Pre-validación de la DGII, y registrar lo que aún falta (notas de crédito de proveedores, selectivo y otros impuestos).

### Fase 6 – Módulo restaurante (3–4 semanas) · 🔶 núcleo hecho
- [x] Mesas (por sucursal y zona, creación en lote), comandas con consecutivo, una abierta por mesa, notas por producto («sin cebolla»), anular con motivo, cambiar de mesa, cancelar.
- [x] Envío a cocina/bar por estación del producto, pantalla de cocina con «Listo», estado visible en el salón.
- [x] División de cuenta (cobrar por partes, también por cantidades), propina legal 10 % opcional, E32/E31, pagos mixtos, descuento de inventario al cobrar.
- [x] Modificadores con precio y grupos (obligatorios u opcionales, mínimo/máximo), cursos (envío por tiempos) y combos (partes a cocina/bar, inventario de componentes al cobrar).
- [ ] Combos con elección («una bebida a elegir»), modificadores con cantidad o por porción, precios por horario (happy hour) y menú por sucursal.
- [ ] Impresión: ticket de cocina/bar por estación y pre-cuenta (el API ya devuelve el ticket separado por estación en `POST /orders/:id/send`; imprimir llega con la caja Electron/impresora térmica).
- [ ] Unir y dividir mesas, reservas, mapa visual del salón, cierre de caja por turno y propina repartida entre meseros.
- [ ] Tablets de meseros: PWA en la red local conectada a la caja (Fase 3).

### Fase 7 – Reportes y cumplimiento (2–3 semanas) · 🔶 reporte de ventas hecho
- [x] Ventas por período, por tipo, forma de pago y producto; ITBIS cobrado; exportación CSV. *(Falta filtrar por cajero y sucursal, y ITBIS pagado en compras.)*
- [x] Formatos de envío 606/607/608 armados (ver `docs/FORMATOS-DGII.md`); falta confirmar con el contador qué sigue siendo obligatorio para quien emite e-CF, y probarlos con la pre-validación de la DGII.
- Panel de control con indicadores.

### Fase 8 – Producción y producto (continuo)
- Instalador de la caja firmado, actualización automática, respaldos de SQLite.
- Entorno `staging` en Dokploy, prueba periódica de restauración de backups, monitoreo, alertas de rechazos de la DGII.
- Onboarding guiado (asistente de configuración por giro).
- Cobro de suscripciones a los clientes del SaaS.

**Estimación total para un MVP vendible (fases 0–4): ~3–4 meses** con una persona a tiempo completo.

---

## 7. Decisiones pendientes

1. **¿Proveedor certificado o conexión directa con la DGII?**
   - *Proveedor certificado (PSFE):* sale antes al mercado y la certificación la gestiona el proveedor, pero se paga por documento y se depende de un tercero.
   - *Conexión directa:* sin costo por documento y con control total, pero hay que certificarse y mantenerse al día con los cambios técnicos de la DGII.
   - Gracias a la interfaz `FiscalProvider`, se puede empezar con una y cambiar después.
2. **Contexto de mercado:** el plazo para pequeños, micro y no clasificados vence el **15 de noviembre de 2026** (prórroga de 6 meses). Muchos negocios estarán usando el facturador gratuito de la DGII y buscando algo mejor después: hay una buena ventana para un MVP en el primer trimestre de 2027.
3. **Proveedor de correo** (verificación de cuenta, recuperación de contraseña y envío del e-CF al cliente): Resend u OCI Email Delivery. Hace falta para el pulido previo al despliegue.
4. **Multimoneda (DOP/USD):** ¿entra en la primera versión o después de la certificación? El e-CF ya contempla moneda y tipo de cambio.
5. **Capacidad del servidor:** si el servidor Ampere es el de la capa gratuita (hasta 4 OCPU / 24 GB), alcanza de sobra para el MVP y los primeros clientes. Cuando crezca, el primer paso es mover Postgres a su propia instancia.

---

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Cambios en los XSD o servicios de la DGII | Todo aislado en `packages/ecf`, XML validado contra los XSD en CI. |
| Duplicación de e-NCF con varias cajas sin internet | Rangos exclusivos por caja y restricción única en la BD. |
| Pérdida de ventas si se daña el PC de la caja | Sincronización frecuente, respaldo local cifrado, SQLite en modo WAL. |
| Certificado robado de una caja | Cifrado en el almacén seguro del sistema operativo, revocación desde la nube. |
| Errores de redondeo de ITBIS | Montos en enteros y pruebas con los casos oficiales de la DGII. |
| Un solo servidor (Oracle) | Backups diarios fuera de la instancia (Object Storage), restauración probada, y la caja sigue facturando aunque la nube caiga. |
| Oracle reclama instancias gratuitas inactivas | Mantener uso real o pasar la cuenta a *Pay As You Go* (sigue sin costo dentro de los límites gratuitos). |
| Dockerfiles y workflow de despliegue sin probar | Construir las imágenes arm64 cuanto antes en un entorno con Docker (o con el runner de GitHub) y corregir; no esperar al día del despliegue. |
| Una clave foránea puede enlazar registros de otra empresa (la FK se salta RLS) | Verificar la pertenencia con el cliente de tenant antes de enlazar, y valorar claves compuestas `(organizationId, id)` en las tablas de documentos. |
