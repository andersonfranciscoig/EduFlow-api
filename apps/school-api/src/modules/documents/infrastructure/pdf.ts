import { degrees, PDFDocument, type PDFFont, type PDFImage, type PDFPage, rgb, StandardFonts } from "pdf-lib";

/**
 * O PDF de um documento emitido (A4): cabeçalho com o logótipo e o nome do colégio, título, texto
 * (parágrafos separados por linha em branco), assinatura e carimbo, e o rodapé com o n.º e a versão.
 * Fontes padrão do PDF (Helvetica, WinAnsi): o português cabe todo; o resto troca-se por equivalentes.
 */
export interface PdfInput {
  school: string;
  logo: Buffer | null;
  title: string;
  body: string;
  signerName: string | null;
  signerRole: string | null;
  footer: string;
  /** marca de água (ex.: "PRÉ-VISUALIZAÇÃO") */
  watermark?: string | null;
}

const A4 = { w: 595.28, h: 841.89 };
const M = { x: 64, top: 64, bottom: 72 };
const INK = rgb(0.02, 0.12, 0.13);
const MUTED = rgb(0.32, 0.4, 0.38);
const LINE = rgb(0.14, 0.33, 0.28);
// caracteres acima de 255 que o WinAnsi tem
const WIN_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const winAnsi = (s: string) =>
  [...s.normalize("NFC")]
    .map((c) => {
      const code = c.codePointAt(0)!;
      if (c === "\n") return c;
      if (code < 32) return " ";
      if (code <= 255 || WIN_EXTRA.has(c)) return c;
      if (c === "≥") return ">=";
      if (c === "≤") return "<=";
      if (c === "→") return "->";
      return "?";
    })
    .join("");

/** Parte um texto em linhas que cabem na largura. */
function wrap(text: string, font: PDFFont, size: number, width: number) {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = raw.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) lines.push(line);
        // uma palavra maior do que a linha parte-se
        let rest = w;
        while (font.widthOfTextAtSize(rest, size) > width) {
          let n = rest.length;
          while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        line = rest;
      }
    }
    lines.push(line);
  }
  return lines;
}

async function embedLogo(doc: PDFDocument, logo: Buffer | null): Promise<PDFImage | null> {
  if (!logo) return null;
  try {
    if (logo[0] === 0x89 && logo[1] === 0x50) return await doc.embedPng(logo);
    if (logo[0] === 0xff && logo[1] === 0xd8) return await doc.embedJpg(logo);
  } catch {
    /* um logótipo que não se lê não impede o documento */
  }
  return null;
}

export async function renderDocumentPdf(input: PdfInput): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(input.title));
  doc.setProducer("EduFlow");
  doc.setCreator("EduFlow");
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await embedLogo(doc, input.logo);
  const width = A4.w - M.x * 2;
  const pages: PDFPage[] = [];

  const newPage = (first: boolean) => {
    const p = doc.addPage([A4.w, A4.h]);
    pages.push(p);
    let y = A4.h - M.top;
    if (input.watermark) {
      p.drawText(winAnsi(input.watermark), { x: 110, y: 360, size: 54, font: bold, color: rgb(0.85, 0.88, 0.86), rotate: degrees(35), opacity: 0.6 });
    }
    // cabeçalho: logótipo + nome do colégio (em todas as páginas, mais pequeno nas seguintes)
    const h = first ? 46 : 30;
    let x = M.x;
    if (logo) {
      const s = h / logo.height;
      p.drawImage(logo, { x, y: y - h, width: logo.width * s, height: h });
      x += logo.width * s + 12;
    }
    p.drawText(winAnsi(input.school), { x, y: y - h / 2 - 5, size: first ? 14 : 10.5, font: bold, color: INK });
    y -= h + 12;
    p.drawLine({ start: { x: M.x, y }, end: { x: A4.w - M.x, y }, thickness: 1.4, color: LINE });
    return { p, y: y - (first ? 40 : 24) };
  };

  let { p, y } = newPage(true);
  // título
  for (const line of wrap(winAnsi(input.title).toUpperCase(), bold, 15, width)) {
    const w = bold.widthOfTextAtSize(line, 15);
    p.drawText(line, { x: (A4.w - w) / 2, y, size: 15, font: bold, color: INK });
    y -= 22;
  }
  y -= 18;
  // texto: parágrafos separados por linha em branco
  const size = 11.5;
  const lh = 17.5;
  for (const para of winAnsi(input.body).split(/\n{2,}/)) {
    for (const line of wrap(para, regular, size, width)) {
      if (y < M.bottom + 20) ({ p, y } = newPage(false));
      p.drawText(line, { x: M.x, y, size, font: regular, color: INK });
      y -= lh;
    }
    y -= 9;
  }
  // assinatura e carimbo
  if (input.signerName || input.signerRole) {
    if (y < M.bottom + 120) ({ p, y } = newPage(false));
    y -= 46;
    const lineW = 220;
    const x0 = A4.w - M.x - lineW;
    p.drawLine({ start: { x: x0, y }, end: { x: x0 + lineW, y }, thickness: 0.8, color: MUTED });
    y -= 15;
    for (const [t, f, s] of [
      [input.signerName, bold, 11],
      [input.signerRole, regular, 10],
    ] as const) {
      if (!t) continue;
      const line = wrap(winAnsi(t), f, s, lineW)[0];
      p.drawText(line, { x: x0 + (lineW - f.widthOfTextAtSize(line, s)) / 2, y, size: s, font: f, color: INK });
      y -= 14;
    }
    // o lugar do carimbo do colégio
    p.drawRectangle({ x: M.x, y: y + 6, width: 110, height: 70, borderColor: rgb(0.78, 0.82, 0.8), borderWidth: 0.8, borderDashArray: [3, 3] });
    p.drawText("Carimbo", { x: M.x + 34, y: y + 37, size: 9, font: regular, color: rgb(0.6, 0.66, 0.64) });
  }
  // rodapé em todas as páginas
  pages.forEach((pg, i) => {
    const text = winAnsi(`${input.footer}${pages.length > 1 ? `  ·  página ${i + 1} de ${pages.length}` : ""}`);
    pg.drawLine({ start: { x: M.x, y: 48 }, end: { x: A4.w - M.x, y: 48 }, thickness: 0.5, color: rgb(0.8, 0.84, 0.82) });
    for (const [j, line] of wrap(text, regular, 8, width).entries()) pg.drawText(line, { x: M.x, y: 36 - j * 10, size: 8, font: regular, color: MUTED });
  });
  return Buffer.from(await doc.save());
}
