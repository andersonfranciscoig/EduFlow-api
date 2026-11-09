"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.randomCodes = exports.JwtSchoolTokenService = void 0;
const node_crypto_1 = require("node:crypto");
const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:school-owner";
class JwtSchoolTokenService {
    jwt;
    expiresInSeconds;
    constructor(jwt, expiresInSeconds) {
        this.jwt = jwt;
        this.expiresInSeconds = expiresInSeconds;
    }
    async issue(schoolId) {
        const accessToken = await this.jwt.signAsync({ sub: schoolId, kind: "school-owner" }, { issuer: ISSUER, audience: AUDIENCE, expiresIn: this.expiresInSeconds });
        return { accessToken, expiresIn: this.expiresInSeconds };
    }
    async verify(token) {
        try {
            const payload = await this.jwt.verifyAsync(token, {
                issuer: ISSUER,
                audience: AUDIENCE,
                algorithms: ["ES256"],
            });
            return payload.kind === "school-owner" && payload.sub ? payload.sub : null;
        }
        catch {
            return null;
        }
    }
}
exports.JwtSchoolTokenService = JwtSchoolTokenService;
exports.randomCodes = {
    orderNumber(now) {
        const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
        return `EF-${ymd}-${String((0, node_crypto_1.randomInt)(0, 100_000)).padStart(5, "0")}`;
    },
    referenceNumber() {
        return String((0, node_crypto_1.randomInt)(100_000_000, 1_000_000_000));
    },
};
//# sourceMappingURL=adapters.js.map