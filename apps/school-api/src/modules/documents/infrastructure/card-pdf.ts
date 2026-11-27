import { clip, degrees, endPath, type PDFDocument as Doc, PDFDocument, type PDFFont, type PDFImage, type PDFPage, popGraphicsState, pushGraphicsState, rectangle, type RGB, rgb, StandardFonts } from "pdf-lib";
import { create as createQr } from "qrcode";
import { type CardModel, luminance } from "../domain/cards";
import { embedLogo, winAnsi, wrap } from "./pdf";

/**
 * Os cartões de estudante em PDF, nos três modelos da plataforma (Clássico, Moderno, Contemporâneo).
 * Tamanho padrão dos cartões (ISO/IEC 7810 ID-1: 85,6 × 54 mm), frente e verso:
 *   - "CARD":  uma página do tamanho do cartão por face (impressoras de cartões PVC);
 *   - "SHEET": folhas A4 com 10 cartões (frente; o verso na folha seguinte, em espelho para
 *              imprimir frente e verso pelo lado maior) e marcas de corte.
 * O QR é desenhado em vetor (nítido em qualquer impressora).
 */
export interface CardPrint {
  model: CardModel;
  primary: string;
  accent: string;
  school: { name: string; address: string | null; phone: string | null; email: string | null };
  logo: Buffer | null;
  student: { name: string; number: string | null; classLabel: string | null; groupName: string | null; yearName: string };
  /** JPG ou PNG; null só na pré-visualização (silhueta) */
  photo: Buffer | null;
  /** dd/mm/aaaa */
  validUntil: string;
  /** XXXX-XXXX-XXXX */
  code: string;
  /** null = o colégio não quer o QR (fica o código impresso) */
  verifyUrl: string | null;
  backNote: string;
  /** ex.: "Cartão n.º 000012 · 2.ª via" */
  footer: string;
  watermark?: string | null;
}

const MM = 72 / 25.4;
export const CARD = { w: 85.6 * MM, h: 53.98 * MM };
const A4 = { w: 595.28, h: 841.89 };
const INK = rgb(0.06, 0.11, 0.1);
const MUTED = rgb(0.36, 0.42, 0.4);
const WHITE = rgb(1, 1, 1);

const hex = (h: string): RGB => rgb(Number.parseInt(h.slice(1, 3), 16) / 255, Number.parseInt(h.slice(3, 5), 16) / 255, Number.parseInt(h.slice(5, 7), 16) / 255);
/** a cor misturada com branco (t = 0 → a cor; 1 → branco) */
const tint = (h: string, t: number): RGB => {
  const c = hex(h);
  return rgb(c.red + (1 - c.red) * t, c.green + (1 - c.green) * t, c.blue + (1 - c.blue) * t);
};
const onColor = (h: string) => (luminance(h) < 0.42 ? WHITE : INK);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}
interface Assets {
  logo: PDFImage | null;
  photo: PDFImage | null;
}
type Face = (p: PDFPage, x: number, y: number, c: CardPrint, f: Fonts, a: Assets) => void;

/** Um texto numa linha: encolhe até `min`; se ainda não couber, corta com reticências. */
function fit(s: string, font: PDFFont, size: number, maxW: number, min = 5) {
  let t = winAnsi(s);
  let z = size;
  while (z > min && font.widthOfTextAtSize(t, z) > maxW) z -= 0.25;
  if (font.widthOfTextAtSize(t, z) > maxW) {
    while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, z) > maxW) t = t.slice(0, -1);
    t = `${t.trimEnd()}…`;
  }
  return { t, z };
}
function line(p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color: RGB, maxW: number, opts: { min?: number; opacity?: number; center?: boolean } = {}) {
  const { t, z } = fit(s, font, size, maxW, opts.min);
  const w = font.widthOfTextAtSize(t, z);
  p.drawText(t, { x: opts.center ? x + (maxW - w) / 2 : x, y, size: z, font, color, opacity: opts.opacity ?? 1 });
}
/** Um texto em várias linhas (no máximo `max`; a última corta com reticências). Devolve o y seguinte. */
function para(p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color: RGB, maxW: number, max: number, lh: number, opacity = 1) {
  const lines = wrap(winAnsi(s), font, size, maxW).filter((l) => l.trim());
  lines.slice(0, max).forEach((l, i) => {
    const last = i === max - 1 && lines.length > max;
    line(p, last ? `${l}…` : l, x, y - i * lh, size, font, color, maxW, { min: size, opacity });
  });
  return y - Math.min(lines.length, max) * lh;
}
/** O nome do aluno: até duas linhas, a encolher para caber. */
function nameLines(p: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color: RGB, maxW: number, lh: number) {
  let z = size;
  let lines = wrap(winAnsi(s), font, z, maxW);
  while (lines.length > 2 && z > 6.5) {
    z -= 0.25;
    lines = wrap(winAnsi(s), font, z, maxW);
  }
  lines.slice(0, 2).forEach((l, i) => line(p, l, x, y - i * lh * (z / size), z, font, color, maxW, { min: 5.5 }));
  return y - Math.min(lines.length, 2) * lh * (z / size);
}
/** Etiqueta pequena + valor, como nos documentos de identificação. */
function field(p: PDFPage, f: Fonts, label: string, value: string | null, x: number, y: number, maxW: number, color: RGB = INK, labelColor: RGB = MUTED) {
  line(p, label.toUpperCase(), x, y, 4.8, f.regular, labelColor, maxW);
  line(p, value || "—", x, y - 7.6, 7.4, f.bold, color, maxW, { min: 5.2 });
}
function logoAt(p: PDFPage, img: PDFImage | null, x: number, y: number, h: number, maxW: number) {
  if (!img) return 0;
  const s = Math.min(h / img.height, maxW / img.width);
  p.drawImage(img, { x, y: y + (h - img.height * s) / 2, width: img.width * s, height: img.height * s });
  return img.width * s;
}
/** A fotografia a cobrir a caixa (cortada ao centro); sem fotografia (só na pré-visualização), uma silhueta. */
function photo(p: PDFPage, img: PDFImage | null, x: number, y: number, w: number, h: number, frame: RGB | null, frameW = 1) {
  if (frame) p.drawRectangle({ x: x - frameW, y: y - frameW, width: w + frameW * 2, height: h + frameW * 2, color: frame });
  if (!img) {
    p.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
    p.drawRectangle({ x, y, width: w, height: h, color: rgb(0.88, 0.91, 0.9) });
    p.drawCircle({ x: x + w / 2, y: y + h * 0.62, size: w * 0.2, color: rgb(0.7, 0.75, 0.73) });
    p.drawEllipse({ x: x + w / 2, y: y + h * 0.08, xScale: w * 0.36, yScale: h * 0.26, color: rgb(0.7, 0.75, 0.73) });
    p.pushOperators(popGraphicsState());
    return;
  }
  const s = Math.max(w / img.width, h / img.height);
  const iw = img.width * s;
  const ih = img.height * s;
  p.pushOperators(pushGraphicsState(), rectangle(x, y, w, h), clip(), endPath());
  // o rosto costuma estar no terço de cima: corta mais em baixo do que em cima
  p.drawImage(img, { x: x + (w - iw) / 2, y: y + h - ih + Math.max(0, (ih - h) * 0.15), width: iw, height: ih });
  p.pushOperators(popGraphicsState());
}
/** O QR em vetor, com a zona branca à volta. */
function qr(p: PDFPage, url: string, x: number, y: number, size: number, dark: RGB = INK) {
  const m = createQr(url, { errorCorrectionLevel: "M" }).modules;
  const n = m.size;
  const quiet = 2;
  const u = size / (n + quiet * 2);
  p.drawRectangle({ x, y, width: size, height: size, color: WHITE });
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!m.get(r, c)) {
        c++;
        continue;
      }
      const start = c;
      while (c < n && m.get(r, c)) c++;
      p.drawRectangle({ x: x + (quiet + start) * u, y: y + size - (quiet + r + 1) * u, width: (c - start) * u + 0.05, height: u + 0.05, color: dark });
    }
  }
}
function roundRect(p: PDFPage, x: number, y: number, w: number, h: number, r: number, color: RGB, opacity = 1) {
  const path = `M ${r},0 H ${w - r} A ${r},${r} 0 0 1 ${w},${r} V ${h - r} A ${r},${r} 0 0 1 ${w - r},${h} H ${r} A ${r},${r} 0 0 1 0,${h - r} V ${r} A ${r},${r} 0 0 1 ${r},0 Z`;
  p.drawSvgPath(path, { x, y: y + h, color, opacity, borderWidth: 0 });
}
function watermark(p: PDFPage, x: number, y: number, c: CardPrint, f: Fonts) {
  if (!c.watermark) return;
  const t = winAnsi(c.watermark);
  p.drawText(t, { x: x + 34, y: y + 30, size: 30, font: f.bold, color: rgb(0.85, 0.2, 0.2), opacity: 0.22, rotate: degrees(20) });
}
const contactLines = (c: CardPrint) => [c.school.address, c.school.phone ? `Tel. ${c.school.phone}` : null, c.school.email].filter((s): s is string => !!s);
const { w: W, h: H } = CARD;

// ====================================================================== Clássico

const classicFront: Face = (p, x, y, c, f, a) => {
  const band = 36;
  const onP = onColor(c.primary);
  p.drawRectangle({ x, y, width: W, height: H, color: WHITE });
  p.drawRectangle({ x, y: y + H - band, width: W, height: band, color: hex(c.primary) });
  p.drawRectangle({ x, y: y + H - band - 2.2, width: W, height: 2.2, color: hex(c.accent) });
  let tx = x + 10;
  const lw = logoAt(p, a.logo, x + 9, y + H - band + 7, 22, 44);
  if (lw) tx += lw + 7;
  line(p, c.school.name, tx, y + H - 17, 9, f.bold, onP, x + W - 10 - tx, { min: 5.5 });
  line(p, "CARTÃO DE ESTUDANTE", tx, y + H - 27.5, 5.6, f.regular, onP, x + W - 10 - tx, { opacity: 0.85 });
  // a fotografia
  photo(p, a.photo, x + 10, y + 26, 48, 62, hex(c.accent));
  // os dados
  const x0 = x + 68;
  const mw = W - 68 - 10;
  line(p, "NOME", x0, y + H - band - 13, 4.8, f.regular, MUTED, mw);
  nameLines(p, c.student.name, x0, y + H - band - 23, 9.2, f.bold, INK, mw, 10.2);
  field(p, f, "Classe", c.student.classLabel, x0, y + 64, mw);
  const col = mw / 3;
  field(p, f, "N.º de aluno", c.student.number, x0, y + 42, col - 4);
  field(p, f, "Turma", c.student.groupName, x0 + col, y + 42, col - 4);
  field(p, f, "Ano letivo", c.student.yearName, x0 + col * 2, y + 42, col);
  // validade
  p.drawRectangle({ x, y, width: W, height: 14, color: tint(c.primary, 0.9) });
  line(p, `Válido até ${c.validUntil}`, x + 10, y + 5, 5.8, f.bold, INK, W / 2);
  line(p, c.code, x + W / 2, y + 5, 5.4, f.mono, MUTED, W / 2 - 10, { center: false });
  watermark(p, x, y, c, f);
};
const classicBack: Face = (p, x, y, c, f) => {
  p.drawRectangle({ x, y, width: W, height: H, color: WHITE });
  p.drawRectangle({ x, y: y + H - 5, width: W, height: 5, color: hex(c.primary) });
  p.drawRectangle({ x, y, width: W, height: 3, color: hex(c.accent) });
  const q = c.verifyUrl ? 60 : 0;
  if (c.verifyUrl) {
    const qx = x + W - 10 - q;
    const qy = y + 30;
    qr(p, c.verifyUrl, qx, qy, q);
    line(p, c.code, qx - 6, qy - 8, 5.6, f.mono, INK, q + 12, { center: true });
    line(p, "Verifique o cartão pelo QR", qx - 6, qy - 15.5, 4.6, f.regular, MUTED, q + 12, { center: true });
  }
  const tx = x + 10;
  const mw = W - 20 - (q ? q + 10 : 0);
  line(p, c.school.name, tx, y + H - 19, 8, f.bold, INK, mw, { min: 5.5 });
  let ty = y + H - 29;
  for (const l of contactLines(c)) ty = para(p, l, tx, ty, 5.8, f.regular, INK, mw, 2, 7) - 1;
  para(p, c.backNote, tx, ty - 4, 5.4, f.regular, MUTED, mw, 5, 6.6);
  line(p, c.footer, tx, y + 9, 5, f.regular, MUTED, mw);
  if (!c.verifyUrl) line(p, `Código ${c.code}`, x + W - 10 - 90, y + 9, 5.4, f.mono, INK, 90);
  watermark(p, x, y, c, f);
};

// ====================================================================== Moderno

const modernFront: Face = (p, x, y, c, f, a) => {
  const pw = 84;
  const onP = onColor(c.primary);
  p.drawRectangle({ x, y, width: W, height: H, color: WHITE });
  p.drawRectangle({ x, y, width: pw, height: H, color: hex(c.primary) });
  p.drawRectangle({ x: x + pw, y, width: 2.6, height: H, color: hex(c.accent) });
  if (a.logo) {
    const s = Math.min(17 / a.logo.height, (pw - 20) / a.logo.width);
    const lw = a.logo.width * s;
    p.drawImage(a.logo, { x: x + (pw - lw) / 2, y: y + H - 9 - a.logo.height * s, width: lw, height: a.logo.height * s });
  }
  photo(p, a.photo, x + (pw - 54) / 2, y + 27, 54, 68, WHITE, 1.8);
  line(p, c.student.number ? `N.º ${c.student.number}` : "N.º —", x + 6, y + 13, 7.2, f.bold, onP, pw - 12, { center: true });
  const x0 = x + pw + 13;
  const mw = W - pw - 2.6 - 13 - 10;
  line(p, c.school.name, x0, y + H - 17, 7.2, f.bold, luminance(c.primary) < 0.6 ? hex(c.primary) : INK, mw, { min: 5 });
  line(p, "CARTÃO DE ESTUDANTE", x0, y + H - 25.5, 5.2, f.regular, MUTED, mw);
  const after = nameLines(p, c.student.name, x0, y + H - 43, 11, f.bold, INK, mw, 12);
  p.drawRectangle({ x: x0, y: after + 4, width: 20, height: 2, color: hex(c.accent) });
  field(p, f, "Classe", c.student.classLabel, x0, y + 56, mw);
  field(p, f, "Turma", c.student.groupName, x0, y + 35, mw / 2 - 4);
  field(p, f, "Ano letivo", c.student.yearName, x0 + mw / 2, y + 35, mw / 2);
  line(p, `Válido até ${c.validUntil}`, x0, y + 10, 5.4, f.regular, MUTED, mw);
  watermark(p, x, y, c, f);
};
const modernBack: Face = (p, x, y, c, f) => {
  const onP = onColor(c.primary);
  p.drawRectangle({ x, y, width: W, height: H, color: hex(c.primary) });
  p.drawRectangle({ x: x + W - 46, y: y + H - 4, width: 46, height: 4, color: hex(c.accent) });
  let tx = x + 12;
  if (c.verifyUrl) {
    const box = 66;
    const by = y + (H - box) / 2 + 5;
    roundRect(p, x + 10, by, box, box, 5, WHITE);
    qr(p, c.verifyUrl, x + 13, by + 3, box - 6);
    line(p, c.code, x + 4, by - 9, 5.6, f.mono, onP, box + 12, { center: true });
    tx = x + 10 + box + 12;
  }
  const mw = x + W - 10 - tx;
  line(p, c.school.name, tx, y + H - 20, 8, f.bold, onP, mw, { min: 5.5 });
  let ty = y + H - 30;
  for (const l of contactLines(c)) ty = para(p, l, tx, ty, 5.8, f.regular, onP, mw, 2, 7, 0.92) - 1;
  para(p, c.backNote, tx, ty - 4, 5.3, f.regular, onP, mw, 5, 6.5, 0.8);
  line(p, c.footer, tx, y + 9, 5, f.regular, onP, mw, { opacity: 0.75 });
  if (!c.verifyUrl) line(p, `Código ${c.code}`, x + 12, y + 18, 5.6, f.mono, onP, 120);
  watermark(p, x, y, c, f);
};

// ====================================================================== Contemporâneo

const contemporaryFront: Face = (p, x, y, c, f, a) => {
  const onP = onColor(c.primary);
  p.drawRectangle({ x, y, width: W, height: H, color: hex(c.primary) });
  p.pushOperators(pushGraphicsState(), rectangle(x, y, W, H), clip(), endPath());
  p.drawCircle({ x: x + W - 6, y: y + H + 6, size: 64, color: hex(c.accent), opacity: 0.42 });
  p.drawCircle({ x: x + W - 34, y: y + H - 6, size: 26, color: WHITE, opacity: 0.08 });
  p.drawCircle({ x: x + 14, y: y - 18, size: 40, color: WHITE, opacity: 0.07 });
  p.pushOperators(popGraphicsState());
  let tx = x + 10;
  const lw = logoAt(p, a.logo, x + 10, y + H - 27, 18, 36);
  if (lw) tx += lw + 6;
  line(p, c.school.name, tx, y + H - 16, 7.4, f.bold, onP, x + W - 58 - tx, { min: 5 });
  line(p, "CARTÃO DE ESTUDANTE", tx, y + H - 24.5, 5, f.regular, onP, x + W - 58 - tx, { opacity: 0.85 });
  // o cartão branco
  const panel = { x: x + 7, y: y + 7, w: W - 14, h: 108 };
  roundRect(p, panel.x, panel.y, panel.w, panel.h, 7, WHITE);
  photo(p, a.photo, panel.x + 8, panel.y + 30, 50, 64, tint(c.primary, 0.75), 0.8);
  line(p, `Válido até ${c.validUntil}`, panel.x + 8, panel.y + 18, 5, f.bold, INK, 58);
  line(p, c.student.number ? `N.º ${c.student.number}` : "", panel.x + 8, panel.y + 9.5, 5, f.regular, MUTED, 58);
  const x0 = panel.x + 66;
  const q = c.verifyUrl ? 36 : 0;
  const mw = panel.x + panel.w - 8 - x0;
  nameLines(p, c.student.name, x0, panel.y + panel.h - 15, 9.4, f.bold, hex(luminance(c.primary) < 0.6 ? c.primary : "#0f1c1a"), mw, 10.4);
  field(p, f, "Classe", c.student.classLabel, x0, panel.y + 70, mw);
  field(p, f, "Turma", c.student.groupName, x0, panel.y + 50, (mw - q) / 2 - 3);
  field(p, f, "Ano letivo", c.student.yearName, x0 + (mw - q) / 2, panel.y + 50, (mw - q) / 2);
  if (c.verifyUrl) qr(p, c.verifyUrl, panel.x + panel.w - 8 - q, panel.y + 7, q);
  line(p, c.code, x0, panel.y + 9.5, 5.2, f.mono, MUTED, mw - q - 4);
  watermark(p, x, y, c, f);
};
const contemporaryBack: Face = (p, x, y, c, f) => {
  p.drawRectangle({ x, y, width: W, height: H, color: WHITE });
  p.pushOperators(pushGraphicsState(), rectangle(x, y, W, H), clip(), endPath());
  p.drawCircle({ x: x + W, y, size: 56, color: hex(c.accent), opacity: 0.18 });
  p.pushOperators(popGraphicsState());
  p.drawRectangle({ x, y, width: 6, height: H, color: hex(c.primary) });
  const q = c.verifyUrl ? 58 : 0;
  if (c.verifyUrl) {
    const qx = x + W - 10 - q;
    const qy = y + 34;
    qr(p, c.verifyUrl, qx, qy, q);
    line(p, c.code, qx - 6, qy - 8, 5.6, f.mono, INK, q + 12, { center: true });
  }
  const tx = x + 15;
  const mw = W - 15 - 10 - (q ? q + 10 : 0);
  line(p, c.school.name, tx, y + H - 19, 8, f.bold, luminance(c.primary) < 0.6 ? hex(c.primary) : INK, mw, { min: 5.5 });
  let ty = y + H - 29;
  for (const l of contactLines(c)) ty = para(p, l, tx, ty, 5.8, f.regular, INK, mw, 2, 7) - 1;
  para(p, c.backNote, tx, ty - 4, 5.4, f.regular, MUTED, mw, 5, 6.6);
  line(p, c.footer, tx, y + 9, 5, f.regular, MUTED, mw);
  if (!c.verifyUrl) line(p, `Código ${c.code}`, x + W - 10 - 90, y + 9, 5.4, f.mono, INK, 90);
  watermark(p, x, y, c, f);
};

const FACES: Record<CardModel, { front: Face; back: Face }> = {
  CLASSICO: { front: classicFront, back: classicBack },
  MODERNO: { front: modernFront, back: modernBack },
  CONTEMPORANEO: { front: contemporaryFront, back: contemporaryBack },
};

async function embedPhoto(doc: Doc, b: Buffer | null) {
  if (!b) return null;
  try {
    if (b[0] === 0xff && b[1] === 0xd8) return await doc.embedJpg(b);
    if (b[0] === 0x89 && b[1] === 0x50) return await doc.embedPng(b);
  } catch {
    /* tratada fora: o cartão não se emite sem fotografia */
  }
  return null;
}

/** Os cartões num PDF: um por página (frente e verso) ou em folhas A4 de 10 com marcas de corte. */
export async function renderCardsPdf(cards: CardPrint[], layout: "CARD" | "SHEET", title = "Cartões de estudante"): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(winAnsi(title));
  doc.setProducer("EduFlow");
  doc.setCreator("EduFlow");
  const f: Fonts = { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), mono: await doc.embedFont(StandardFonts.CourierBold) };
  const logos = new Map<Buffer, PDFImage | null>();
  const assets: Assets[] = [];
  for (const c of cards) {
    if (c.logo && !logos.has(c.logo)) logos.set(c.logo, await embedLogo(doc, c.logo));
    assets.push({ logo: c.logo ? (logos.get(c.logo) ?? null) : null, photo: await embedPhoto(doc, c.photo) });
  }
  if (layout === "CARD") {
    cards.forEach((c, i) => {
      FACES[c.model].front(doc.addPage([W, H]), 0, 0, c, f, assets[i]);
      FACES[c.model].back(doc.addPage([W, H]), 0, 0, c, f, assets[i]);
    });
    return Buffer.from(await doc.save());
  }
  // folhas A4: 2 colunas × 5 linhas
  const mx = (A4.w - 2 * W) / 2;
  const my = (A4.h - 5 * H) / 2;
  const sheets = Math.ceil(cards.length / 10);
  const marks = (p: PDFPage) => {
    const c = { thickness: 0.4, color: rgb(0.45, 0.45, 0.45) };
    for (const cx of [mx, mx + W, mx + 2 * W]) {
      p.drawLine({ start: { x: cx, y: A4.h - my + 3 }, end: { x: cx, y: A4.h - my + 13 }, ...c });
      p.drawLine({ start: { x: cx, y: my - 3 }, end: { x: cx, y: my - 13 }, ...c });
    }
    for (let k = 0; k <= 5; k++) {
      const cy = my + k * H;
      p.drawLine({ start: { x: mx - 3, y: cy }, end: { x: mx - 13, y: cy }, ...c });
      p.drawLine({ start: { x: A4.w - mx + 3, y: cy }, end: { x: A4.w - mx + 13, y: cy }, ...c });
    }
  };
  for (let s = 0; s < sheets; s++) {
    const chunk = cards.slice(s * 10, s * 10 + 10);
    for (const side of ["front", "back"] as const) {
      const p = doc.addPage([A4.w, A4.h]);
      marks(p);
      const head = side === "front" ? `Frente · folha ${s + 1} de ${sheets} · imprima frente e verso (virar pelo lado maior), sem ajustar à página, e corte pelas marcas` : `Verso · folha ${s + 1} de ${sheets}`;
      line(p, head, mx, A4.h - my + 18, 7, f.regular, MUTED, 2 * W);
      chunk.forEach((c, i) => {
        const col = side === "front" ? i % 2 : 1 - (i % 2);
        const row = Math.floor(i / 2);
        FACES[c.model][side](p, mx + col * W, A4.h - my - (row + 1) * H, c, f, assets[s * 10 + i]);
      });
    }
  }
  return Buffer.from(await doc.save());
}
