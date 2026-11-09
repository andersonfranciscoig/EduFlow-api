"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalFileStorage = void 0;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = __importDefault(require("node:path"));
const EXTENSIONS = {
    "application/pdf": ".pdf",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
};
class LocalFileStorage {
    root;
    constructor(root) {
        this.root = root;
    }
    async save(folder, file) {
        const safeFolder = folder.replace(/[^a-zA-Z0-9/_-]/g, "");
        const key = node_path_1.default.posix.join(safeFolder, `${(0, node_crypto_1.randomUUID)()}${EXTENSIONS[file.mimeType] ?? ""}`);
        const target = this.resolve(key);
        await (0, promises_1.mkdir)(node_path_1.default.dirname(target), { recursive: true });
        await (0, promises_1.writeFile)(target, file.content);
        return { key, fileName: file.fileName, mimeType: file.mimeType, size: file.content.length };
    }
    read(key) {
        return (0, promises_1.readFile)(this.resolve(key));
    }
    resolve(key) {
        const root = node_path_1.default.resolve(this.root);
        const full = node_path_1.default.resolve(root, key);
        if (!full.startsWith(root + node_path_1.default.sep))
            throw new Error("Caminho de ficheiro inválido");
        return full;
    }
}
exports.LocalFileStorage = LocalFileStorage;
//# sourceMappingURL=LocalFileStorage.js.map