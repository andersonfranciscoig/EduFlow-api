"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.uuidGenerator = exports.systemClock = void 0;
const node_crypto_1 = require("node:crypto");
exports.systemClock = { now: () => new Date() };
exports.uuidGenerator = { next: () => (0, node_crypto_1.randomUUID)() };
//# sourceMappingURL=system.js.map