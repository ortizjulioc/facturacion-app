# Formatos de envío de datos de la DGII: 606, 607 y 608

El sistema arma los archivos de texto que la DGII pide cada mes (Norma General 07-2018 y 05-2019):

| Formato | Qué informa | Máximo de registros | Se envía |
|---|---|---|---|
| **606** | Compras de bienes y servicios | 10,000 | A más tardar el día 15 del mes siguiente |
| **607** | Ventas de bienes y servicios | 65,000 | A más tardar el día 15 del mes siguiente |
| **608** | Comprobantes anulados | 4,999 | A más tardar el día 15 del mes siguiente |

Se usan desde el panel: **Reportes → Formatos DGII** (solo propietarios y administradores). Se elige el formato y el mes, y se ve la **vista previa** exacta de cada registro, los **errores** que impedirían enviarlo y los **avisos**. El botón «Descargar archivo TXT» solo se activa cuando no hay errores (la API también se niega: `GET /v1/reports/dgii/:format/file?period=AAAAMM` responde 422 con la lista).

> Los instructivos oficiales (606 del 12-02-2026, 607 de dic-2025, 608 de mar-2026) están en dgii.gov.do → *Formatos de Envío de Datos*. Lo que dicen —campos, orden, valores permitidos, límites— está aquí tal cual. **Lo que no dicen** (ver §4) hay que comprobarlo con la *Herramienta de Pre-validación* de la DGII antes del primer envío.

## 1. Cómo enviarlo

1. Panel → Reportes → Formatos DGII → elige el formato y el mes → corrige lo que marque en rojo → **Descargar archivo TXT** (`DGII_F_606_<RNC>_<AAAAMM>.TXT`).
2. Pásalo por la **Herramienta de Pre-validación de Envío de Datos** de la DGII (Herramientas → Formularios → Herramientas de Pre-validación).
3. Oficina Virtual → *Formatos de Envíos* → *Enviar Archivos* → tipo de información (606, 607 o 608), el período y el archivo.
4. **607**: la Oficina Virtual pide además el *Resumen General de Facturas de Consumo*; el panel te muestra los números (cantidad y monto facturado) en el recuadro de esa pantalla.
5. Sin movimiento en el mes: el sistema genera igual el archivo en cero (solo el encabezado), pero la DGII pide enviarlo como «Declaración en cero» en la Oficina Virtual (*Declaraciones Juradas → Declaraciones en Cero*).

## 2. De dónde sale cada dato

### 606 · compras
Compras **registradas** (no borradores) cuya fecha de comprobante cae en el mes. Todo en pesos: los dólares se convierten con la tasa de cambio de la compra.

| Campo del formato | De dónde sale |
|---|---|
| RNC/Cédula y Tipo Id | El proveedor de la compra (1 RNC, 2 cédula). Los gastos menores (E43) van sin RNC. |
| Tipo de bienes y servicios (01–11) | El tipo de gasto de la compra. |
| NCF | El NCF de la factura del proveedor, o el e-NCF que emite la empresa (E41, E43). |
| NCF modificado | Vacío (las notas de crédito de proveedores todavía no se registran). |
| Fecha comprobante / Fecha de pago | La del comprobante / la **fecha de pago** de la compra; si está vacía, al contado es la del comprobante y a crédito queda vacía hasta que se pague. |
| Monto en servicios / en bienes | La base sin impuestos: **bienes** si el tipo de gasto es 04, 09 o 10; **servicios** en los demás. |
| ITBIS facturado, retenido | ITBIS de la compra y el ITBIS retenido. |
| ITBIS proporcionalidad, al costo | Lo que se anote en la compra (0 si nada). **ITBIS por adelantar** = ITBIS facturado menos el llevado al costo. |
| Tipo de retención en ISR, Retención renta | El **tipo de retención** (01–09) de la compra, obligatorio si hay ISR retenido, y el monto. |
| Selectivo, otros impuestos, propina legal, percibidos | Vacíos. |
| Forma de pago | Efectivo 01 · transferencia o cheque 02 · tarjeta 03 · crédito 04 · «Otro» se informa como 07 *Mixto* (con aviso). |

**Fecha de pago, tipo de retención en ISR, ITBIS llevado al costo y ITBIS por proporcionalidad** son los únicos datos de una compra que se pueden completar **después de registrarla** (no cambian la contabilidad): en el detalle de la compra, bloque «Datos para el formato 606» (`PATCH /v1/purchases/:id/dgii`; la base de datos sigue bloqueando cualquier otro cambio). El ITBIS al costo más el de proporcionalidad no pueden pasar del ITBIS de la compra.

### 607 · ventas
Comprobantes emitidos (ni borradores ni rechazados por la DGII) por fecha de emisión en hora de Santo Domingo: facturas de crédito fiscal (E31), de consumo (E32), notas de débito (E33) y de crédito (E34). Los E41/E43 son compras y van en el 606.

| Campo | De dónde sale |
|---|---|
| RNC/Cédula/Pasaporte y Tipo Id | El comprador del comprobante (1 RNC, 2 cédula, 3 pasaporte). |
| NCF / NCF modificado | El e-NCF / en E33 y E34, el e-NCF que modifican. Las notas de crédito van con montos positivos. |
| Tipo de ingreso | 01 «Ingresos por operaciones (no financieros)» siempre. |
| Monto facturado, ITBIS, propina legal | Subtotal sin impuestos, ITBIS y propina del comprobante. |
| Efectivo, cheque/transferencia, tarjeta, crédito, otras formas | Los pagos del comprobante, con impuestos; **deben sumar el total** (lo que falta es venta a crédito, el vuelto sale del efectivo). |
| Fecha de retención, ITBIS retenido y retención de renta por terceros | Lo que se anote en el comprobante, en el bloque «Retenciones del cliente» de su detalle (`PATCH /v1/documents/:id/retentions`, en pesos; el comprobante sigue congelado, la base de datos solo deja cambiar esas tres columnas). |
| Selectivo, otros impuestos | Vacíos (no se capturan todavía). |

**Ventas con retención**: si el cliente retuvo en el **mismo mes** de la emisión, va en una sola línea con sus montos y fecha. Si retuvo en un **mes posterior**, la línea de la emisión va sin retención (el pago a crédito) y la venta **se repite en el mes de la retención**, con los montos y la fecha (así lo explica la ayuda de la DGII sobre ventas a crédito); el panel avisa cuántas se repiten.

**Facturas de consumo (E32)**: solo las de **RD$250,000 o más** van en el archivo (con el comprador identificado); las menores se resumen en la Oficina Virtual.

### 608 · anulados
Los rangos de e-NCF anulados ante la DGII (ANECF) y **confirmados** en el mes: cada número del rango es una línea, con la fecha de confirmación y el tipo **08** «Errores en secuencia de NCF».

## 3. Las validaciones que hace antes de dejarte descargar

NCF de 11 o 13 caracteres (19 solo para comprobantes de antes de mayo 2018) · RNC de 9 y cédula de 11 dígitos · tipo de identificación presente · fecha de pago obligatoria si hay retenciones (y no anterior al comprobante) · tipo de retención en ISR obligatorio si hay ISR retenido · ITBIS llevado al costo no mayor que el ITBIS · formas de pago que suman el total (607) · montos no negativos · tipo de anulación 1–10 · máximo de registros por archivo · período AAAAMM.

## 4. Lo que no se verificó y lo que falta

- **El diseño exacto del archivo de texto** no lo explican los instructivos (describen la plantilla de Excel que lo genera). Se armó como lo genera esa plantilla: primera línea `606|RNC|AAAAMM|cantidad`, un registro por línea con los campos separados por `|`, fechas `AAAAMMDD`, montos con punto y dos decimales, códigos con dos dígitos (`02`), campos vacíos sin nada entre las barras, y saltos de línea Windows. **No se probó contra la Herramienta de Pre-validación ni contra la Oficina Virtual.** Si la pre-validación rechaza algo (p. ej. si espera un código de un dígito o ceros en lugar de campos vacíos), es un ajuste de una línea en `packages/core/src/dgii-formats.ts`.
- **Contribuyentes que emiten e-CF**: la DGII ya recibe sus comprobantes electrónicos y ha ido reemplazando el envío del 607 y del 608 de esos comprobantes por la información que ella misma tiene; **confirma con tu contador** qué sigue siendo obligatorio en tu caso antes de enviar. Los archivos sirven igual como cuadre contra lo que la DGII tiene.
- Los 608 de comprobantes *distintos* de rangos anulados (una factura con serie B anulada, números dañados) no existen en el sistema: no se emiten comprobantes en papel.
- La repetición de una venta en el mes de la retención y los montos de pago de esa segunda línea (se copian los de la emisión) se basan en la ayuda de la DGII, no en los instructivos: confírmalo con tu contador y con la pre-validación.
- **Notas de crédito/débito de proveedores** en el 606 (NCF modificado): no se registran todavía.
- Servicios o bienes: la separación del 606 se decide por el tipo de gasto, no línea por línea.
- La separación del 607 de las facturas de consumo y su «Resumen General» está en el panel, pero el monto exacto que pide la Oficina Virtual (¿todas las E32 o solo las menores de RD$250,000?) conviene confirmarlo con el contador.
