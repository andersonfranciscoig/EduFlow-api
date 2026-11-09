"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STATUS_LABELS = exports.ROLE_LABELS = exports.PERMISSIONS = exports.PERMISSION_CATALOG = exports.STAFF_STATUSES = exports.STAFF_ROLES = void 0;
exports.isPermission = isPermission;
exports.rolePermissions = rolePermissions;
exports.effectivePermissions = effectivePermissions;
exports.roleHasPermission = roleHasPermission;
exports.STAFF_ROLES = ["ADMIN", "GESTOR"];
exports.STAFF_STATUSES = ["PENDING_APPROVAL", "ACTIVE", "SUSPENDED"];
exports.PERMISSION_CATALOG = [
    { key: "schools.view", group: "Colégios", label: "Ver colégios", description: "Consultar a lista e os dados dos colégios clientes." },
    { key: "schools.manage", group: "Colégios", label: "Gerir colégios", description: "Criar, editar e desativar colégios." },
    { key: "staff.view", group: "Equipa", label: "Ver equipa", description: "Consultar os membros da equipa e o seu histórico." },
    { key: "staff.manage", group: "Equipa", label: "Gerir equipa", description: "Aprovar, desativar e atribuir permissões a gestores." },
    { key: "billing.view", group: "Faturação", label: "Ver faturação", description: "Consultar planos, faturas e pagamentos." },
    { key: "billing.manage", group: "Faturação", label: "Gerir faturação", description: "Alterar planos, emitir e anular faturas." },
    { key: "settings.manage", group: "Definições", label: "Gerir definições", description: "Alterar as definições gerais da plataforma." },
];
exports.PERMISSIONS = exports.PERMISSION_CATALOG.map((p) => p.key);
const ROLE_PERMISSIONS = {
    ADMIN: exports.PERMISSIONS,
    GESTOR: [],
};
function isPermission(value) {
    return exports.PERMISSIONS.includes(value);
}
function rolePermissions(role) {
    return [...ROLE_PERMISSIONS[role]];
}
function effectivePermissions(role, extra) {
    const set = new Set([...ROLE_PERMISSIONS[role], ...extra]);
    return exports.PERMISSIONS.filter((p) => set.has(p));
}
function roleHasPermission(role, permission) {
    return ROLE_PERMISSIONS[role].includes(permission);
}
exports.ROLE_LABELS = {
    ADMIN: "Administrador",
    GESTOR: "Gestor",
};
exports.STATUS_LABELS = {
    PENDING_APPROVAL: "A aguardar aprovação",
    ACTIVE: "Ativo",
    SUSPENDED: "Desativado",
};
//# sourceMappingURL=access-control.js.map