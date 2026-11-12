# Servicios públicos para la certificación (túnel HTTPS)

Durante la certificación la DGII **llama a tus servicios**: te envía e-CF (pruebas de comunicación), aprobaciones
comerciales y, si lo registras, pide una semilla para autenticarse. Esos servicios ya existen en la API
(`apps/api/src/routes/fe.ts`), pero tu PC no es accesible desde internet. Como la regla del proyecto es **no desplegar
hasta terminar**, la salida es un **túnel HTTPS**: un programa en tu PC abre una conexión saliente y te da una
dirección pública que llega a tu API local.

## 1. Las direcciones que se registran en la postulación

| En el formulario | Ruta de nuestra API |
|---|---|
| URL Recepción | `https://TU-DOMINIO/fe/recepcion/api/ecf` |
| URL Aprobación | `https://TU-DOMINIO/fe/aprobacioncomercial/api/ecf` |
| URL Autenticación (opcional) | `https://TU-DOMINIO/fe/autenticacion/api/semilla` y `/fe/autenticacion/api/validacioncertificado` |

Una sola dirección sirve para todas las empresas del sistema: el receptor identifica a la empresa por el
`RNCComprador` del XML. Confirma en la ayuda del portal si piden la ruta completa o solo el dominio; nuestro cliente
acepta las dos formas al leer el directorio (`peerEndpoint`).

> El dominio debe ser **estable durante toda la certificación** (son días o semanas). Los túneles rápidos sin cuenta
> (`*.trycloudflare.com`) cambian de dirección cada vez que se reinician: sirven para probar, no para registrar.

## 2. Cloudflare Tunnel (recomendado)

Gratis, sin abrir puertos del router y con HTTPS incluido. Necesitas una cuenta de Cloudflare y **un dominio**
administrado allí (puede ser uno barato, solo para esto).

```bash
# Windows: winget install --id Cloudflare.cloudflared
cloudflared tunnel login
cloudflared tunnel create facturacion-cert
cloudflared tunnel route dns facturacion-cert cert.TU-DOMINIO.com
```

Crea `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: facturacion-cert
credentials-file: C:\Users\TU_USUARIO\.cloudflared\<id-del-túnel>.json
ingress:
  # Solo los servicios públicos /fe: el resto de la API (panel, sesiones) no queda expuesto.
  - hostname: cert.TU-DOMINIO.com
    path: ^/fe/
    service: http://localhost:3001
  - service: http_status:404
```

Y arráncalo mientras dure la prueba:

```bash
cloudflared tunnel run facturacion-cert
```

## 3. La API mientras dure la certificación

- `pnpm dev` (o la API sola) en el puerto 3001, con el `.env` de siempre.
- `TRUST_PROXY="true"` en el `.env`: así el límite de uso de `/fe` cuenta la IP real que envía Cloudflare y no la del
  túnel (todas las peticiones llegarían desde la misma IP).
- `FISCAL_WORKER="true"` para que el trabajador envíe a la DGII, consulte resultados y entregue aprobaciones y e-CF.
- En **Configuración fiscal**: datos del emisor con su cédula/RNC, certificado `.p12` cargado, ambiente
  **Certificación** cuando la DGII habilite las pruebas (antes, **Pruebas** = TesteCF), y «Exigir autenticación» solo
  si registraste la URL de autenticación.

## 4. Comprobar antes de registrar

Desde otra red (por ejemplo, los datos del teléfono):

```bash
curl -i https://cert.TU-DOMINIO.com/fe/autenticacion/api/semilla
```

Debe responder `200` con un `<SemillaModel>`. Una ruta fuera de `/fe/` debe responder `404` (no se expone el panel).

## 5. Al terminar

Detén `cloudflared`. Para **producción** (paso 12 de la certificación) se registran las URL definitivas: para entonces
la API ya debe estar desplegada (ver [DESPLIEGUE.md](DESPLIEGUE.md)), porque los otros contribuyentes te enviarán e-CF
a cualquier hora.
