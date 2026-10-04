// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    Database: Symbol.for('Database'),

    // Repositories
    INotificationRepository: Symbol.for('INotificationRepository'),

    // Services
    IHealthService: Symbol.for('IHealthService'),
    IMessageSubscriber: Symbol.for('IMessageSubscriber'),
    INotificationService: Symbol.for('INotificationService'),
    INotificationEventConsumer: Symbol.for('INotificationEventConsumer'),
};
