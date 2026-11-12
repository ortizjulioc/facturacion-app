-- La norma pide enviar cada e-CF a la DGII al emitirlo: las empresas nuevas nacen con el envío automático activado.
-- Las que ya existen conservan lo que eligieron.
ALTER TABLE "company_profile" ALTER COLUMN "sendToDgii" SET DEFAULT true;
