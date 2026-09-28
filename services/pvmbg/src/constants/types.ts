// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Database
    Database: Symbol.for('Database'),

    // Repositories (bind to interfaces)
    IItemRepository: Symbol.for('IItemRepository'),

    // Services (bind to interfaces)
    HealthService: Symbol.for('HealthService'),
    IItemService: Symbol.for('IItemService'),
};
