export const TYPES = {
    Database: Symbol.for('Database'),

    IHazardEventRepository: Symbol.for('IHazardEventRepository'),
    ISourceSyncStateRepository: Symbol.for('ISourceSyncStateRepository'),
    IOutboxEventRepository: Symbol.for('IOutboxEventRepository'),
    IPendingTsunamiWarningRepository: Symbol.for('IPendingTsunamiWarningRepository'),

    IHealthService: Symbol.for('IHealthService'),
    IHazardEventService: Symbol.for('IHazardEventService'),
    ISourceSyncStateService: Symbol.for('ISourceSyncStateService'),
    IHazardEventIngestionService: Symbol.for('IHazardEventIngestionService'),
    IPollingService: Symbol.for('IPollingService'),
    IOutboxRelayService: Symbol.for('IOutboxRelayService'),

    IBmkgClient: Symbol.for('IBmkgClient'),
    IPvmbgClient: Symbol.for('IPvmbgClient'),

    IMessagePublisher: Symbol.for('IMessagePublisher'),

    InternalAuthMiddleware: Symbol.for('InternalAuthMiddleware'),
};
