/**
 * PIN de cajero: 4 a 6 dígitos para identificarse en la caja (también sin internet).
 *
 * Se guarda solo el resumen PBKDF2-SHA256 con sal propia (`pbkdf2$sha256$iteraciones$sal$hash`), nunca el PIN.
 * Usa Web Crypto, que existe igual en Node (API), Electron (caja) y navegadores, así el mismo código crea el
 * resumen en la nube y lo verifica en la caja.
 *
 * Un PIN de 4–6 dígitos es poco para resistir un ataque con acceso al archivo: sirve para saber QUIÉN vende y evitar
 * usos casuales, no como secreto fuerte (la sesión de la caja con la nube tiene su propia contraseña).
 */

type SubtleLike = {
  importKey(format: "raw", data: Uint8Array, algorithm: string, extractable: boolean, usages: string[]): Promise<unknown>;
  deriveBits(
    params: { name: "PBKDF2"; hash: string; salt: Uint8Array; iterations: number },
    key: unknown,
    length: number,
  ): Promise<ArrayBuffer>;
};
type CryptoLike = { subtle: SubtleLike; getRandomValues<T extends Uint8Array>(array: T): T };
const webCrypto = () => (globalThis as unknown as { crypto: CryptoLike }).crypto;

const ITERATIONS = 100_000;
const SCHEME = "pbkdf2$sha256";

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function derive(pin: string, salt: Uint8Array, iterations: number) {
  const { subtle } = webCrypto();
  const key = await subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

/** Motivo por el que un PIN no sirve, o null si es válido. */
export function pinProblem(pin: string): string | null {
  if (!/^\d{4,6}$/.test(pin)) return "El PIN debe tener de 4 a 6 dígitos";
  if (/^(\d)\1+$/.test(pin)) return "El PIN no puede repetir el mismo dígito";
  const digits = [...pin].map(Number);
  const step = digits[1]! - digits[0]!;
  if (Math.abs(step) === 1 && digits.every((d, i) => i === 0 || d - digits[i - 1]! === step)) {
    return "El PIN no puede ser una secuencia (1234, 4321…)";
  }
  return null;
}

export async function hashPin(pin: string, opts: { iterations?: number } = {}): Promise<string> {
  const problem = pinProblem(pin);
  if (problem) throw new Error(problem);
  const iterations = opts.iterations ?? ITERATIONS;
  const salt = webCrypto().getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, iterations);
  return `${SCHEME}$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Compara en tiempo constante. Un resumen mal formado nunca coincide (no lanza). */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 5 || `${parts[0]}$${parts[1]}` !== SCHEME) return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 5_000_000) return false;
  try {
    const expected = fromBase64(parts[4]!);
    const actual = await derive(pin, fromBase64(parts[3]!), iterations);
    if (expected.length !== actual.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}
