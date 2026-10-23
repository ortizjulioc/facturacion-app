# Instalador de la caja y auto-actualización

Cómo se genera el instalador de Windows de la caja (`apps/pos`), cómo se publican las versiones nuevas y cómo se actualizan solas las cajas ya instaladas.

## 1. Cómo funciona

- **Instalador**: `electron-builder` genera un `.exe` de NSIS (Windows 64 bits). Se instala **por usuario**, sin pedir administrador, en `%LOCALAPPDATA%\Programs`, con acceso directo en el escritorio y en el menú Inicio. Las ventas guardadas en la caja (`pos.sqlite`, en `%APPDATA%`) **no se borran al desinstalar ni al actualizar**.
- **Las versiones las publica la propia API**, en `GET /updates/caja/<archivo>` (público, solo sirve `latest.yml`, el instalador `.exe` y su `.blockmap`). La caja toma la dirección del servidor al que está conectada, así que no hay nada que configurar en cada PC.
- **Auto-actualización** (`electron-updater`): la caja busca una versión nueva 30 segundos después de abrir y luego **cada 4 horas**. Si hay una, **la descarga en segundo plano** (se ve «Actualización 37 %» arriba) y queda lista.
- **Nunca se reinicia sola**: una caja en plena venta no se puede interrumpir. Al terminar la descarga aparece el botón **«Actualizar a vX»**. Si el cajero lo pulsa, la caja se cierra, se instala y se vuelve a abrir (si hay productos en el carrito avisa que se perderán). Si no lo pulsa, **se instala sola al cerrar la caja** al final del día.
- **Sin internet o sin versiones publicadas** no pasa nada: el error queda guardado y se reintenta en la siguiente revisión. La caja nunca baja a una versión anterior.
- Solo está activa en la caja **instalada**. En desarrollo (`pnpm dev`) y en las pruebas automáticas (`smoke`) no se actualiza, salvo con `POS_UPDATE_FORCE=1`.

## 2. Generar el instalador

```bash
pnpm --filter @facturacion/pos dist
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
2. Windows mostrará **«Windows protegió su PC / editor desconocido»** porque el instalador **no está firmado** (ver §6): *Más información → Ejecutar de todas formas*.
3. Se instala y abre sola; sigue la configuración de siempre (servidor, empresa, caja, PIN).

## 5. Probar la actualización de punta a punta

Con dos versiones compiladas (p. ej. 0.1.0 y 0.2.0, esta última con `-c.extraMetadata.version=0.2.0`), una carpeta que tenga ambos instaladores y blockmaps más el `latest.yml` de la nueva, y la API corriendo con `POS_RELEASES_DIR` apuntando a ella:

```bash
POS_EXE="apps/pos/dist/win-unpacked/Caja Facturación.exe" POS_UPDATE_URL=http://localhost:3001/updates/caja POS_EXPECT_VERSION=0.2.0 node apps/pos/scripts/update-scenario.mjs
```

Abre la caja vieja, le pide buscar y espera a que la nueva quede descargada («lista para instalar»). No instala nada. También se puede probar que la caja empaquetada arranca con `POS_EXE=<ruta al .exe> pnpm --filter @facturacion/pos smoke`.

## 6. Lo que falta y lo que no se verificó

- **Firma de código**: sin ella, Windows SmartScreen avisa al instalar (y a veces al actualizar, hasta que el instalador gana «reputación»). Hace falta un certificado de firma de código (EV o estándar, distinto del certificado de la DGII); con él se activa en `electron-builder.yml` (`signExecutable` y las variables `CSC_LINK`/`CSC_KEY_PASSWORD`). Es lo primero que conviene hacer antes de entregar cajas a clientes.
- **El instalador no se ejecutó** en una PC limpia en estas pruebas, ni se probó el ciclo completo «Actualizar a vX» (cerrar, instalar y reabrir). Lo verificado fue: el instalador se genera con su `latest.yml` y `.blockmap`; la caja **empaquetada** arranca y responde (`smoke`); y, contra la API de verdad, una caja 0.1.0 consulta, descarga y deja lista la 0.2.0 (el estado pasa por «descargando» y llega a «lista»). La instalación al cerrar la caja es el comportamiento estándar de `electron-updater`; conviene probarlo una vez en una PC real.
- **Descarga por diferencias**: la API soporta los rangos que usa, pero en la prueba la caja bajó el instalador completo porque no tenía cacheado el anterior. Se verá con instalaciones reales.
- **Arranque con el sistema** (que la caja se abra al encender la PC): todavía no.
- **Solo Windows 64 bits** (macOS/Linux no están en el alcance de la caja).
- La carpeta de caché de la actualización se llama `@facturacionpos-updater` (por el nombre del paquete); es solo estético.
