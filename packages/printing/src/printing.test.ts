import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { colsOf, DEFAULT_PRINTER, normalizePrinterConfig, printerProblem, type PrinterConfig } from "./config";
import { decodeText, encodeText, type CodePage } from "./encoding";
import { EscPos, wrap } from "./escpos";
import { drawerOnly, receiptTicket, shiftTicket, testTicket, formatDateTime, type ReceiptData, type ShiftData } from "./tickets";
import { PrintError, printBytes, sendToNetwork, sendToWindowsPrinter, windowsPrintMessage } from "./transports";

/** Convierte los bytes en lo que se vería en papel: quita los comandos y devuelve las líneas de texto. */
function paper(bytes: Uint8Array, page: CodePage = "cp858") {
  const text: number[] = [];
  const commands: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const n = bytes[i + 1];
    if (b === 0x1b && n === 0x40) (commands.push("init"), (i += 2));
    else if (b === 0x1b && (n === 0x74 || n === 0x61 || n === 0x45)) (commands.push(n === 0x74 ? `page:${bytes[i + 2]}` : n === 0x61 ? `align:${bytes[i + 2]}` : `bold:${bytes[i + 2]}`), (i += 3));
    else if (b === 0x1b && n === 0x64) (commands.push(`feed:${bytes[i + 2]}`), (i += 3));
    else if (b === 0x1b && n === 0x70) (commands.push("drawer"), (i += 5));
    else if (b === 0x1d && n === 0x21) (commands.push(`size:${bytes[i + 2]}`), (i += 3));
    else if (b === 0x1d && n === 0x56) (commands.push("cut"), (i += 4));
    else if (b === 0x1d && n === 0x28) {
      const len = bytes[i + 3]! + (bytes[i + 4]! << 8);
      commands.push(bytes[i + 6] === 0x50 ? `qr:${new TextDecoder().decode(bytes.slice(i + 8, i + 5 + len))}` : bytes[i + 6] === 0x51 ? "qr-print" : "qr-setup");
      i += 5 + len;
    } else (text.push(b), i++);
  }
  return { lines: decodeText(text, page).split("\n"), commands };
}

const company = { legalName: "Colmado Demo SRL", tradeName: "Colmado Demo", rnc: "101001577", address: "Av. Principal 12, Santo Domingo", phone: "809-555-0100" };
const receipt = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  sale: { encf: "E320000000801", type: "E32", issuedAt: "2026-10-21T19:52:00Z", total: "326.00", refundOf: null },
  company,
  buyerName: null,
  buyerDoc: null,
  lines: [
    { name: "Refresco 2 L", quantity: "2", unitPrice: "118.00", total: "236.00" },
    { name: "Cerveza", quantity: "1", unitPrice: "90.00", total: "90.00" },
  ],
  totals: { subtotal: "276.27", tax: "49.73", propina: "0.00", total: "326.00" },
  payments: [{ method: "CASH", amount: "200.00" }, { method: "CARD", amount: "126.00" }],
  cashierName: "Ana Pérez",
  ...over,
});

describe("codificación", () => {
  it("las tablas de 8 bits tienen 128 caracteres y las letras del español caen donde las espera la impresora", () => {
    // CP437/CP850/CP858: valores publicados de cada letra.
    const expected: Record<string, number> = { á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3, ñ: 0xa4, Ñ: 0xa5, ü: 0x81, Ü: 0x9a, "¿": 0xa8, "É": 0x90 };
    for (const [ch, byte] of Object.entries(expected)) {
      for (const page of ["cp437", "cp850", "cp858"] as const) expect(encodeText(ch, page), `${ch} en ${page}`).toEqual([byte]);
    }
    for (const [ch, byte] of Object.entries({ Á: 0xb5, Í: 0xd6, Ó: 0xe0, Ú: 0xe9, "¡": 0xad })) {
      expect(encodeText(ch, "cp850"), ch).toEqual([byte]);
      expect(encodeText(ch, "cp858"), ch).toEqual([byte]);
    }
    expect(encodeText("€", "cp858")).toEqual([0xd5]);
    expect(encodeText("€", "cp850")).toEqual([0x3f]); // no existe en CP850
  });

  it("convierte y reconvierte sin perder el texto, y aproxima lo que la página no tiene", () => {
    const text = "Pan de agua - ñandú ¿Cuánto? ¡Oferta! Ü 5°";
    for (const page of ["cp437", "cp850", "cp858"] as const) {
      // Á/Í/Ó/Ú no existen en CP437: ahí salen sin acento.
      const back = decodeText(encodeText(text, page), page);
      expect(back).toBe(text);
    }
    expect(decodeText(encodeText("ÁÉÍÓÚ", "cp437"), "cp437")).toBe("AÉIOU".replace("I", "I"));
    expect(decodeText(encodeText("日本", "cp858"))).toBe("??");
    expect(decodeText(encodeText("a b\tc\nd", "cp858"))).toBe("a b c\nd");
    expect(decodeText(encodeText("—“x”’", "cp858"))).toBe('-"x"\'');
  });
});

describe("comandos ESC/POS", () => {
  it("genera los bytes exactos de iniciar, alinear, negrita, tamaño, gaveta y corte", () => {
    const b = new EscPos({ cols: 48 }).init().center().bold().size(2).line("A").size(1).bold(false).openDrawer().feed(3).cut().bytes();
    expect([...b]).toEqual([
      0x1b, 0x40, 0x1b, 0x74, 19, // init + CP858
      0x1b, 0x61, 1, // centrado
      0x1b, 0x45, 1, // negrita
      0x1d, 0x21, 0x11, // doble ancho y alto
      0x41, 0x0a,
      0x1d, 0x21, 0x00, // normal
      0x1b, 0x45, 0,
      0x1b, 0x70, 0x00, 0x19, 0xfa, // gaveta
      0x1b, 0x64, 3,
      0x1d, 0x56, 0x42, 0x00, // corte parcial
    ]);
  });

  it("arma el QR con los cinco comandos nativos y la longitud correcta", () => {
    const url = "https://x.test/q?a=1";
    const b = [...new EscPos({ cols: 48 }).qr(url, 6, "M").bytes()];
    const data = [...new TextEncoder().encode(url)];
    expect(b).toEqual([
      0x1d, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0, // modelo 2
      0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x43, 6, // tamaño del módulo
      0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31, // corrección M
      0x1d, 0x28, 0x6b, data.length + 3, 0, 0x31, 0x50, 0x30, ...data, // datos
      0x1d, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30, // imprimir
    ]);
    expect(() => new EscPos({ cols: 48 }).qr("")).toThrow(/entre 1 y 7000/);
    // Un texto largo usa los dos bytes de longitud.
    const long = [...new EscPos({ cols: 48 }).qr("x".repeat(300)).bytes()];
    const store = long.findIndex((v, i) => v === 0x31 && long[i + 1] === 0x50);
    expect(long[store - 2]! + (long[store - 1]! << 8)).toBe(303);
  });

  it("alinea columnas y parte el texto sin pasar del ancho del papel", () => {
    const p = new EscPos({ cols: 32 });
    p.columns("Refresco gigante de dos litros sabor naranja", "RD$ 1,250.00").columns("Pan", "RD$ 10.00").rule("=");
    const { lines } = paper(p.bytes());
    expect(lines.filter(Boolean).every((l) => l.length <= 32)).toBe(true);
    expect(lines.find((l) => l.endsWith("RD$ 1,250.00"))).toMatch(/^[A-Za-z ]+RD\$ 1,250\.00$/); // la última fila del nombre lleva el precio a la derecha
    expect(lines.filter(Boolean)).toContain("Pan".padEnd(32 - "RD$ 10.00".length) + "RD$ 10.00");
    expect(lines.filter(Boolean).at(-1)).toBe("=".repeat(32));
    expect(wrap("una palabrainterminablemente larga aquí", 10)).toEqual(["una", "palabraint", "erminablem", "ente larga", "aquí"]);
  });
});

describe("tickets", () => {
  for (const paperMm of [80, 58] as const) {
    it(`el ticket de venta cabe en papel de ${paperMm} mm y trae todos los datos`, () => {
      const cols = colsOf(paperMm);
      const { lines, commands } = paper(receiptTicket(receipt(), { cols }));
      const text = lines.join("\n");
      expect(lines.every((l) => l.length <= cols)).toBe(true);
      for (const part of ["Colmado Demo", "RNC 101001577", "FACTURA DE CONSUMO", "e-NCF: E320000000801", "21/10/2026 15:52", "2 x Refresco 2 L", "Cerveza", "Subtotal", "ITBIS", "TOTAL", "Efectivo", "Tarjeta", "Atendió: Ana Pérez", "¡Gracias por su compra!"]) {
        expect(text, part).toContain(part);
      }
      expect(text).toContain("RD$ 118.00 c/u"); // solo cuando se llevan varios
      expect(text).not.toContain("RD$ 90.00 c/u");
      expect(commands[0]).toBe("init");
      expect(commands.at(-1)).toBe("cut");
      expect(commands.some((c) => c.startsWith("qr"))).toBe(false); // sin firma no hay QR
      expect(commands).not.toContain("drawer");
    });
  }

  it("abre la gaveta al empezar si se pide, y solo corta si se pide", () => {
    const withDrawer = paper(receiptTicket(receipt(), { cols: 48, openDrawer: true }));
    expect(withDrawer.commands.slice(0, 3)).toEqual(["init", "page:19", "drawer"]); // antes de imprimir nada
    expect(paper(receiptTicket(receipt(), { cols: 48, cut: false })).commands).not.toContain("cut");
  });

  it("imprime el QR de la DGII solo cuando el comprobante lo trae, con su leyenda", () => {
    const url = "https://ecf.dgii.gov.do/eCF/ConsultaTimbre?ENCF=E320000000801";
    const { commands, lines } = paper(receiptTicket(receipt({ qr: url }), { cols: 48 }));
    expect(commands).toContain(`qr:${url}`);
    expect(commands).toContain("qr-print");
    expect(lines.join("\n")).toContain("Escanee para verificar en la DGII");
  });

  it("la nota de crédito dice qué modifica, marca el reembolso y no da las gracias", () => {
    const { lines } = paper(
      receiptTicket(receipt({ sale: { encf: "E340000000101", type: "E34", issuedAt: "2026-10-21T20:00:00Z", total: "118.00", refundOf: "E320000000801" }, lines: [{ name: "Refresco 2 L", quantity: "1", unitPrice: "118.00", total: "118.00" }], totals: { subtotal: "100.00", tax: "18.00", propina: "0.00", total: "118.00" }, payments: [{ method: "CASH", amount: "118.00" }] }), { cols: 48 }),
    );
    const text = lines.join("\n");
    expect(text).toContain("NOTA DE CRÉDITO");
    expect(text).toContain("Modifica: E320000000801");
    expect(text).toContain("Reembolso:");
    expect(text).not.toContain("Gracias");
  });

  it("muestra comprador, propina y partes largas de nombre sin desbordar", () => {
    const { lines } = paper(
      receiptTicket(receipt({ buyerName: "Acme Servicios Industriales y Comerciales SRL", buyerDoc: "131246796", totals: { subtotal: "276.27", tax: "49.73", propina: "27.63", total: "353.63" }, lines: [{ name: "Producto con un nombre extremadamente largo para la columna", quantity: "1", unitPrice: "10.00", total: "10.00" }] }), { cols: 32 }),
    );
    expect(lines.every((l) => l.length <= 32)).toBe(true);
    expect(lines.join("\n")).toMatch(/Cliente: Acme/);
    expect(lines.join("\n")).toContain("(131246796)");
    expect(lines.join("\n")).toContain("Propina legal");
  });

  it("el informe del turno trae cobros, efectivo esperado y la diferencia", () => {
    const d: ShiftData = {
      company,
      shift: { openedBy: { name: "Ana" }, openedAt: "2026-10-21T17:00:00Z", closedAt: "2026-10-21T23:00:00Z", notes: "Faltaron 2 pesos" },
      report: {
        documents: 2,
        byType: { E31: { count: 0, total: "0.00" }, E32: { count: 1, total: "326.00" }, E34: { count: 1, total: "118.00" } },
        sales: { subtotal: "276.27", tax: "49.73", propina: "0.00", total: "326.00" },
        net: "208.00",
        payments: { CARD: "126.00", CASH: "82.00" },
        openingAmount: "500.00",
        cashReceived: "82.00",
        expectedCash: "582.00",
        countedCash: "580.00",
        difference: "-2.00",
      },
    };
    const { lines } = paper(shiftTicket(d, { cols: 48 }));
    const text = lines.join("\n");
    for (const part of ["INFORME Z", "Abrió: Ana", "Consumo x 1", "Notas de crédito x 1", "-RD$ 118.00", "VENTAS NETAS", "RD$ 208.00", "Efectivo esperado", "RD$ 582.00", "Efectivo contado", "Faltan", "RD$ 2.00", "Observaciones: Faltaron 2 pesos", "Cajero", "Supervisor"]) {
      expect(text, part).toContain(part);
    }
    expect(lines.every((l) => l.length <= 48)).toBe(true);
    const x = paper(shiftTicket({ ...d, shift: { ...d.shift, closedAt: null }, report: { ...d.report, countedCash: undefined, difference: undefined } }, { cols: 48 })).lines.join("\n");
    expect(x).toContain("INFORME X");
    expect(x).not.toContain("Supervisor");
  });

  it("el ticket de prueba y el pulso de gaveta son válidos", () => {
    const t = paper(testTicket({ cols: 48 }));
    expect(t.lines.join("\n")).toContain("áéíóú ÁÉÍÓÚ ñ Ñ ü Ü ¿? ¡! € °");
    expect(t.commands).toContain("qr:https://example.com/prueba");
    expect([...drawerOnly({ cols: 48 })]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19, 0x1b, 0x70, 0x00, 0x19, 0xfa]);
    expect(formatDateTime("2026-01-01T03:00:00Z")).toBe("31/12/2025 23:00"); // hora de Santo Domingo (UTC−4)
  });
});

describe("configuración de la impresora", () => {
  it("completa y sanea lo que llega de afuera", () => {
    expect(normalizePrinterConfig(null)).toEqual(DEFAULT_PRINTER);
    const c = normalizePrinterConfig({ mode: "network", host: "  192.168.1.50 ", port: 99999, paper: 58, codePage: "cp437", autoPrint: false } as Partial<PrinterConfig>);
    expect(c).toMatchObject({ mode: "network", host: "192.168.1.50", port: 9100, paper: 58, codePage: "cp437", autoPrint: false, drawerOnCash: true });
    expect(normalizePrinterConfig({ mode: "usb" as never, paper: 70 as never, codePage: "x" as never })).toMatchObject({ mode: "none", paper: 80, codePage: "cp858" });
    expect(colsOf(80)).toBe(48);
    expect(colsOf(58)).toBe(32);
  });

  it("explica qué falta para imprimir", () => {
    expect(printerProblem(DEFAULT_PRINTER)).toMatch(/No hay una impresora/);
    expect(printerProblem({ ...DEFAULT_PRINTER, mode: "windows" })).toMatch(/Elige la impresora/);
    expect(printerProblem({ ...DEFAULT_PRINTER, mode: "network" })).toMatch(/dirección/);
    expect(printerProblem({ ...DEFAULT_PRINTER, mode: "network", host: "10.0.0.5" })).toBeNull();
  });
});

describe("envío a la impresora", () => {
  it("manda los bytes tal cual a una impresora de red", async () => {
    const received: Buffer[] = [];
    const server = createServer((socket) => socket.on("data", (d) => received.push(d)));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    try {
      const bytes = receiptTicket(receipt(), { cols: 48, openDrawer: true });
      await printBytes({ ...DEFAULT_PRINTER, mode: "network", host: "127.0.0.1", port }, bytes);
      await new Promise((r) => setTimeout(r, 100));
      expect([...Buffer.concat(received)]).toEqual([...bytes]);
    } finally {
      server.close();
    }
  });

  it("explica con claridad cuando la impresora de red no está", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const { port } = closed.address() as { port: number };
    await new Promise((r) => closed.close(r));
    await expect(sendToNetwork("127.0.0.1", port, new Uint8Array([1]))).rejects.toThrow(/No se pudo conectar con la impresora/);
    await expect(sendToNetwork("127.0.0.1", port, new Uint8Array([1]))).rejects.toBeInstanceOf(PrintError);
  });

  it("no imprime sin configuración", async () => {
    await expect(printBytes(DEFAULT_PRINTER, new Uint8Array([1]))).rejects.toThrow(/No hay una impresora configurada/);
  });

  it("traduce los errores de Windows a mensajes claros", () => {
    expect(windowsPrintMessage("Caja", "OpenPrinter", 1801)).toMatch(/No se encontró la impresora «Caja»/);
    expect(windowsPrintMessage("Caja", "OpenPrinter", 5)).toMatch(/sin permiso/);
    expect(windowsPrintMessage("Caja", "WritePrinter", 21)).toMatch(/no está lista/);
    expect(windowsPrintMessage("Caja", "WritePrinter", 999)).toBe("No se pudo imprimir en «Caja» (WritePrinter 999)");
    expect(windowsPrintMessage("Caja")).toBe("No se pudo imprimir en «Caja»");
  });

  it.skipIf(process.platform !== "win32")("en Windows, una impresora que no existe da un mensaje claro (el script de impresión compila y llega a Windows)", async () => {
    await expect(sendToWindowsPrinter("Impresora-que-no-existe-xyz", new Uint8Array([0x1b, 0x40]))).rejects.toThrow(/No se encontró la impresora «Impresora-que-no-existe-xyz»/);
  }, 60_000);
});
