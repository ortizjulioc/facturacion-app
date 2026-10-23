# Instalador de la caja y auto-actualización

Cómo se genera el instalador de Windows de la caja (`apps/pos`), cómo se publican las versiones nuevas y cómo se actualizan solas las cajas ya instaladas.

## 1. Cómo funciona

- **Instalador**: `electron-builder` genera un `.exe` de NSIS (Windows 64 bits). Se instala **por usuario**, sin pedir administrador, en `%LOCALAPPDATA%\Programs`, con acceso directo en el escritorio y en el menú Inicio. Las ventas guardadas en la caja (`pos.sqlite`, en `%APPDATA%`) **no se borran al desinstalar ni al actualizar**.
- **Las versiones las publica la propia API**, en `GET /updates/caja/<archivo>` (público, solo sirve `latest.yml`, el instalador `.exe` y su `.blockmap`). La caja toma la dirección del servidor al que está conectada, así que no hay nada que configurar en cada PC.
- **Auto-actualización** (`electron-updater`): la caja busca una versión nueva 30 segundos después de abrir y luego **cada 4 horas**. Si hay una, **la descarga en segundo plano** (se ve «Actualización 37 %» arriba) y queda lista.
- **Nunca se reinicia sola**: una caja en plena venta no se puede interrumpir. Al terminar la descarga aparece el botón **«Actualizar a vX»**. Si el cajero lo pulsa, la caja se cierra, se instala y se vuelve a abrir (si hay productos en el carrito avisa que se perderán). Si no lo pulsa, **se instala sola al cerrar la caja** al final del día.
- **Sin internet o sin versiones publicadas** no pasa nada: el error queda guardado y se reintenta en la siguiente revisión. La caja nunca baja a una versión anterior.
- **Abre sola al encender la PC**: la primera vez que corre la caja instalada se registra en el inicio de Windows (clave `Run` del usuario). Desde entonces manda lo que se elija con el botón **«Abrir al encender: sí/no»** de la pantalla; actualizar o reinstalar no lo vuelve a cambiar, y si se quita desde «Aplicaciones de inicio» de Windows la pantalla lo refleja. En desarrollo no se registra nada.
- Solo está activa en la caja **instalada**. En desarrollo (`pnpm dev`) y en las pruebas automáticas (`smoke`) no se actualiza, salvo con `POS_UPDATE_FORCE=1`.

## 2. Generar el instalador

```bash
pnpm --filter @facturacion/pos dist            # sin firma
pnpm --filter @facturacion/pos dist:signed     # firmado: exige el certificado y verifica la firma al terminar
```

Compila la caja y deja en `apps/pos/dist/`:

| Archivo | Para qué |
|---|---|
| `Caja-Facturacion-Setup-X.Y.Z.exe` | El instalador (unos 110 MB). Es el que se entrega para instalar una caja nueva. |
| `Caja-Facturacion-Setup-X.Y.Z.exe.blockmap` | Mapa de bloques: permite descargar solo lo que cambió entre versiones. |
| `latest.yml` | Dice cuál es la versión vigente y su huella (`sha512`). |
| `win-unpacked/` | La caja sin instalar (útil para pruebas rápidas; no se publica). |

`pnpm --filter @facturacion/pos run pack` genera solo `win-unpacked/` (más rápido). Ojo: se escribe `run pack` porque `pnpm pack` es otro comando de pnpm.

La versión sale de `apps/pos/package.json` (`version`, formato `X.Y.Z`). **Súbela antes de cada versión nueva**: la caja solo se actualiza si la versión publicada es mayor que la instalada.

## 3. Publicar una versión

1. Sube `version` en `apps/pos/package.json` y haz `pnpm --filter @facturacion/pos dist`.
2. Copia a la carpeta de versiones del servidor (`POS_RELEASES_DIR`) el `.exe` y el `.exe.blockmap` nuevos y, **al final**, el `latest.yml`. Así ninguna caja ve una versión cuyo instalador todavía no está.
3. **No borres los archivos de las versiones anteriores** (al menos el `.blockmap`): la descarga por diferencias los necesita para saber qué bloques ya tiene la caja. Si no están, la caja descarga el instalador completo (funciona igual, solo es más lento).
4. Listo: en 4 horas como máximo (o al abrir la caja) todas las cajas la descargan.

### La carpeta en el servidor

En la API (Dokploy) se define `POS_RELEASES_DIR`, por ejemplo `/data/releases/caja`, y se monta un **volumen persistente** en esa ruta para que sobreviva a los despliegues. Se sube el contenido con `scp`/`rsync` o desde el panel de archivos de Dokploy. Si la variable no está definida, `/updates/caja/*` responde 404 y las cajas siguen funcionando sin actualizarse.

```env
POS_RELEASES_DIR=/data/releases/caja
```

La API entiende `Range` (incluidos varios rangos a la vez, en `multipart/byteranges`), `ETag`, `If-None-Match` e `If-Range`; `latest.yml` no se guarda en caché. Detrás de Cloudflare u otro CDN, no lo cachees (o excluye `/updates/caja/latest.yml`) o las cajas verán la versión nueva con retraso.

## 4. Instalar una caja nueva

1. Copia `Caja-Facturacion-Setup-X.Y.Z.exe` a la PC y ejecútalo.
2. Si el instalador **no está firmado** (ver §6), Windows mostrará **«Windows protegió su PC / editor desconocido»**: *Más información → Ejecutar de todas formas*. Con un instalador firmado ese aviso desaparece (o se va con la reputación, según el tipo de certificado).
3. Se instala y abre sola; sigue la configuración de siempre (servidor, empresa, caja, PIN).

## 5. Probar la actualización de punta a punta

Con dos versiones compiladas (p. ej. 0.1.0 y 0.2.0, esta última con `-c.extraMetadata.version=0.2.0`), una carpeta que tenga ambos instaladores y blockmaps más el `latest.yml` de la nueva, y la API corriendo con `POS_RELEASES_DIR` apuntando a ella:

```bash
POS_EXE="apps/pos/dist/win-unpacked/Caja Facturación.exe" POS_UPDATE_URL=http://localhost:3001/updates/caja POS_EXPECT_VERSION=0.2.0 node apps/pos/scripts/update-scenario.mjs
```

Abre la caja vieja, le pide buscar y espera a que la nueva quede descargada («lista para instalar»). No instala nada. También se puede probar que la caja empaquetada arranca con `POS_EXE=<ruta al .exe> pnpm --filter @facturacion/pos smoke`.

## 6. Firma de código

Sin firma, Windows SmartScreen avisa al instalar. La firma ya está **lista en el proceso de generación**; solo falta el certificado, que es **distinto del certificado de la DGII**: se compra a una entidad de firma de código (Sectigo, DigiCert, SSL.com…). Un certificado **EV** quita el aviso de inmediato; uno estándar (OV) lo quita cuando el instalador gana «reputación» con las descargas. Desde 2023 los certificados nuevos se entregan en un token o en un servicio en la nube (HSM) y ya no como archivo `.pfx` descargable; si es tu caso, el proveedor da su propia herramienta o un servicio de firma que se conecta a electron-builder (por ejemplo `azureSignOptions` para Azure Trusted Signing), y hay que ajustar `electron-builder.yml`. Con un `.pfx` basta con esto:

```powershell
$env:CSC_LINK = "C:/ruta/firma-codigo.pfx"          # o el contenido en base64
$env:CSC_KEY_PASSWORD = "<contraseña>"
$env:POS_PUBLISHER_NAME = "NOMBRE DE LA EMPRESA"    # el CN del certificado
pnpm --filter @facturacion/pos dist:signed
```

- `dist:signed` **se niega a generar** si faltan las variables y, al terminar, **verifica con Windows** que el instalador quedó con firma válida (si no, sale con error y no se debe publicar).
- Se firman el programa, el desinstalador y el instalador. Nunca pongas el certificado ni su contraseña en un archivo del proyecto (`.pfx` está en `.gitignore`): van en variables de entorno o en los secretos del CI.
- `POS_PUBLISHER_NAME` queda grabado en la caja instalada: la auto-actualización **solo acepta instaladores firmados por ese nombre**, de modo que un servidor de versiones comprometido no podría colar un programa ajeno. Actívalo desde la primera versión firmada (las cajas instaladas antes sin ese nombre no lo verifican hasta que reciban una versión que lo traiga).
- Para probar el proceso sin certificado real: un certificado autofirmado (`New-SelfSignedCertificate -Type CodeSigningCert`) exportado a `.pfx` y `POS_ALLOW_UNTRUSTED=1` (acepta que Windows no confíe en el emisor). No se entrega nada firmado así.

## 7. Lo que falta y lo que no se verificó

- **Certificado de firma real**: no hay uno todavía; el instalador actual sale sin firma. Verificado con un certificado autofirmado de prueba: electron-builder firma el programa, el desinstalador y el instalador, `dist:signed` verifica la firma y rechaza la que Windows no considera válida, y el nombre del firmante queda en `app-update.yml`. **No verificado**: una firma de un certificado real de confianza (estado «Valid»), ni que `electron-updater` acepte una actualización firmada por ese nombre (necesita un certificado de confianza).
- **El instalador no se ejecutó** en una PC limpia en estas pruebas, ni se probó el ciclo completo «Actualizar a vX» (cerrar, instalar y reabrir). Lo verificado fue: el instalador se genera con su `latest.yml` y `.blockmap`; la caja **empaquetada** arranca y responde (`smoke`); y, contra la API de verdad, una caja 0.1.0 consulta, descarga y deja lista la 0.2.0 (el estado pasa por «descargando» y llega a «lista»). La instalación al cerrar la caja es el comportamiento estándar de `electron-updater`; conviene probarlo una vez en una PC real.
- **Descarga por diferencias**: la API soporta los rangos que usa, pero en la prueba la caja bajó el instalador completo porque no tenía cacheado el anterior. Se verá con instalaciones reales.
- **Arranque con el sistema**: verificado con la caja empaquetada y el registro de Windows real (queda activado la primera vez, se puede quitar y poner desde la pantalla). No se verificó que Windows la abra de verdad al iniciar sesión.
- **Solo Windows 64 bits** (macOS/Linux no están en el alcance de la caja).
- La carpeta de caché de la actualización se llama `@facturacionpos-updater` (por el nombre del paquete); es solo estético.
