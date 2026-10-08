// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Database
    Database: Symbol.for('Database'),

    // Repositories (bind to interfaces)
    IUserRepository: Symbol.for('IUserRepository'),
    ISessionRepository: Symbol.for('ISessionRepository'),

    // Services (bind to interfaces)
    HealthService: Symbol.for('HealthService'),
    IAuthService: Symbol.for('IAuthService'),
};
