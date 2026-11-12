import { DOMParser } from "@xmldom/xmldom";
import { compactXml } from "./format";
import { FiscalError, type DirectoryEntry } from "./provider";
import { signXml, type EcfCertificate } from "./sign";
import type { FetchLike } from "./dgii";

/** Une el host que publica el directorio de la DGII con el recurso estándar, sin repetirlo si el host ya lo trae. */
export function peerEndpoint(host: string, resource: string): string {
  const base = host.trim().replace(/\/+$/, "");
  return base.toLowerCase().includes("/fe/") ? base : `${base}${resource}`;
}

/**
 * Habla con el servicio de OTRO contribuyente electrónico (el emisor de un e-CF que recibimos): le entrega la
 * aprobación comercial. Su autenticación es opcional: si el directorio publica un servicio de autenticación se hace el
 * mismo intercambio de semilla firmada que con la DGII.
 */
export class PeerClient {
  private readonly doFetch: FetchLike;
  constructor(private readonly opts: { certificate: EcfCertificate; fetch?: FetchLike; timeoutMs?: number }) {
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Entrega un ACECF firmado al emisor. Lanza `FiscalError` si no lo acepta. */
  async sendApproval(peer: DirectoryEntry, xml: string, rnc: string, encf: string): Promise<void> {
    if (!peer.approvalUrl) throw new FiscalError("El emisor no publica un servicio de aprobación comercial", "config");
    const token = peer.authenticationUrl ? await this.authenticate(peer.authenticationUrl) : null;
    const form = new FormData();
    form.append("xml", new Blob([xml], { type: "text/xml" }), `${rnc}${encf}.xml`);
    await this.send("POST", peerEndpoint(peer.approvalUrl, "/fe/aprobacioncomercial/api/ecf"), { form, token });
  }

  /**
   * Entrega un e-CF firmado (ya aceptado por la DGII) al servicio de recepción del comprador y devuelve su acuse de
   * recibo (ARECF). Lanza `FiscalError` si no responde con un acuse válido.
   */
  async sendEcf(peer: DirectoryEntry, xml: string, rnc: string, encf: string): Promise<Acknowledgement> {
    if (!peer.receptionUrl) throw new FiscalError("El comprador no publica un servicio de recepción de e-CF", "config");
    const token = peer.authenticationUrl ? await this.authenticate(peer.authenticationUrl) : null;
    const form = new FormData();
    form.append("xml", new Blob([xml], { type: "text/xml" }), `${rnc}${encf}.xml`);
    const body = await this.send("POST", peerEndpoint(peer.receptionUrl, "/fe/recepcion/api/ecf"), { form, token });
    const ack = typeof body === "string" ? readAcknowledgement(body) : null;
    if (!ack) throw new FiscalError("El comprador no devolvió un acuse de recibo válido", "server");
    return ack;
  }

  private async authenticate(host: string): Promise<string> {
    const seed = await this.send("GET", peerEndpoint(host, "/fe/autenticacion/api/semilla"), { accept: "*/*" });
    if (typeof seed !== "string" || !/<semillamodel[\s>]/i.test(seed)) throw new FiscalError("El emisor no entregó una semilla válida", "server");
    const form = new FormData();
    form.append("xml", new Blob([signXml(compactXml(seed), this.opts.certificate)], { type: "text/xml" }), "semilla.xml");
    const res = (await this.send("POST", peerEndpoint(host, "/fe/autenticacion/api/validacioncertificado"), { form })) as { token?: string } | null;
    if (!res?.token) throw new FiscalError("El emisor no entregó un token de autenticación", "auth");
    return res.token;
  }

  private async send(method: string, url: string, o: { form?: FormData; token?: string | null; accept?: string } = {}) {
    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: { accept: o.accept ?? "*/*", ...(o.token ? { authorization: `bearer ${o.token}` } : {}) },
        ...(o.form ? { body: o.form } : {}),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
    } catch {
      throw new FiscalError("No se pudo conectar con el servicio del emisor", "network");
    }
    const body = await res.text();
    if (res.ok) {
      try {
        return body ? JSON.parse(body) : null;
      } catch {
        return body;
      }
    }
    const reason = body.trim().slice(0, 300) || `El emisor respondió ${res.status}`;
    if (res.status === 401 || res.status === 403) throw new FiscalError(reason, "auth", res.status);
    if (res.status === 429 || res.status >= 500) throw new FiscalError(reason, "server", res.status);
    throw new FiscalError(reason, "rejected", res.status);
  }
}

/** Acuse de recibo (ARECF) que devuelve el receptor: Estado 0 = recibido, 1 = no recibido (con su motivo 1–4). */
export type Acknowledgement = { received: boolean; reason: number | null; encf: string | null; buyerRnc: string | null; xml: string };

/** Lee un ARECF; null si no lo es. No verifica la firma: quien lo guarda conserva el XML tal como llegó. */
export function readAcknowledgement(xml: string): Acknowledgement | null {
  if (!xml.trimStart().startsWith("<")) return null;
  let root: ReturnType<DOMParser["parseFromString"]>["documentElement"];
  try {
    root = new DOMParser({ onError: () => undefined }).parseFromString(xml.trim(), "text/xml").documentElement;
  } catch {
    return null;
  }
  if (!root || root.nodeName !== "ARECF") return null;
  const text = (tag: string) => root.getElementsByTagName(tag)[0]?.textContent?.trim() || null;
  const estado = text("Estado");
  if (estado !== "0" && estado !== "1") return null;
  const reason = text("CodigoMotivoNoRecibido");
  return { received: estado === "0", reason: reason ? Number(reason) : null, encf: text("eNCF"), buyerRnc: text("RNCComprador"), xml };
}
