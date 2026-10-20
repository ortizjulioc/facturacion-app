# Plan: sistema de facturación (República Dominicana)

Sistema de facturación y punto de venta **multiempresa y multigiro** (tienda, restaurante, servicios…), con **facturación electrónica e-CF de la DGII**, que funciona **en la nube y también sin internet en la caja**.

---

## 0. Estado actual y cómo continuar

> **Última actualización:** 2026-10-20 · **Repositorio:** `github.com/ortizjulioc/facturacion-app` (rama `main`)
> **Regla del proyecto:** el despliegue en Dokploy se hace **cuando el producto esté terminado y pulido**, no antes. Mientras tanto se desarrolla y prueba todo en local.

### 0.1 Resumen en una mirada

| Fase | Estado |
|---|---|
| 0 · Fundamentos (monorepo, BD, auth, CI, Dockerfiles) | ✅ hecha en local · ⏸ despliegue de prueba en Dokploy **aplazado a propósito** |
| 1 · Núcleo de negocio | 🔶 **~85 %**: catálogo, clientes, cajas, motor de cálculo, **datos fiscales, secuencias e-NCF y facturas (E31/E32/E33/E34) emitibles y congeladas**; **falta `packages/ecf` y el prototipo contra TesteCF** y validar RNC contra el padrón; **equipo e invitaciones ya funcionan** |
| 2 · Facturación en la web | 🔶 emisión desde el back-office **hecha** (sin enviar a la DGII); faltan PDF con QR, envío por correo y workers |
| 5 · Inventario y compras | 🔶 **inventario y compras hechos** (existencias por sucursal, descuento al vender, proveedores, facturas de proveedor, E41, E43, retenciones, último costo, reporte de compras tipo 606); faltan transferencias entre sucursales, cuentas por pagar, costo promedio y la recepción de e-CF de proveedores |
| 6 · Restaurante | 🔶 **mesas, comandas, cocina/bar, cobro con propina legal y cuenta dividida hechos** (salón, comanda, pantalla de cocina, cobro que emite E32/E31); faltan modificadores con precio, cursos, impresión de comanda/pre-cuenta (llega con la caja Electron), unir/dividir mesas y PWA de meseros |
| 3, 4, 7, 8 | ⬜ sin empezar (la 7 tiene el reporte de ventas) |

Calidad actual (todo en verde): `lint`, `typecheck`, `build` y **226 pruebas** (58 `core` + 31 de BD: RLS, inmutabilidad, secuencias, inventario, compras y restaurante + 137 de la API contra Postgres real). Verificado además a mano en el navegador: registro → datos fiscales → secuencias → factura con código de barras → emisión → nota de crédito → factura de crédito fiscal con RNC → reportes → invitar a un cajero, que crea su cuenta con el enlace y trabaja con permisos limitados → inventario (entrada, venta que descuenta, stock bajo, bloqueo de ventas sin existencia) → proveedores y compras (factura de proveedor que da entrada al inventario con costo, E43, E41 con retenciones, reporte de compras) → restaurante (crear mesas, abrir mesa, anotar, enviar a cocina, marcar listo, cobrar una parte y luego el resto con pago dividido, la mesa queda libre, E31 exige cliente con RNC).

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

**`packages/db`**: tablas `user/session/account/verification/organization/member/invitation` (Better Auth), `branch`, `terminal`, `category`, `product`, `customer`, `audit_log`, y las fiscales **`company_profile`, `sequence`, `document`, `document_line`, `payment`**; y las de restaurante **`dining_table`, `restaurant_order`, `order_item`** (+ `Product.prepStation`, `Document.orderId`); enums `TaxCode`, `DocumentType`, `EcfType`, `DocumentStatus`, `PaymentMethod`, `EcfEnvironment`, `PrepStation`, `OrderStatus`, `OrderItemStatus`; 9 migraciones (la última, `restaurant`; antes, `purchases`: `supplier`, `purchase`, `purchase_line`, `lastCost` en el producto y `purchaseId` en los movimientos; la anterior, `inventory`: `stock_level` y `stock_movement`, campos `trackInventory` y `minStock` en el producto y `allowNegativeStock` en la empresa). La base de datos **impide por sí misma** modificar o borrar un comprobante emitido (triggers), que una secuencia retroceda o que se reescriba un rango en uso, y valida el formato del e-NCF y que su tipo coincida con el del documento.

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
| `/v1/reports/sales.csv` | GET: comprobantes emitidos del período en CSV (UTF-8 con BOM; neutraliza fórmulas de Excel) | **solo owner/admin** |
| `/api/auth/organization/*` | Better Auth: `invite-member`, `accept-invitation`, `cancel-invitation`, `list-members`, `list-invitations`, `update-member-role`, `remove-member` | según rol de Better Auth |
| `/v1/sequences` | GET, POST, PATCH `/:id` (rangos de e-NCF; no se solapan; no se borran) | owner/admin |
| `/v1/documents` | GET (`q, type, status, customerId, branchId, from, to, page`), GET `/:id`, POST (borrador), PUT `/:id` (reemplaza un borrador), DELETE `/:id` (solo borrador), POST `/:id/issue` | **cualquier miembro** (incluido el cajero) |
| `/v1/restaurant/tables` | GET (`?branchId`, `?all=true` solo admin; cada mesa trae el resumen de su comanda abierta), POST, POST `/bulk` (`prefix, count, startAt, zone, seats`; omite las que ya existen), PATCH `/:id` (no se desactiva con comanda abierta) | GET cualquier miembro; resto **owner/admin** |
| `/v1/restaurant/orders` | POST `{tableId, covers}` (una comanda abierta por mesa), GET `/:id`, POST `/:id/items`, PATCH `/:id/items/:itemId` (solo sin enviar), POST `/:id/items/:itemId/void` (sin enviar: se quita; enviado: exige motivo), POST `/:id/send` (a cocina/bar; lo que no se prepara queda listo; devuelve el ticket por estación), POST `/:id/transfer`, POST `/:id/cancel` (con productos en cocina solo admin), POST `/:id/bill` | **cualquier miembro** (cancelar con cocina: admin) |
| `/v1/restaurant/kitchen` · `/items/:id/ready` | GET `?station=KITCHEN\|BAR` (enviados y sin marcar, del más antiguo al más nuevo) · POST marcar listo | cualquier miembro |
| `/v1/tax-codes` | GET | — |
| `/v1/calculate` | POST (mismo motor que usará la facturación) | — |

**Restaurante (`routes/restaurant.ts`, `lib/orders.ts`)**: `DiningTable`, `RestaurantOrder` (consecutivo por empresa) y `OrderItem` (copia nombre/precio/impuesto del producto al anotarlo; estados `PENDING → SENT → READY`, `VOID`). `Product.prepStation` (`NONE/KITCHEN/BAR`) decide a dónde va. Totales de la pre-cuenta con el mismo motor de `core`; **propina legal = 10 % del subtotal antes de ITBIS** (ej.: 2 pollos RD$350 + 1 cerveza RD$120, ITBIS incluido → total 820.00, propina 69.49, total con propina 889.49). **Cobro** (`POST /orders/:id/bill`): bloquea la comanda (`FOR UPDATE`), arma un `DocumentInput` con lo cobrado (todo lo pendiente o una selección `items: [{itemId, quantity}]` para **dividir la cuenta**), reutiliza `issueDocument` (`lib/issue.ts`, el mismo flujo de `POST /documents/:id/issue`: valida pagos, asigna e-NCF, descuenta inventario, bitácora), suma `billedQuantity` y cierra la comanda al quedar todo cobrado. Si los pagos no suman, **no se cobra nada ni se gasta e-NCF**. En BD: índice único parcial «una comanda abierta por mesa», comanda cerrada/cancelada congelada (triggers) y producto cobrado no se puede borrar ni anular.

Cada cambio escribe en `audit_log` **dentro de la misma transacción** (si falla el cambio, no queda rastro).

**Emisión (`POST /v1/documents/:id/issue`)**, en una sola transacción: exige datos fiscales y total > 0 · refresca el comprador desde la ficha del cliente · aplica las reglas del comprador (E31 exige RNC; E32 ≥ RD$250,000 exige identificarlo) · exige que los pagos sumen el total (E31/E32) · en notas de crédito bloquea el original y verifica que no se exceda lo acreditable (código 1 = anular exige el total) · **asigna el e-NCF de forma atómica** (`UPDATE … WHERE id = (SELECT … FOR UPDATE)`; prefiere la secuencia de la caja, luego la general; ignora rangos vencidos, agotados o inactivos) · congela el comprobante. Los totales siempre se recalculan en el servidor con `core`.

**`apps/web`** (Next 16): `/registro`, `/login` y el panel `/panel` con **Resumen**, **Facturas** (listado con filtros, **editor** con buscador de productos y lector de códigos de barras, totales en vivo con el mismo motor fiscal, pagos mixtos, descuentos, propina legal, notas de crédito/débito, **detalle imprimible**), **Productos** (búsqueda, filtros, paginación, categorías, alta/edición/desactivar), **Clientes** (RNC/cédula con formato), **Sucursales y cajas**, **Configuración fiscal** (datos del emisor y secuencias), **Compras** (listado, editor con las reglas de cada tipo y totales en vivo, detalle), **Proveedores**, pestaña **Compras (606)** en Reportes y costo visible en Productos (solo admins), **Inventario** (existencias y movimientos por sucursal, entradas, ajustes por diferencia o conteo, interruptor de ventas sin existencia, filtro de stock bajo; la ficha del producto tiene "Controlar inventario" y existencia mínima; el Resumen avisa de stock bajo) **Restaurante** (`/panel/restaurante`: salón con mesas por zona y su estado —libre/ocupada, total, tiempo, «sin enviar / en preparación / listos»—, que se refresca solo; administrar mesas en lote; **comanda** con buscador de productos, notas, enviar a cocina, anular, cambiar de mesa, cancelar y **cobro** con selección de productos y cantidades, propina legal opcional, E32/E31 con cliente, pago dividido; `/panel/restaurante/cocina` con las pestañas Cocina y Bar y botón «Listo»; campo «Estación de preparación» en el producto) y **Equipo** (miembros, roles Propietario/Administrador/Cajero, invitaciones con enlace copiable, quitar miembros) y **Reportes** (solo admins: KPIs, gráfico, ITBIS, formas de pago, más vendidos y exportar CSV; el Resumen muestra ventas de hoy y del mes). Flujo de invitación: `/invitacion/[id]` → iniciar sesión o crear cuenta (sin crear empresa) → aceptar. Diálogos de confirmación y avisos propios (`components/dialogs.tsx`, sin `window.confirm/prompt`) y buscador de clientes con autocompletado en el editor. Cliente tipado de la API con Hono RPC (`apps/web/lib/api.ts`), componentes propios en `apps/web/components/ui.tsx`.

### 0.5 Lo que falta (backlog en orden de prioridad)

**A. Terminar la Fase 1 (siguiente trabajo inmediato)**

1. ✅ ~~Datos fiscales de la empresa~~ (falta solo el certificado digital `.p12`, que llega con `packages/ecf`).
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
| Instalador y actualizaciones | `electron-builder` (NSIS) + `electron-updater` desde **GitHub Releases** | ✅ | Instalador `.exe` para Windows y actualización automática en cada local. |
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
│  ├─ ecf/        ⬜ XML e-CF, firma, cliente DGII, RFCE, QR, FiscalProvider
│  ├─ printing/   ⬜ Plantillas de ticket ESC/POS
│  ├─ ui/         ⬜ Componentes compartidos
│  └─ config/     ⬜ (hoy la config compartida es tsconfig.base.json en la raíz)
├─ docker/        ✅ Dockerfiles arm64, entrypoint con migraciones, compose de desarrollo
├─ docs/          ✅ PLAN.md (este archivo) y DESPLIEGUE.md
└─ .github/       ✅ workflows CI y despliegue  (⬜ instalador de la caja)
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
- [ ] `packages/ecf` y `FiscalProvider`; **prototipo contra TesteCF** (E32 y E31: generar, firmar, enviar, consultar TrackId).
- [ ] **Decisión:** proveedor certificado o conexión directa con la DGII (ver §7).
- [ ] Invitar usuarios y gestionar miembros; validar RNC contra el padrón de la DGII.

### Fase 2 – Facturación en la web (3 semanas) · 🔶 emisión hecha, falta el envío a la DGII
- [x] Emisión desde el back-office: E31, E32, E34, E33 con pagos y multimoneda (DOP/USD).
- Workers: envío, reintentos, consulta de estado, RFCE para consumo < RD$250,000.
- Representación impresa: PDF (A4) con QR y código de seguridad.
- Envío al cliente por correo.

### Fase 3 – Caja offline (4–5 semanas)
- App Electron: login con PIN, venta rápida, búsqueda por código de barras, pagos mixtos, devoluciones.
- SQLite local, rangos de secuencias, firma local, cola de envío.
- Motor de sync (subir documentos y bajar catálogos) y pantalla de estado de la conexión.
- Impresión de tickets 80/58 mm con QR y apertura de gaveta.
- Turnos de caja: apertura, cierre, cuadre e informe X/Z.

### Fase 4 – Certificación DGII (2–4 semanas, se solapa con la 3)
- Set de pruebas de la DGII, representaciones impresas, URLs de los servicios receptor.
- Endpoints receptor públicos: recepción de e-CF, acuse de recibo, aprobación comercial.
- Contingencia: qué pasa cuando la DGII o internet no responden.

### Fase 5 – Inventario y compras (3 semanas)
- [x] Existencias por sucursal, libro de movimientos inmutable, entradas, ajustes, descuento al emitir, reingreso al anular (nota de crédito código 1), alertas de stock mínimo.
- [ ] Transferencias entre sucursales, costo promedio y valorización, lotes/vencimientos, conteos programados.
- [x] Proveedores; compras de tres tipos: **factura de proveedor** (trae su NCF; único por proveedor), **E41** comprobante de compras (lo emite la empresa a un proveedor informal; exige proveedor con cédula/RNC) y **E43** gastos menores (sin proveedor ni inventario). E41 y E43 reciben e-NCF de sus propias secuencias; admiten retenciones de ITBIS/ISR (E41 y factura de proveedor); tipo de gasto 606 y forma de pago.
- [x] Al registrar: entrada al inventario con **costo unitario neto en pesos** (promedio dentro del mismo comprobante), actualización del **último costo** del producto y compra congelada (trigger).
- [x] Reporte de compras y CSV tipo 606 (borrador para el contador, no el archivo oficial de la DGII).
- [ ] Cuentas por pagar (pagos a crédito y vencimientos), anulación de compras (hoy se corrige con un ajuste de inventario), costo promedio ponderado y valorización del inventario.
- [ ] Recepción de e-CF de proveedores directamente en el sistema (Fase 4: endpoints receptor de la DGII).
- [ ] Archivo oficial 606 de la DGII (formato de texto con sus validaciones) y 607/608.

### Fase 6 – Módulo restaurante (3–4 semanas) · 🔶 núcleo hecho
- [x] Mesas (por sucursal y zona, creación en lote), comandas con consecutivo, una abierta por mesa, notas por producto («sin cebolla»), anular con motivo, cambiar de mesa, cancelar.
- [x] Envío a cocina/bar por estación del producto, pantalla de cocina con «Listo», estado visible en el salón.
- [x] División de cuenta (cobrar por partes, también por cantidades), propina legal 10 % opcional, E32/E31, pagos mixtos, descuento de inventario al cobrar.
- [ ] Modificadores con precio y grupos (extra queso +RD$50), cursos (entrada/plato fuerte/postre), combos.
- [ ] Impresión: ticket de cocina/bar por estación y pre-cuenta (el API ya devuelve el ticket separado por estación en `POST /orders/:id/send`; imprimir llega con la caja Electron/impresora térmica).
- [ ] Unir y dividir mesas, reservas, mapa visual del salón, cierre de caja por turno y propina repartida entre meseros.
- [ ] Tablets de meseros: PWA en la red local conectada a la caja (Fase 3).

### Fase 7 – Reportes y cumplimiento (2–3 semanas) · 🔶 reporte de ventas hecho
- [x] Ventas por período, por tipo, forma de pago y producto; ITBIS cobrado; exportación CSV. *(Falta filtrar por cajero y sucursal, y ITBIS pagado en compras.)*
- Formatos de envío 606/607/608 (según lo que siga exigiendo la DGII con e-CF).
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
