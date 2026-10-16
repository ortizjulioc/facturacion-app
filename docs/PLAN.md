# Plan: sistema de facturación (República Dominicana)

Sistema de facturación y punto de venta **multiempresa y multigiro** (tienda, restaurante, servicios…), con **facturación electrónica e-CF de la DGII**, que funciona **en la nube y también sin internet en la caja**.

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
| UI | **Tailwind v4 + shadcn/ui** en `packages/ui` | ✅ | Los mismos componentes en la web y en la caja. |
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
- **Multiempresa con RLS.** Las políticas `CREATE POLICY` se escriben en SQL dentro de migraciones creadas con `prisma migrate dev --create-only`. Una *client extension* abre cada consulta en una transacción con `SELECT set_config('app.tenant_id', $1, true)`, así Postgres filtra por empresa aunque una consulta olvide el `where`.
- **Dinero:** campos `BigInt` en centavos (no `Float`). Las tasas de impuesto, en `Decimal`.
- **Migraciones en la caja:** las PCs de los locales no tienen la CLI de Prisma. La app incluye la carpeta `migrations/` y, al arrancar, aplica en orden los `.sql` pendientes (registrándolos en una tabla de control) antes de abrir la base.
- **Better Auth** usa su adaptador de Prisma, así que las tablas de usuarios y organizaciones viven en el mismo schema.
- Fijar `output` del cliente generado dentro de cada paquete (requisito de Prisma 7) y ejecutar `prisma generate` en el `postinstall`/build de Turborepo.


---

## 4. Estructura del monorepo

```
facturacion/
├─ apps/
│  ├─ web/        Next.js – back-office (lo que hoy es facturacion-app)
│  ├─ api/        Hono – API, sync, endpoints receptor DGII, workers
│  └─ pos/        Electron – caja offline
├─ packages/
│  ├─ db/         Prisma: schema de la nube (Postgres) y migraciones
│  ├─ db-local/   Prisma: schema de la caja (SQLite) y migraciones
│  ├─ core/       Lógica de negocio pura: totales, impuestos, descuentos,
│  │              propina legal, pagos mixtos, multimoneda
│  ├─ ecf/        XML e-CF, firma, cliente DGII, RFCE, QR, FiscalProvider
│  ├─ printing/   Plantillas de ticket ESC/POS
│  ├─ ui/         Componentes compartidos (shadcn)
│  └─ config/     tsconfig, eslint, tailwind compartidos
├─ docker/        compose de desarrollo (Postgres + MinIO)
└─ .github/       workflows: CI, imágenes arm64, instalador de la caja
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

### Fase 0 – Fundamentos (1–2 semanas)
- Convertir el proyecto en monorepo (pnpm + Turborepo) y mover el Next actual a `apps/web`.
- Configuración compartida (TS, ESLint, Prettier), Vitest, CI en GitHub Actions.
- Docker Compose local: Postgres 18 + MinIO (simula OCI Object Storage).
- Dockerfiles de `web` y `api` (arm64), pipeline GitHub Actions → GHCR → webhook de Dokploy, y Postgres creado en Dokploy con backups a OCI.
- Desplegar un "hola mundo" de `web` y `api` en `app.` y `api.` para validar el flujo de punta a punta desde el día uno.
- `packages/db` con Prisma: schema inicial, primera migración, políticas RLS en SQL y extensión de cliente que fija el tenant.
- Better Auth: registro de empresa, usuarios, roles.

### Fase 1 – Núcleo de negocio + prototipo fiscal (3–4 semanas)
- CRUD de empresa, sucursales, cajas, impuestos, catálogo, clientes.
- `packages/core`: motor de cálculo (líneas, descuentos, ITBIS, totales, redondeo) **con pruebas exhaustivas**.
- **Prototipo e-CF**: generar un E32 y un E31, firmarlos, autenticarse en TesteCF, enviarlos y consultar el TrackId.
- **Decisión:** proveedor certificado o conexión directa con la DGII (ver §7).

### Fase 2 – Facturación en la web (3 semanas)
- Emisión desde el back-office: E31, E32, E34, E33 con pagos y multimoneda (DOP/USD).
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
- Kardex, almacenes, ajustes, transferencias, alertas de stock mínimo.
- Compras a proveedores, E41 (compras) y E43 (gastos menores).
- Recepción de e-CF de proveedores directamente en el sistema.

### Fase 6 – Módulo restaurante (3–4 semanas)
- Mapa de mesas, comandas, modificadores ("sin cebolla"), cursos.
- Impresora de cocina/bar por categoría.
- División de cuenta, propina legal 10 %.
- Tablets de meseros: PWA en la red local conectada a la caja.

### Fase 7 – Reportes y cumplimiento (2–3 semanas)
- Ventas por período, producto, cajero y sucursal; ITBIS cobrado y pagado.
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
3. **Capacidad del servidor:** si el servidor Ampere es el de la capa gratuita (hasta 4 OCPU / 24 GB), alcanza de sobra para el MVP y los primeros clientes. Cuando crezca, el primer paso es mover Postgres a su propia instancia.

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
