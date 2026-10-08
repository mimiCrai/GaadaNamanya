// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Services
    HealthService: Symbol.for('HealthService'),
    JwtAuthenticator: Symbol.for('JwtAuthenticator'),
    HazardGateway: Symbol.for('HazardGateway'),
};
