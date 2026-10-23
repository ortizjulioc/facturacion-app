# Despliegue en Oracle Cloud + Dokploy

Servidor Ampere A1 (**arm64**) con Dokploy. Cuatro piezas: base de datos, `api`, `web` y (más adelante) `worker`.

```
GitHub (push a main)
   └─ Actions: construye imágenes linux/arm64 ─► GHCR ─► webhook ─► Dokploy redespliega
```

## 0. Requisitos previos

- Dos registros DNS tipo **A** hacia la IP pública del servidor Oracle:
  `app.tudominio.com` (web) y `api.tudominio.com` (API).
- Puertos **80** y **443** abiertos en la *Security List* de la VCN de Oracle **y** en el firewall del sistema operativo (`iptables`/`firewalld`; en Oracle Linux/Ubuntu vienen cerrados por defecto).
- El repositorio en GitHub. Las imágenes se publican en `ghcr.io/<tu-usuario>/facturacion-api` y `…-web`.

## 1. Base de datos

1. Dokploy → proyecto **facturacion** → *Create Service* → **Database → PostgreSQL 18**. Nombre: `postgres`. **No** expongas el puerto al exterior.
2. Anota el *Internal Host* (algo como `facturacion-postgres-xxxx`), el usuario y la clave administrativa que muestra Dokploy.
3. Crea los roles y la base. Desde la terminal del contenedor de Postgres (Dokploy → servicio → *Terminal*) o con `docker exec`:

   ```bash
   createdb -U <admin> facturacion
   psql -U <admin> -d facturacion -v ON_ERROR_STOP=1 -v dbname=facturacion \
     -v migrator_password="'<CLAVE_MIGRATOR_LARGA>'" \
     -v app_password="'<CLAVE_APP_LARGA>'" \
     -f setup-roles.sql      # contenido de packages/db/scripts/setup-roles.sql
   ```

   Genera las claves con `openssl rand -hex 24`. Guárdalas en un gestor de contraseñas.
4. **Backups:** Dokploy → servicio de BD → *Backups* → destino **S3** (OCI Object Storage, ver §5) → programación diaria `0 3 * * *`, retención 14 días. Prueba una **restauración** antes de confiar en ellos.

## 2. Aplicación `api`

Dokploy → *Create Service* → **Application** → proveedor **Docker** (imagen):

| Campo | Valor |
|---|---|
| Docker Image | `ghcr.io/<usuario>/facturacion-api:latest` |
| Registry | GHCR: usuario de GitHub + *Personal Access Token* con `read:packages` |
| Puerto del contenedor | `3001` |
| Dominio | `api.tudominio.com`, HTTPS con Let's Encrypt |
| Health check | `GET /health` |

Variables de entorno:

```env
NODE_ENV=production
API_PORT=3001
DATABASE_URL=postgresql://facturacion_app:<CLAVE_APP_LARGA>@<host-interno-postgres>:5432/facturacion
DATABASE_URL_MIGRATE=postgresql://facturacion_migrator:<CLAVE_MIGRATOR_LARGA>@<host-interno-postgres>:5432/facturacion
BETTER_AUTH_SECRET=<salida de: openssl rand -base64 32>
API_PUBLIC_URL=https://api.tudominio.com
WEB_ORIGIN=https://app.tudominio.com
COOKIE_DOMAIN=.tudominio.com
LOG_LEVEL=info
```

Opcional, para la auto-actualización de las cajas (ver [CAJA-INSTALADOR.md](CAJA-INSTALADOR.md)): `POS_RELEASES_DIR=/data/releases/caja`, con un volumen persistente montado en esa ruta donde se copian el instalador, su `.blockmap` y `latest.yml`.

Al arrancar, el contenedor ejecuta `prisma migrate deploy` con `DATABASE_URL_MIGRATE` y luego inicia la API con `DATABASE_URL` (el rol sin privilegios, sujeto a RLS).

## 3. Aplicación `web`

Misma mecánica con la imagen `ghcr.io/<usuario>/facturacion-web:latest`, puerto `3000`, dominio `app.tudominio.com`.

```env
NODE_ENV=production
API_INTERNAL_URL=http://<nombre-del-servicio-api>:3001
```

`NEXT_PUBLIC_API_URL` **no** va aquí: se incrusta al construir la imagen. Defínela en GitHub → *Settings → Secrets and variables → Actions → Variables* como `NEXT_PUBLIC_API_URL = https://api.tudominio.com`.

## 4. Webhooks y GitHub

1. En cada aplicación de Dokploy: *Deployments* → copia la **Webhook URL**.
2. En GitHub → *Settings → Secrets and variables → Actions*:
   - Secrets: `DOKPLOY_WEBHOOK_API`, `DOKPLOY_WEBHOOK_WEB`.
   - Variable: `NEXT_PUBLIC_API_URL`.
3. Haz push a `main`: `.github/workflows/deploy.yml` construye las imágenes arm64, las sube a GHCR y llama a los webhooks.
4. Primer despliegue: si GHCR creó los paquetes como privados, mantenlos así y usa el token del paso 2 en Dokploy.

## 5. Object Storage (para backups y, más adelante, XML/PDF)

1. OCI Console → *Storage → Buckets* → crea `facturacion-backups` y `facturacion-docs` (privados).
2. Perfil de usuario → *Customer secret keys* → genera una (access key + secret; el secret solo se muestra una vez).
3. En Dokploy → *Settings → S3 Destinations*:
   - Endpoint: `https://<namespace>.compat.objectstorage.<región>.oraclecloud.com`
   - Region: la de tu tenancy (p. ej. `us-ashburn-1`), Bucket: `facturacion-backups`.
   - Activa *path style* si el formulario lo ofrece.

## 6. Verificación

```bash
curl https://api.tudominio.com/health   # {"status":"ok"}
curl https://api.tudominio.com/ready    # {"status":"ready"}  → hay conexión a Postgres
```

Abre `https://app.tudominio.com`, crea una empresa en `/registro` y una sucursal en `/panel`.

## Problemas comunes

| Síntoma | Causa probable |
|---|---|
| `exec format error` al arrancar | La imagen no es arm64. Revisa `platforms: linux/arm64` en `deploy.yml`. |
| Let's Encrypt no emite el certificado | Puertos 80/443 cerrados en la Security List u OS, o DNS aún sin propagar. |
| Login funciona pero el panel dice "no autenticado" | `COOKIE_DOMAIN` mal puesto (debe empezar con punto) o `WEB_ORIGIN` no coincide exactamente con la URL del navegador. |
| `permission denied for table …` | Las tablas se crearon con otro rol: ejecuta de nuevo `setup-roles.sql` **antes** de la primera migración. |
| `prisma migrate deploy` falla en el arranque | `DATABASE_URL_MIGRATE` apunta al rol equivocado o a un host público en lugar del interno. |
