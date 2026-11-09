"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fail = exports.ok = void 0;
const ok = (value) => ({ ok: true, value });
exports.ok = ok;
const fail = (error) => ({ ok: false, error });
exports.fail = fail;
//# sourceMappingURL=Result.js.map