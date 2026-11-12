# Plan: emitir e-CF reales y certificarse ante la DGII

> **Creado:** 2026-11-11 · **Base:** revisión completa de la documentación oficial descargada (5 carpetas: Informe y descripción técnica, Formatos XML, XSD, Proceso de certificación, Instructivos) contra el código de `packages/ecf`, `apps/api`, `packages/pos-engine`, `packages/printing` y `apps/web`.
> **Siguiente paso:** trámites de §2 y Fase A (empezando por A0). El sandbox externo se revisó y queda solo como referencia (§7, E1).

Leyenda: 🧑‍💻 código · 📋 trámite tuyo (no es código) · ✅ comprobado a mano · 🔎 hallazgo de revisión, se confirma al arreglarlo · ✔️ hecho.

---

## 1. Dónde estamos

**Lo que ya está bien (verificado):**

- ✅ **Firma digital**: los 16 XML de prueba (E31, E32, E33, E34, RFCE, ANECF, ARECF, ACECF) generados con el código real pasan la verificación de `System.Security.Cryptography.Xml.SignedXml` de .NET, la misma tecnología del ejemplo oficial «Firmado de e-CF».
- ✅ **Estructura XML**: E31, E33, E34, E32 ≥ RD$250,000, ARECF y ACECF validan contra los XSD oficiales.
- URLs y rutas de los tres ambientes, autenticación semilla → token (renovación y reintento único ante 401), envío multipart `xml` con nombre `RNC+eNCF.xml`, estados 0–4, `secuenciaUtilizada`, código de seguridad (6 primeros caracteres del `SignatureValue`), parámetros del QR, `FechaHoraFirma` en GMT-4, servicios receptores `/fe/...` (una sola URL para todas las empresas: se enruta por `RNCComprador`), cola persistente con backoff y RFCE síncrono.

**Lo que falta, en una línea:** unas correcciones puntuales al XML, endurecer el envío (reintentos y rechazos), y cuatro piezas nuevas que la certificación exige: **modo certificación con el Excel de la DGII**, **PDF de la representación impresa**, **entrega del e-CF al comprador electrónico** y **servicios accesibles desde internet** durante las pruebas.

---

## 2. Trámites que puedes empezar ya (en paralelo al código) 📋

Llevan semanas y no dependen del código:

1. **Usuario Administrador de e-CF** en el RNC de la empresa con la que vas a certificar (Oficina Virtual → Solicitudes → Actualización al RNC). Debe hacerse **antes** de pedir ser emisor.
2. **Certificado digital para Procedimiento Tributario** a nombre de esa persona, de una entidad autorizada por INDOTEL: Viafirma, Digifirma o Novofirma. Es el `.p12` que se sube en Configuración fiscal.
3. **Delegación del rol «Firmante»** (y «Aprobador Comercial») a esa persona en la Oficina Virtual.
4. **Formulario FI-GDF-016** (Solicitud para ser Emisor Electrónico). Al aprobarse llega el acceso al portal de certificación y a **TesteCF** (pre-certificación).
5. Requisitos de fondo: RNC activo, clave OFV, **Alta NCF** y obligaciones al día.
6. Descargar **App Firma Digital** (Windows) del portal DGII: se usa para firmar la postulación y la declaración jurada.

**Decisión de modelo (ver §8):** certificar primero **una empresa** (la tuya o un cliente piloto) como emisor con software propio; después evaluar hacerte **Proveedor de Servicios de FE certificado** para que tus clientes solo hagan las pruebas de simulación.

---

## 3. Fase A — Correcciones al XML (rápidas, bloquean) 🧑‍💻

| # | Qué | Dónde | Estado |
|---|---|---|---|
| A0 | **Validar contra los XSD en las pruebas**: copiar los XSD oficiales al repo (`packages/ecf/xsd/`) y validar cada XML de los tests con un validador JS (p. ej. `xmllint-wasm`). En la certificación un solo rechazo reinicia el set completo. | `packages/ecf` | ✔️ hecho (2026-11-11) |
| A1 | **RFCE**: quitar `ITBIS1/2/3` y `TasaImpuestoAdicional` (el XSD del RFCE no los tiene). Hoy **todo** resumen con ITBIS sería rechazado. | `xml.ts:362` usa `totales()` | ✔️ hecho (2026-11-11) |
| A2 | **E32 < RD$250,000 sin comprador**: el XSD exige `<Comprador>`; en la simulación se sube el XML completo al portal. Emitir el elemento (vacío o con lo que haya) solo en ese caso. Confirmar en TesteCF qué acepta. | `xml.ts` (comprador) | ✔️ hecho (2026-11-11) |
| A3 | **ANECF**: `<Secuencia>` → `<Secuencias>`. | `annulment.ts` | ✔️ hecho (2026-11-11) |
| A4 | **Venta a crédito**: pasar `paymentDueDate` (y `incomeType`) al armar el e-CF; hoy sale `TipoPago 2` sin `FechaLimitePago`. Pedir la fecha límite en el editor si el pago es a crédito. | `apps/api/src/lib/signing.ts:135` | ✅ |
| A5 | **`IndicadorNotaCredito`**: comparar días calendario en hora RD, no milisegundos / 24 h. | `xml.ts:177` | ✅ |
| A6 | **E31 con cédula** (personas físicas): `RNCComprador` admite 9 u 11 dígitos. | `packages/core/src/ecf.ts:86` | ✅ |
| A7 | **Nombre del comprador obligatorio** en E31 y en E32 ≥ RD$250,000. | `core/src/ecf.ts` (`buyerErrors`) | 🔎 |
| A8 | **Notas**: solo códigos 1–3 (4 y 5 no aplican a E33/E34); **código 2** (corrección de texto) con montos en cero; no usar 3 «por defecto» en silencio. | `documents.ts:71`, `routes/sync.ts:97`, `issue.ts:47`, `signing.ts:131` | 🔎 |
| A9 | **Firma idéntica al ejemplo oficial**: quitar el transform C14N extra (dejar solo `enveloped-signature`). El resultado es el mismo; es para no dar motivos. | `sign.ts:140` | ✔️ hecho (2026-11-11) |
| A10 | Menores: `IndicadorMontoGravado` solo si hay gravados; no inventar forma de pago en E33; validar formato de correos; unidades desconocidas avisan en vez de caer en «Unidad»; dígito verificador de RNC/cédula. | `xml.ts`, `core` | 🔎 |

---

## 4. Fase B — Envío a la DGII robusto 🧑‍💻

| # | Qué | Por qué |
|---|---|---|
| B1 | **Conciliar antes de reenviar**: si el envío se cortó (timeout/red), consultar si la DGII ya lo recibió (`trackIdsOf` en TesteCF/producción; `summaryResult` para RFCE) antes de volver a enviar. ✅ hoy se reenvía a los 30 s sin preguntar. | La DGII prohíbe reenviar el mismo e-NCF; genera TrackIds duplicados. (`fiscal.ts:167-187`) |
| B2 | **Rechazos**: bandeja de revisión que incluya los REJECTED (hoy solo lista FAILED); flujo para **sustituir** un e-CF rechazado (nuevo e-NCF si `secuenciaUtilizada = true`); los reportes no deben contar rechazados como válidos; el botón «Reintentar» no debe reenviar el mismo XML rechazado. | Estándares §4, Informe §10 |
| B3 | **Caída de la DGII**: corte por empresa (si falla la DGII, pausar todo y no martillar), no pasar a FAILED a las ~17 h (la indisponibilidad puede durar días), enviar en orden de emisión al volver, consultar **Consulta Estatus Servicios**. | Estándares §5, Instructivo de Contingencia |
| B4 | **Errores de configuración** (certificado no autorizado, URL mala): detener la cola de **esa empresa** y avisar, en vez de fallar documento por documento. | Estándares §4 |
| B5 | **«En proceso» indefinido**: escalar a revisión manual tras N consultas; un estado desconocido no es «En proceso». | `dgii.ts:47` |
| B6 | **ANECF**: dar por anulado solo con respuesta positiva explícita (hoy basta con que no aparezcan 3 frases de error). ✅ | `dgii.ts:194` |
| B7 | **Directorio**: no consultarlo en CerteCF (no existe allí); caché con tiempo de vida. | `dgii.ts:198`, `receiver.ts:250` |
| B8 | **Enviar al emitir por defecto**: `sendToDgii` nace en `false`; la norma pide enviar al momento de emitir. ✅ | `schema.prisma:354` |
| B9 | **No emitir sin firma** cuando la empresa es emisor electrónico (hoy se puede emitir sin certificado y queda un e-NCF sin e-CF). | Informe §10 |
| B10 | **Aprobación comercial**: enviarla solo cuando la DGII ya aceptó el e-CF recibido (consultar su estado); hoy, si aún no lo aceptó, queda FAILED para siempre. | Informe pág. 12, nota 10 |

---

## 5. Fase C — Piezas nuevas que exige la certificación 🧑‍💻

1. **Modo certificación (set de pruebas)** — *la pieza más importante*.
   - Importar el **Excel** de la DGII (pruebas de datos) y armar cada e-CF **con los mismos campos y en el mismo orden**, sin pasar por las facturas del sistema; validar contra XSD (A0) **antes** de enviar; firmar, enviar, consultar y mostrar el resultado de cada fila.
   - Lo mismo para el Excel de **aprobaciones/rechazos comerciales**.
   - Probablemente el set incluya tipos o campos que el sistema aún no emite (otros tipos de e-CF, ISC, otra moneda…): el generador debe ser **genérico por campo**, guiado por el Excel. Se precisará al ver el primer Excel real (en TesteCF/portal). Indicio: un ejemplo con datos del set («DOCUMENTOS ELECTRONICOS DE 02») es un **E47** con `OtraMoneda` (USD), `Retencion` de ISR por línea, `Transporte` y `TerminoPago`; representarlo como JSON anidado en el orden del XML (como hace el servicio de §7 E1) es un buen modelo.
2. **PDF de la representación impresa** (A4 y ticket), conforme a los modelos de la DGII; en la simulación se suben estos PDF (máx. 10 MB) y la DGII los **aprueba o rechaza**. Debe incluir:
   - fecha de vencimiento de la secuencia (E31/E33), «NCF modificado» y motivo (E33/E34) **impresos** (hoy son `no-print`), ITBIS por línea, «Subtotal gravado», sucursal, municipio/provincia, paginación «Página X de Y» con subtotales por página, fecha de firma en `dd-MM-aaaa HH:mm:ss`;
   - leyendas de **envío diferido** (24 h) y **contingencia** (72 h); documento «no válido para fines fiscales» cuando no se pudo generar el e-CF.
3. **Entregar el e-CF al comprador electrónico** ✅ hoy no existe: buscar al comprador en el directorio, enviarle el e-CF a su `urlRecepcion` (con su autenticación) y guardar el **ARECF** que responde. Se prueba en las pruebas de comunicación.
4. **Servicios accesibles desde internet durante la certificación**: la DGII llama a tus URL de recepción, aprobación y autenticación. Opciones: **túnel HTTPS** (p. ej. Cloudflare Tunnel) a tu PC mientras duren las pruebas, o un despliegue temporal solo de la API. ⚠️ Choca con la regla «no desplegar hasta terminar»: el túnel la respeta.

---

## 6. Fase D — Contingencia completa 🧑‍💻

1. **Sin conexión** (lo que ya hace la caja): imprimir la leyenda de 72 h en el ticket y en el panel; **alerta** si algo emitido lleva cerca de 72 h sin enviarse (caja y nube); evaluar `IndicadorEnvioDiferido` (solo para autorizados; confirmar en TesteCF).
2. **Imposibilidad técnica**: registro de entrada/salida de contingencia en el sistema (tú la declaras en la OFV), secuencias **serie B** en papel (máx. 15 días), y al salir **reemplazo** de cada B por un e-CF con código de modificación 4, enviado **solo a la DGII**, en un plazo de **30 días**. Requiere notas/e-CF que referencien NCF B.
3. Notas de crédito sobre **NCF no electrónicos** (B/A/P), útiles también para la migración de clientes que vienen del papel.

---

## 7. Fase E — Prueba real en TesteCF y certificación

**E1. Sandbox (`dgiiconnect.taveras.com.do`) — decidido: solo como referencia (2026-11-11).** No simula la DGII: es un servicio de terceros que recibe el e-CF en **JSON**, arma el XML, lo firma y lo envía (`POST /ecf/workflow`); su `/ecf/workflow/sandbox` solo valida la forma del JSON (aceptó totales que no cuadran) y responde con un formato que no es el de la DGII (`codigo 200/400`, trackId = código de seguridad, QR en `/sandbox/`). `?simulate_error=true` simula un rechazo; `?simulate_error_type=dgii_500` se ignora. Token en `.env` (`token_sandbox`). **Sirve para:** ver cómo representa cada uno de los 10 tipos (31–34, 41, 43–47) y la experiencia de su autor con TesteCF (llevarle la lista de dudas de E2). **No sirve** como banco de pruebas de nuestro cliente DGII ni lo usamos como proveedor (certificados y facturas de los clientes en un tercero).

**E2. TesteCF (pre-certificación):** `pnpm --filter @facturacion/ecf testecf` (guía en [PRUEBA-TESTECF.md](PRUEBA-TESTECF.md)) y luego desde la aplicación. Dudas que solo resuelve la DGII real — anota la respuesta de cada una:

- `<Comprador>` vacío en E32 < RD$250,000 (A2).
- Mayúsculas en parámetros del QR (`RncEmisor` vs `rncemisor`) y en la consulta RFCE (`RNC_Emisor`/`Cod_Seguridad_eCF` vs `RncEmisor`/`CodigoSeguridad`); URL `Certecf` vs `certecf` de FC.
- Rechazos de recepción e-CF/RFCE: ¿HTTP 200 con cuerpo o 4xx? (decide cómo se registra el rechazo y si se conserva `secuenciaUtilizada`).
- Reenvío del mismo e-NCF: ¿TrackId nuevo o rechazo?
- Crédito sin `FechaLimitePago`, tolerancia de ±1 por línea, formato de la tasa de propina («10» vs «10.00») y propina con precios con ITBIS en líneas al 16 % o exentas.
- `IndicadorNotaCredito` el día 30 y 31; si con «1» se rechaza acreditar ITBIS.
- Firma muy posterior a la fecha de emisión (caja sin conexión días después).
- Qué devuelve el directorio en `urlAceptacion`/`urlOpcional` (host o ruta completa) — `peer.ts:7`.
- Si `validarsemilla` siempre trae `expira` con zona horaria.

**E3. Certificación** (portal DGII): postulación (nombre/versión del software + 3 URL) firmada con App Firma Digital → **pruebas de datos** (Excel e-CF + Excel aprobaciones) → **simulación** (facturas reales, RFCE + XML completo de E32 < 250 mil, PDF de cada representación impresa) → URL de prueba → **comunicación** (recibir e-CF y aprobaciones de la DGII y responder acuses) → URL de producción → **declaración jurada** firmada → verificación del RNC → autorizado.

---

## 8. Decisiones pendientes

1. **Modelo**: emisor con software propio (cada cliente pasa todas las pruebas) vs **Proveedor de Servicios de FE certificado** (cada cliente solo hace simulación). Recomendación: certificar una empresa primero, luego evaluar ser proveedor (tiene su propia norma y requisitos; no está en esta documentación).
2. **Cómo exponer los servicios** durante la certificación: túnel (recomendado, respeta la regla de no desplegar) o despliegue temporal.
3. **Alcance de tipos**: E41 (compras a informales) y E43 (gastos menores) son útiles para un comercio y ya tienen secuencias; E44/E45 solo si vendes a regímenes especiales o al gobierno; E46/E47 poco probables. Confirmar qué exige el set de pruebas para tu caso.
4. **Facturas en USD** (`OtraMoneda`): hoy no se firman ni se envían.

---

## 9. Después de certificar (no bloquea)

- **E41**: proveedor como «comprador» (cédula), retenciones de ITBIS/ISR por línea y totales, `IndicadorBienoServicio` (hay que guardar si la línea es servicio), sin `TipoIngresos`, con vencimiento de secuencia.
- **E43**: todo exento (`IndicadorFacturacion = 4`), sin comprador, sin ITBIS ni formas de pago, con vencimiento de secuencia.
- `buildEcf` necesita **reglas por tipo** (hoy arma igual del 31 al 34).
- Otra moneda, bonos de regalo (`MontoNoFacturable`, `FormaPago 5`), anular con ANECF un e-CF firmado y no enviado, consulta pública del e-CF, conservación por 10 años, validación de la cadena de confianza de certificados recibidos.

---

## 10. Orden sugerido

1. 📋 Trámites de §2 (ya).
2. 🧑‍💻 Fase A completa (A0 primero).
3. 🧑‍💻 B1, B6, B8, B9 (lo más riesgoso del envío) y el resto de B.
4. 🧑‍💻 Fase C: modo certificación, PDF, entrega al comprador, túnel.
5. 🧑‍💻 Fase D (leyendas y alerta de 72 h primero; serie B después).
6. TesteCF → certificación (Fase E). El sandbox de E1 queda solo como referencia.
