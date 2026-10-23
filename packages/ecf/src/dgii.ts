import { DOMParser } from "@xmldom/xmldom";
import {
  FISCAL_STATUS_BY_CODE,
  FiscalError,
  type FiscalMessage,
  type FiscalProvider,
  type FiscalStatus,
  type AnnulmentResult,
  type ApprovalResult,
  type DirectoryEntry,
  type SubmitInput,
  type SubmitResult,
  type SummaryResult,
  type TrackResult,
  type TrackSummary,
} from "./provider";
import { compactXml } from "./format";
import { serviceUrls } from "./qr";
import { signXml, type EcfCertificate } from "./sign";
import type { EcfEnvironment } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DgiiClientOptions = {
  env: EcfEnvironment;
  /** Certificado del emisor (o de un delegado autorizado): firma la semilla y los comprobantes. */
  certificate: EcfCertificate;
  fetch?: FetchLike;
  now?: () => Date;
  /** Milisegundos de espera por respuesta (30 s por defecto). */
  timeoutMs?: number;
};

type Token = { value: string; expiresAt: number };

/** Se renueva el token un minuto antes de que venza (dura una hora). */
const TOKEN_MARGIN_MS = 60_000;

const STATUS_BY_TEXT: Record<string, FiscalStatus> = {
  "no encontrado": "NOT_FOUND",
  aceptado: "ACCEPTED",
  rechazado: "REJECTED",
  "en proceso": "IN_PROCESS",
  "aceptado condicional": "ACCEPTED_CONDITIONAL",
};

const statusOfText = (text: string): FiscalStatus =>
  STATUS_BY_TEXT[text.trim().toLowerCase()] ?? "IN_PROCESS";

const asString = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

function messagesOf(raw: unknown): FiscalMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((m: { codigo?: unknown; valor?: unknown }) => {
    const text = asString(m?.valor);
    return text ? [{ code: asString(m.codigo) ?? "", text }] : [];
  });
}

/** Lo que se muestra al usuario cuando la DGII rechaza una solicitud. */
function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.mensaje)) {
      const joined = (b.mensaje as unknown[]).flatMap((m) => asString(m) ?? []).join(" · ");
      if (joined) return joined;
    }
    const direct = asString(b.mensaje) ?? asString(b.message) ?? asString(b.error) ?? asString(b.title);
    if (direct) return direct;
    if (Array.isArray(b.mensajes)) {
      const plain = (b.mensajes as unknown[]).flatMap((m) => asString(m) ?? []).join(" · ");
      if (plain) return plain;
    }
    const list = messagesOf(b.mensajes);
    if (list.length) return list.map((m) => m.text).join(" · ");
  }
  return typeof body === "string" && body.trim() ? body.trim().slice(0, 300) : fallback;
}

/**
 * Conexión directa con los servicios de facturación electrónica de la DGII: autenticación por semilla firmada,
 * recepción de e-CF y consulta de resultados. Guarda el token y lo renueva solo.
 *
 * Escrito contra «Descripción Técnica Servicios DGII» v1.7 (mayo 2026) y probado con una DGII simulada: todavía no se
 * ha ejecutado contra TesteCF.
 */
export class DgiiClient implements FiscalProvider {
  private token: Token | null = null;
  private authenticating: Promise<string> | null = null;
  private readonly doFetch: FetchLike;
  private readonly now: () => Date;
  private readonly urls: ReturnType<typeof serviceUrls>;

  constructor(private readonly opts: DgiiClientOptions) {
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => new Date());
    this.urls = serviceUrls(opts.env);
  }

  // ───────────── Autenticación ─────────────

  /** Token vigente; pide uno nuevo (semilla → firma → token) si no hay o está por vencer. */
  async authenticate(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_MARGIN_MS > this.now().getTime()) return this.token.value;
    // Varias peticiones a la vez comparten una sola autenticación.
    this.authenticating ??= this.fetchToken().finally(() => (this.authenticating = null));
    return this.authenticating;
  }

  private async fetchToken(): Promise<string> {
    const seedRes = await this.send("GET", `${this.urls.authentication}/api/autenticacion/semilla`, { accept: "*/*" });
    const seedXml = typeof seedRes === "string" ? seedRes : "";
    if (!/<SemillaModel[\s>]/.test(seedXml) || !/<valor>[^<]+<\/valor>/.test(seedXml)) {
      throw new FiscalError("La DGII no entregó una semilla de autenticación válida", "server");
    }
    // La DGII firma y valida sin preservar espacios: la semilla (que llega con sangrías) se compacta antes de firmarla.
    const signed = signXml(compactXml(seedXml), this.opts.certificate);

    const form = new FormData();
    form.append("xml", new Blob([signed], { type: "text/xml" }), "semilla.xml");
    const body = (await this.send("POST", `${this.urls.authentication}/api/autenticacion/validarsemilla`, { form })) as {
      token?: string;
      expira?: string;
    } | null;
    if (!body?.token) throw new FiscalError(messageOf(body, "La DGII no entregó un token"), "auth");
    const expires = body.expira ? Date.parse(body.expira) : NaN;
    // Sin fecha legible se asume la duración documentada (1 hora) menos el margen.
    this.token = { value: body.token, expiresAt: Number.isFinite(expires) ? expires : this.now().getTime() + 3_600_000 };
    return body.token;
  }

  // ───────────── Servicios ─────────────

  async submit(input: SubmitInput): Promise<SubmitResult> {
    const form = new FormData();
    form.append("xml", new Blob([input.xml], { type: "text/xml" }), `${input.rnc}${input.encf}.xml`);
    const body = (await this.authorized("POST", `${this.urls.reception}/api/facturaselectronicas`, { form })) as {
      trackId?: string;
      error?: string;
      mensaje?: string;
    } | null;
    if (!body?.trackId) throw new FiscalError(messageOf(body, "La DGII no devolvió un TrackId"), "rejected");
    return { trackId: body.trackId };
  }

  async result(trackId: string): Promise<TrackResult> {
    const url = `${this.urls.result}/api/consultas/estado?trackid=${encodeURIComponent(trackId)}`;
    const b = (await this.authorized("GET", url)) as Record<string, unknown> | null;
    if (!b || typeof b !== "object") throw new FiscalError("Respuesta inválida de la DGII", "server");
    const code = Number(b.codigo);
    return {
      trackId: asString(b.trackId) ?? trackId,
      status: FISCAL_STATUS_BY_CODE[code] ?? statusOfText(asString(b.estado) ?? ""),
      code: Number.isFinite(code) ? code : -1,
      statusText: asString(b.estado) ?? "",
      rnc: asString(b.rnc),
      encf: asString(b.eNCF) ?? asString(b.encf),
      sequenceUsed: typeof b.secuenciaUtilizada === "boolean" ? b.secuenciaUtilizada : null,
      receivedAt: asString(b.fechaRecepcion),
      messages: messagesOf(b.mensajes),
    };
  }

  async submitSummary(input: SubmitInput): Promise<SummaryResult> {
    const form = new FormData();
    form.append("xml", new Blob([input.xml], { type: "text/xml" }), `${input.rnc}${input.encf}.xml`);
    const b = await this.authorized("POST", `${this.urls.summaryReception}/api/recepcion/ecf`, { form });
    return summaryOf(b, "La DGII no devolvió el resultado del resumen");
  }

  async summaryResult(rnc: string, encf: string, securityCode: string): Promise<SummaryResult> {
    const q = `RNC_Emisor=${encodeURIComponent(rnc)}&ENCF=${encodeURIComponent(encf)}&Cod_Seguridad_eCF=${encodeURIComponent(securityCode)}`;
    const b = await this.authorized("GET", `${this.urls.summaryQuery}/api/Consultas/Consulta?${q}`);
    return summaryOf(b, "La DGII no devolvió el estado del resumen");
  }

  async submitApproval(input: SubmitInput): Promise<ApprovalResult> {
    const form = new FormData();
    form.append("xml", new Blob([input.xml], { type: "text/xml" }), `${input.rnc}${input.encf}.xml`);
    const b = (await this.authorized("POST", `${this.urls.approval}/api/aprobacioncomercial`, { form })) as Record<string, unknown> | null;
    const code = asString(b?.codigo) ?? "";
    const messages = Array.isArray(b?.mensaje) ? (b.mensaje as unknown[]).flatMap((m) => asString(m) ?? []) : asString(b?.mensaje) ? [asString(b?.mensaje)!] : [];
    return { approved: code === "1", status: asString(b?.estado) ?? "", code, messages };
  }

  async annulRanges(input: { xml: string; rnc: string; firstEncf: string }): Promise<AnnulmentResult> {
    // El servicio de anulación no se publica en certificación.
    if (this.opts.env === "CERT") throw new FiscalError("La anulación de rangos no está disponible en certificación", "config");
    const form = new FormData();
    form.append("xml", new Blob([input.xml], { type: "text/xml" }), `${input.rnc}${input.firstEncf}.xml`);
    const b = (await this.authorized("POST", `${this.urls.annulment}/api/operaciones/anularrango`, { form })) as Record<string, unknown> | null;
    const messages = Array.isArray(b?.mensajes) ? (b.mensajes as unknown[]).flatMap((m) => asString(m) ?? []) : asString(b?.mensajes) ? [asString(b?.mensajes)!] : [];
    // Un 200 con «excepto…» o «no fue posible…» es una anulación parcial o fallida: no se da por hecha.
    const failed = messages.some((m) => /excepci[oó]n|no fue posible|han sido utilizadas/i.test(m));
    return { annulled: !failed, code: asString(b?.codigo) ?? "", name: asString(b?.nombre) ?? "", messages };
  }

  async directoryOf(rnc: string): Promise<DirectoryEntry | null> {
    const body = await this.authorized("GET", `${this.urls.directory}/api/consultas/obtenerdirectorioporrnc?RNC=${encodeURIComponent(rnc)}`);
    const row = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | null | undefined;
    if (!row || typeof row !== "object" || !asString(row.rnc)) return null;
    return {
      name: asString(row.nombre) ?? "",
      rnc: asString(row.rnc)!,
      receptionUrl: asString(row.urlRecepcion) || null,
      approvalUrl: asString(row.urlAceptacion) || null,
      authenticationUrl: asString(row.urlOpcional) || null,
    };
  }

  async trackIdsOf(rnc: string, encf: string): Promise<TrackSummary[]> {
    // El servicio de TrackIds no se publica en certificación.
    if (this.opts.env === "CERT") throw new FiscalError("La consulta de TrackIds no está disponible en certificación", "config");
    const url = `${this.urls.trackIds}/api/trackids/consulta?rncemisor=${encodeURIComponent(rnc)}&encf=${encodeURIComponent(encf)}`;
    const body = await this.authorized("GET", url);
    const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];
    return rows.flatMap((r: Record<string, unknown>) => {
      const trackId = asString(r.trackId);
      return trackId
        ? [{ trackId, status: statusOfText(asString(r.estado) ?? ""), statusText: asString(r.estado) ?? "", receivedAt: asString(r.fechaRecepcion) }]
        : [];
    });
  }

  // ───────────── HTTP ─────────────

  /** Petición con token; si la DGII lo rechaza (venció antes de lo esperado), se renueva y se reintenta una vez. */
  private async authorized(method: string, url: string, opts: { form?: FormData } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.authenticate();
      try {
        return await this.send(method, url, { ...opts, token });
      } catch (e) {
        if (e instanceof FiscalError && e.kind === "auth" && attempt === 0) {
          this.token = null;
          continue;
        }
        throw e;
      }
    }
  }

  /** Devuelve el JSON de la respuesta, o su texto si no es JSON (la semilla llega en XML). */
  private async send(method: string, url: string, o: { form?: FormData; token?: string; accept?: string } = {}) {
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: { accept: o.accept ?? "application/json", ...(o.token ? { authorization: `bearer ${o.token}` } : {}) },
        ...(o.form ? { body: o.form } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new FiscalError(timeout ? "La DGII tardó demasiado en responder" : "No se pudo conectar con la DGII", "network");
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // No es JSON: se conserva el texto (semilla en XML, o un error en texto plano).
    }
    if (res.ok) return parsed;
    const reason = messageOf(typeof parsed === "string" ? xmlMessage(parsed) ?? parsed : parsed, `La DGII respondió ${res.status}`);
    if (res.status === 401 || res.status === 403) throw new FiscalError(reason, "auth", res.status);
    if (res.status === 429 || res.status >= 500) throw new FiscalError(reason, "server", res.status);
    throw new FiscalError(reason, "rejected", res.status);
  }
}

/** Respuesta de la recepción o la consulta de un resumen: estado por texto («Aceptado»…) o por código (0, 1, 2, 4). */
function summaryOf(body: unknown, fallback: string): SummaryResult {
  if (!body || typeof body !== "object") throw new FiscalError(fallback, "server");
  const b = body as Record<string, unknown>;
  const text = asString(b.estado) ?? "";
  const code = Number(b.codigo);
  const status = text ? statusOfText(text) : (FISCAL_STATUS_BY_CODE[code] ?? null);
  if (!status) throw new FiscalError(messageOf(body, fallback), "server");
  return {
    status,
    code: Number.isFinite(code) ? code : -1,
    statusText: text,
    rnc: asString(b.rnc),
    encf: asString(b.encf) ?? asString(b.eNCF),
    sequenceUsed: typeof b.secuenciaUtilizada === "boolean" ? b.secuenciaUtilizada : null,
    messages: messagesOf(b.mensajes),
  };
}

/** Mensaje de un error que la DGII devolvió en XML (`<mensaje>`/`<error>`), si lo trae. */
function xmlMessage(text: string): string | null {
  if (!text.trimStart().startsWith("<")) return null;
  const doc = new DOMParser({ onError: () => undefined }).parseFromString(text, "text/xml");
  for (const tag of ["mensaje", "error", "valor"]) {
    const v = doc.getElementsByTagName(tag)[0]?.textContent?.trim();
    if (v) return v;
  }
  return null;
}
