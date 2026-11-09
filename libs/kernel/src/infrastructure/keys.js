"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readKeyFile = readKeyFile;
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
function readKeyFile(file) {
    try {
        return (0, node_fs_1.readFileSync)(node_path_1.default.resolve(file), "utf8");
    }
    catch {
        throw new Error(`Não foi possível ler a chave "${file}". Corra "pnpm setup" para gerar as chaves de desenvolvimento.`);
    }
}
function encryptSecret(publicKeyPem, plaintext) {
    return (0, node_crypto_1.publicEncrypt)({ key: publicKeyPem, padding: node_crypto_1.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(plaintext, "utf8")).toString("base64");
}
function decryptSecret(privateKeyPem, ciphertextB64) {
    return (0, node_crypto_1.privateDecrypt)({ key: privateKeyPem, padding: node_crypto_1.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(ciphertextB64, "base64")).toString("utf8");
}
//# sourceMappingURL=keys.js.map