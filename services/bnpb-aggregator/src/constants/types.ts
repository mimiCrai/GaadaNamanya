// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Database
    Database: Symbol.for('Database'),

    // Repositories (bind to interfaces)
    IHazardEventRepository: Symbol.for('IHazardEventRepository'),
    ISourceSyncStateRepository: Symbol.for('ISourceSyncStateRepository'),
    IOutboxEventRepository: Symbol.for('IOutboxEventRepository'),
    IPendingTsunamiWarningRepository: Symbol.for('IPendingTsunamiWarningRepository'),

    // Services (bind to interfaces)
    IHealthService: Symbol.for('IHealthService'),
    IHazardEventService: Symbol.for('IHazardEventService'),
    ISourceSyncStateService: Symbol.for('ISourceSyncStateService'),
    IHazardEventIngestionService: Symbol.for('IHazardEventIngestionService'),
    IPollingService: Symbol.for('IPollingService'),
    IOutboxRelayService: Symbol.for('IOutboxRelayService'),

    // Source REST clients
    IBmkgClient: Symbol.for('IBmkgClient'),
    IPvmbgClient: Symbol.for('IPvmbgClient'),

    // Message Queue
    IMessagePublisher: Symbol.for('IMessagePublisher'),
};
