// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Runtime
    Config: Symbol.for('Config'),
    Logger: Symbol.for('Logger'),
    Clock: Symbol.for('Clock'),
    Faker: Symbol.for('Faker'),

    // Repositories
    IEventStore: Symbol.for('IEventStore'),

    // Services
    GeneratorService: Symbol.for('GeneratorService'),

    // Middlewares
    DataAuthMiddleware: Symbol.for('DataAuthMiddleware'),
    DelayMiddleware: Symbol.for('DelayMiddleware'),

    HealthService: Symbol.for('HealthService'),
};

export type Clock = () => number;
