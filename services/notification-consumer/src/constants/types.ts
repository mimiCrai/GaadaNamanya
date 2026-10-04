// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Services
    HealthService: Symbol.for('HealthService'),
    MessageSubscriber: Symbol.for('MessageSubscriber'),
    NotificationEventConsumer: Symbol.for('NotificationEventConsumer'),
};
