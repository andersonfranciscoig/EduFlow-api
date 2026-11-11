import { fail, ok, type Result } from "../../../../../../../libs/kernel/src/domain/Result";
import { schoolError, type SchoolError } from "./errors";

/** Logótipo do colégio: imagem pública, pequena e sem SVG (um SVG pode levar scripts). */
export const LOGO_RULES = {
  MAX_BYTES: 2 * 1024 * 1024,
  MIN_SIDE: 64,
  MAX_SIDE: 4096,
  TYPES: ["image/png", "image/jpeg", "image/webp"] as const,
} as const;

export type LogoMimeType = (typeof LOGO_RULES.TYPES)[number];

export interface SchoolLogo {
  key: string;
  url: string;
  updatedAt: Date;
}

export interface InspectedImage {
  mimeType: LogoMimeType;
  width: number;
  height: number;
}

/**
 * Lê o tipo e as dimensões a partir dos BYTES (assinatura + cabeçalho), sem
 * confiar no nome nem no tipo que o browser indicou.
 */
export function inspectImage(data: Buffer): InspectedImage | null {
  if (data.length < 32) return null;

  // PNG: assinatura + IHDR (largura/altura em big-endian)
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && data.toString("latin1", 12, 16) === "IHDR") {
    return { mimeType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  // JPEG: FF D8 FF, depois procurar o segmento SOFn (tem as dimensões)
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) return null;
      const marker = data[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = data.readUInt16BE(i + 2);
      if (length < 2) return null;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { mimeType: "image/jpeg", height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
      if (marker === 0xda || marker === 0xd9) return null; // dados da imagem sem SOF antes
      i += 2 + length;
    }
    return null;
  }

  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") {
    const chunk = data.toString("latin1", 12, 16);
    if (chunk === "VP8 " && data.length >= 30) {
      return { mimeType: "image/webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && data.length >= 25 && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X" && data.length >= 30) {
      return { mimeType: "image/webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
    }
  }
  return null;
}

/** Valida um logótipo enviado: tipo real, tamanho do ficheiro e dimensões. */
export function checkLogo(data: Buffer): Result<InspectedImage, SchoolError> {
  if (data.length === 0 || data.length > LOGO_RULES.MAX_BYTES) {
    return fail(schoolError("INVALID_LOGO", "O logótipo tem de ter no máximo 2 MB."));
  }
  const image = inspectImage(data);
  if (!image) return fail(schoolError("INVALID_LOGO", "Use uma imagem PNG, JPG ou WebP."));
  const { width, height } = image;
  if (Math.min(width, height) < LOGO_RULES.MIN_SIDE) {
    return fail(schoolError("INVALID_LOGO", `A imagem é demasiado pequena (mínimo ${LOGO_RULES.MIN_SIDE}×${LOGO_RULES.MIN_SIDE} px).`));
  }
  if (Math.max(width, height) > LOGO_RULES.MAX_SIDE) {
    return fail(schoolError("INVALID_LOGO", `A imagem é demasiado grande (máximo ${LOGO_RULES.MAX_SIDE} px de lado).`));
  }
  return ok(image);
}
