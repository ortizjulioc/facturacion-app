/**
 * Limitador de uso por ventana fija, en memoria. Protege los servicios públicos del receptor (`/fe`) de quien los
 * inunde. Es por proceso: con varias réplicas cada una cuenta aparte, así que el límite real es «límite × réplicas»
 * (para una barrera estricta hay que ponerla también en el proxy).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  /** Cuenta un uso de `key`. `allowed` es false si ya superó `limit` en la ventana actual de `windowMs`. */
  hit(key: string, limit: number, windowMs: number, now: number = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    if (this.windows.size > 10_000) this.prune(now);
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowMs };
      this.windows.set(key, w);
    }
    w.count++;
    return { allowed: w.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)) };
  }

  private prune(now: number) {
    for (const [key, w] of this.windows) if (w.resetAt <= now) this.windows.delete(key);
  }
}
