import { randomInt } from "node:crypto";

/**
 * CARTÕES DE ESTUDANTE — os três modelos da plataforma, a personalização que o colégio pode fazer,
 * o código de verificação (impresso e no QR) e o estado de um cartão.
 */
export type CardModel = "CLASSICO" | "MODERNO" | "CONTEMPORANEO";
export const CARD_MODELS: Record<CardModel, { label: string; hint: string }> = {
  CLASSICO: { label: "Clássico", hint: "Faixa com o nome do colégio, fotografia à esquerda e os dados em grelha. Sóbrio e fácil de ler." },
  MODERNO: { label: "Moderno", hint: "Painel lateral na cor do colégio com a fotografia e o n.º; o nome em destaque." },
  CONTEMPORANEO: { label: "Contemporâneo", hint: "Fundo na cor do colégio com formas suaves, cartão branco com os dados e o QR à frente." },
};
export const CARD_MODEL_KEYS = Object.keys(CARD_MODELS) as CardModel[];

/** Os documentos desta categoria são cartões: emitem-se com o modelo do cartão, não com um modelo de texto. */
export const CARD_CATEGORY = "Cartões de estudante";
export const isCardCategory = (category: string) => category === CARD_CATEGORY;

export interface CardSettings {
  model: CardModel;
  primaryColor: string;
  accentColor: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  showQr: boolean;
  backNote: string | null;
}
export const DEFAULT_CARD_SETTINGS: CardSettings = { model: "CLASSICO", primaryColor: "#0f3d33", accentColor: "#c9a227", address: null, phone: null, email: null, showQr: true, backNote: null };
export const DEFAULT_BACK_NOTE = "Este cartão é pessoal e intransmissível e só é válido com a matrícula em vigor. Se o encontrar, entregue-o no colégio.";

const HEX = /^#[0-9a-f]{6}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const opt = (v: unknown, max: number) => {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max + 1) : null;
};

/** Valida a personalização (cores #rrggbb, contactos e o texto do verso com limites). */
export function checkCardSettings(input: { model: string; primaryColor: string; accentColor: string; address?: string | null; phone?: string | null; email?: string | null; showQr: boolean; backNote?: string | null }): { ok: true; value: CardSettings } | { ok: false; message: string } {
  if (!CARD_MODEL_KEYS.includes(input.model as CardModel)) return { ok: false, message: "Escolha um dos três modelos." };
  const primary = String(input.primaryColor ?? "").trim().toLowerCase();
  const accent = String(input.accentColor ?? "").trim().toLowerCase();
  if (!HEX.test(primary) || !HEX.test(accent)) return { ok: false, message: "As cores escrevem-se como #RRGGBB (ex.: #0F3D33)." };
  if (luminance(primary) > 0.8) return { ok: false, message: "A cor principal é demasiado clara: o texto por cima não se leria. Escolha uma cor mais escura." };
  const address = opt(input.address, 160);
  const phone = opt(input.phone, 40);
  const email = opt(input.email, 120);
  const backNote = opt(input.backNote, 240);
  if (address && address.length > 160) return { ok: false, message: "O endereço tem no máximo 160 caracteres." };
  if (phone && (phone.length > 40 || !/^[0-9+()\s/-]{6,}$/.test(phone))) return { ok: false, message: "O telefone só leva algarismos, espaços e + ( ) / - (até 40)." };
  if (email && (email.length > 120 || !EMAIL.test(email))) return { ok: false, message: "O email não parece válido." };
  if (backNote && backNote.length > 240) return { ok: false, message: "O texto do verso tem no máximo 240 caracteres." };
  return { ok: true, value: { model: input.model as CardModel, primaryColor: primary, accentColor: accent, address, phone, email, showQr: !!input.showQr, backNote } };
}

/** Luminância relativa (0 = preto, 1 = branco), para escolher texto claro ou escuro por cima de uma cor. */
export function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// sem 0/O, 1/I/L: lê-se e escreve-se sem enganos
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** Código de verificação: 12 caracteres (≈ 59 bits), impresso como XXXX-XXXX-XXXX. */
export const newCardCode = () => Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
export const formatCardCode = (c: string) => c.replace(/(.{4})(?=.)/g, "$1-");
/** O que a pessoa escreveu (com ou sem hífenes, minúsculas) → o código guardado; null se não pode ser um código. */
export function normalizeCardCode(raw: string) {
  const c = String(raw ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  return c.length === 12 && [...c].every((x) => ALPHABET.includes(x)) ? c : null;
}

/** "Pedro Manuel Silva" → "Pedro S.": quem confere o cartão compara, sem a página mostrar o nome todo. */
export function maskedName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return `${(parts[0] ?? "").slice(0, 1)}.`;
  return `${parts[0]} ${parts[parts.length - 1].slice(0, 1).toUpperCase()}.`;
}

export type CardStatus = "ACTIVE" | "REPLACED" | "REVOKED";
export type CardValidity = "VALID" | "EXPIRED" | "REPLACED" | "REVOKED" | "INACTIVE";
export const VALIDITY_LABELS: Record<CardValidity, string> = {
  VALID: "Cartão válido",
  EXPIRED: "Cartão fora da validade",
  REPLACED: "Cartão substituído por uma segunda via",
  REVOKED: "Cartão anulado pelo colégio",
  INACTIVE: "O aluno já não está matriculado",
};
/** A validade de um cartão hoje: ativo, dentro do prazo e com o aluno ainda matriculado. */
export function cardValidity(c: { status: CardStatus; validUntil: string; studentStatus: string }, today: string): CardValidity {
  if (c.status === "REVOKED") return "REVOKED";
  if (c.status === "REPLACED") return "REPLACED";
  if (c.validUntil < today) return "EXPIRED";
  if (!["ENROLLED", "SUSPENDED"].includes(c.studentStatus)) return "INACTIVE";
  return "VALID";
}

/** Fotografias que se imprimem (o PDF só embebe JPG e PNG). */
export const PRINTABLE_PHOTO = ["image/jpeg", "image/png"];
