# Prueba contra TesteCF (pre-certificación de la DGII)

Guía para probar, con tu certificado digital y la DGII de verdad, lo que el sistema ya sabe hacer: armar y firmar un e-CF, autenticarse, enviarlo, esperar el resultado, enviar el resumen de una factura de consumo y hacer una nota de crédito.

Hasta hoy **todo se probó solo contra una DGII simulada** (lo que dice la documentación oficial, no lo que responde de verdad). Esta prueba es el paso que falta para saber qué hay que ajustar.

> Esto NO es la certificación formal de la DGII (el conjunto de pruebas que ella exige para autorizarte como emisor). Es un ensayo previo que te dice si el certificado, las rutas y el formato funcionan, y te deja los archivos para corregir lo que no.

## 1. Qué necesitas

| Cosa | Detalle |
| --- | --- |
| **Certificado digital** (`.p12` o `.pfx`) | Emitido por una entidad autorizada por la DGII. El número de serie o el nombre del titular debe llevar tu **RNC** (o cédula): el estándar pide que el campo SN coincida. |
| **Contraseña del certificado** | Va en la variable de entorno `TESTECF_PASSWORD`, nunca en la línea de comandos ni en un archivo del proyecto. |
| **Empresa habilitada** | En la Oficina Virtual de la DGII, la empresa debe estar registrada como **emisor electrónico** con acceso a **pre-certificación** (TesteCF). Allí la DGII entrega secuencias de prueba: del 1 al 10,000,000 por tipo (50,000,000 para consumo), con vencimiento 31-12-2028 (confírmalo en el portal: lo cambia cuando quiere). |
| **RNC del emisor** | El de la empresa titular del certificado. |
| **RNC de un comprador** | Para el E31 y el E32 grande. Por omisión se usa el mismo RNC del emisor; si la DGII lo rechaza («emisor y comprador iguales»), usa el de otro contribuyente electrónico de pruebas con `--buyer-rnc`. |

## 2. Antes de nada: ¿se llega a la DGII?

```bash
pnpm --filter @facturacion/ecf testecf --probe
```

Pide una semilla al servicio de autenticación de TesteCF (solo lectura, no envía nada tuyo). Debe decir `HTTP 200 · devolvió una semilla`. Con `--env cert` prueba CerteCF.

## 3. Ensayo sin enviar nada (simulacro)

Arma y firma los cuatro comprobantes, comprueba que las firmas verifican y deja los XML para que los revises, **sin tocar la DGII**:

```bash
TESTECF_PASSWORD=tu-clave pnpm --filter @facturacion/ecf testecf \
  --p12 ruta/a/tu-certificado.p12 --rnc 101000000 --dry-run
```

(En PowerShell: `$env:TESTECF_PASSWORD="tu-clave"; pnpm --filter @facturacion/ecf testecf --p12 ... --dry-run`.)

Cada corrida deja una carpeta en `testecf-out/` con los XML y un `resumen.json`. El simulacro no gasta números.

## 4. La prueba de verdad

```bash
TESTECF_PASSWORD=tu-clave pnpm --filter @facturacion/ecf testecf \
  --p12 ruta/a/tu-certificado.p12 --rnc 101000000 \
  --name "TU EMPRESA SRL" --address "Tu dirección, Ciudad" \
  --buyer-rnc 131000000
```

Hace, en orden:

1. **Autenticación**: pide la semilla, la firma con tu certificado y la cambia por un token. Si falla, se detiene y dice por qué (certificado, ambiente, red).
2. **E31** (factura de crédito fiscal): la envía, guarda el *TrackId* y consulta el resultado hasta que sea final.
3. **E32 menor a RD$250,000**: arma el e-CF, lo firma (de ahí sale el código de seguridad) y envía su **resumen (RFCE)**.
4. **E32 de RD$295,000**: pasa de RD$250,000, así que va completo, como un e-CF.
5. **E34** (nota de crédito) sobre el E31 aceptado.

Para correr solo algunos: `--only e31,e32`. Pasos: `e31`, `e32`, `e32-grande`, `e34` (la nota necesita el `e31` en la misma corrida).

**Números.** La DGII no deja repetir un e-NCF. El script recuerda el siguiente de cada tipo en `testecf-out/estado-<ambiente>-<RNC>.json`; si quieres empezar en otro número usa `--start-e31 N`, `--start-e32 N`, `--start-e34 N`. Un envío rechazado puede dejar el número «gastado» (lo dice `secuenciaUtilizada`): el script igual sigue con el siguiente.

### Cómo leer el resultado

```
→ E31 · factura de crédito fiscal · E310000000001
   TrackId 9f2c…
   ✔ ACCEPTED
```

- `ACCEPTED` / `ACCEPTED_CONDITIONAL`: la DGII lo dio por válido (el condicional trae mensajes con lo que no cumplió).
- `REJECTED`: se rechazó; los mensajes (`código: texto`) dicen por qué.
- `IN_PROCESS`: sigue procesándolo; consulta el TrackId más tarde.
- `ERROR`: no llegó a un resultado (red, autenticación, un dato que el sistema no pudo armar); el motivo va al lado.

Cada comprobante imprime también la **dirección del QR** que llevaría su representación impresa: ábrela en el navegador y la DGII debe decir si lo encuentra y su estado.

## 5. Si algo falla

Revisa `resumen.json` y los archivos `*.respuesta.json` / `*.resultado-N.json` de la carpeta de la corrida. **No compartas** el `.p12` ni la contraseña; sí puedes compartir esos archivos (y los XML, que van firmados pero no contienen la llave).

Rechazos frecuentes (de la documentación de la DGII) y qué mirar:

| Mensaje | Qué revisar |
| --- | --- |
| Certificado y/o firma inválida | El certificado vigente y de una entidad autorizada; que el XML no se haya alterado después de firmar; el algoritmo (SHA-256). |
| Firmante no corresponde a un delegado autorizado para el RNC emisor | El RNC del certificado debe ser el del emisor (o un delegado registrado en la Oficina Virtual). |
| El e-NCF no está autorizado para el RNC emisor / está vencido | Las secuencias de pre-certificación del portal y su vencimiento; `--expiry`. |
| Estructura del comprobante (XML) no es válida | Aquí está lo que más conviene recoger: el mensaje trae el campo exacto. |
| El RNC emisor no corresponde a un emisor electrónico / no existe / no está activo | La habilitación de la empresa en la Oficina Virtual. |

## 6. Lo que esta prueba debe aclarar

El sistema se escribió contra los PDF oficiales, y hay detalles que **solo la DGII real confirma**. Anota qué contesta en cada caso:

- Nombre del elemento que envuelve cada rango en la anulación de rangos (`Secuencia`) y códigos de respuesta de ese servicio.
- Códigos de motivo del acuse de recibo (1 especificación, 2 firma, 3 duplicado, 4 comprador).
- Si `TotalITBIS` debe ir cuando todo es exento; si `TablaSubDescuento` es obligatoria junto a `DescuentoMonto`.
- Si acepta cantidades con 3 decimales (el sistema solo admite 2).
- Si el E31 con comprador igual al emisor se acepta.
- Si el RFCE (formato de enero de 2020) sigue vigente tal cual.
- Si el servicio de TrackIds y de anulación existen en el ambiente que uses.

## 7. Después: probar desde la aplicación

Cuando el prototipo acepte los comprobantes:

1. En **Configuración fiscal**: ambiente *Pruebas (TesteCF)*, tus datos reales, **certificado digital** cargado y las **secuencias** de prueba que te dio la DGII.
2. Activa **«Enviar cada comprobante firmado a la DGII automáticamente»** (o usa «Enviar a la DGII» en una factura emitida).
3. Emite un E31 y un E32 desde Facturas o la caja; en el detalle verás el estado del envío (en cola → enviado → aceptado/rechazado), el TrackId y los mensajes de la DGII.
4. Para recibir comprobantes de proveedores la API debe ser **pública** (dominio con HTTPS) y esas direcciones se registran en la Oficina Virtual; las ves en **e-CF recibidos → Dónde reciben tus servicios**.

## 8. Seguridad

- No guardes el certificado ni su contraseña en el repositorio. `testecf-out/` está en `.gitignore`.
- El prototipo solo permite `test` y `cert`: **no envía a producción**, donde cada comprobante tiene validez fiscal.
- Usa la contraseña por variable de entorno y bórrala de la sesión al terminar.
