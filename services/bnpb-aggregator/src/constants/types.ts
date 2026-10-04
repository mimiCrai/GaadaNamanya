// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Database
    Database: Symbol.for('Database'),

    // Repositories (bind to interfaces)
    IHazardEventRepository: Symbol.for('IHazardEventRepository'),
    ISourceSyncStateRepository: Symbol.for('ISourceSyncStateRepository'),

    // Services (bind to interfaces)
    HealthService: Symbol.for('HealthService'),
    IHazardEventService: Symbol.for('IHazardEventService'),
    ISourceSyncStateService: Symbol.for('ISourceSyncStateService'),
    // Message Queue
    MessagePublisher: Symbol.for('MessagePublisher'),
};
