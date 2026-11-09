import { constants, privateDecrypt, publicEncrypt } from "node:crypto";
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
    throw new Error(`Não foi possível ler a chave "${file}". Corra "pnpm setup" para gerar as chaves de desenvolvimento.`);
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
