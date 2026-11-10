import { constants, createCipheriv, createDecipheriv, privateDecrypt, publicEncrypt, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Lê uma chave PEM de um ficheiro (em produção: montado como Docker secret /
 * vindo de um gestor de segredos). Falha cedo e com mensagem clara.
 */
export function readKeyFile(file: string): string {
  try {
    return readFileSync(path.resolve(file), "utf8");
  } catch {
    throw new Error(`Não foi possível ler a chave "${file}". Corra "pnpm run setup" para gerar as chaves de desenvolvimento.`);
  }
}

/**
 * Credenciais das bases de dados dos colégios.
 * Cifradas com a chave PÚBLICA (provisioner) e só decifráveis com a PRIVADA,
 * que existe apenas no school-api. RSA-OAEP com SHA-256.
 */
export function encryptSecret(publicKeyPem: string, plaintext: string): string {
  return publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(plaintext, "utf8"),
  ).toString("base64");
}

export function decryptSecret(privateKeyPem: string, ciphertextB64: string): string {
  return privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(ciphertextB64, "base64"),
  ).toString("utf8");
}

/**
 * Cifra em envelope (qualquer tamanho): uma chave AES-256-GCM aleatória cifra
 * o texto e é ela própria cifrada com a chave PÚBLICA (RSA-OAEP).
 * Quem só tem a chave pública consegue selar, mas nunca abrir.
 * Formato: env1.<chave>.<iv>.<tag>.<dados> (base64url)
 */
export function sealSecret(publicKeyPem: string, plaintext: string): string {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrapped = publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return ["env1", wrapped, iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function openSealed(privateKeyPem: string, sealed: string): string {
  const [version, wrapped, iv, tag, data] = sealed.split(".");
  if (version !== "env1" || !wrapped || !iv || !tag || data === undefined) throw new Error("Segredo selado inválido.");
  const key = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(wrapped, "base64url"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}
