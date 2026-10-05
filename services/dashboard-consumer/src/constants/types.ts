// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    Database: Symbol.for('Database'),

    // Repositories
    IDashboardProjectionRepository: Symbol.for('IDashboardProjectionRepository'),

    // Services
    IHealthService: Symbol.for('IHealthService'),
    IMessageSubscriber: Symbol.for('IMessageSubscriber'),
    IDashboardProjectionService: Symbol.for('IDashboardProjectionService'),
    IDashboardEventConsumer: Symbol.for('IDashboardEventConsumer'),
};
