"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JwtAccessTokenService = void 0;
const ISSUER = "eduflow:platform";
const AUDIENCE = "eduflow:platform-staff";
class JwtAccessTokenService {
    jwt;
    expiresInSeconds;
    constructor(jwt, expiresInSeconds) {
        this.jwt = jwt;
        this.expiresInSeconds = expiresInSeconds;
    }
    async issue(principal) {
        const payload = { sub: principal.id, name: principal.fullName, role: principal.role };
        const accessToken = await this.jwt.signAsync(payload, {
            issuer: ISSUER,
            audience: AUDIENCE,
            expiresIn: this.expiresInSeconds,
        });
        return { accessToken, expiresIn: this.expiresInSeconds };
    }
    async verify(token) {
        try {
            const payload = await this.jwt.verifyAsync(token, {
                issuer: ISSUER,
                audience: AUDIENCE,
                algorithms: ["ES256"],
            });
            if (!payload.sub || (payload.role !== "ADMIN" && payload.role !== "GESTOR"))
                return null;
            return { id: payload.sub, fullName: payload.name, role: payload.role };
        }
        catch {
            return null;
        }
    }
}
exports.JwtAccessTokenService = JwtAccessTokenService;
//# sourceMappingURL=JwtAccessTokenService.js.map