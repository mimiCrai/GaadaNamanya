// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Clients
    IAggregatorClient: Symbol.for('IAggregatorClient'),

    // Services (bind to interfaces)
    HealthService: Symbol.for('HealthService'),
    IFieldReportConsumer: Symbol.for('IFieldReportConsumer'),

    // Message Queue
    IMessageSubscriber: Symbol.for('IMessageSubscriber'),
};
