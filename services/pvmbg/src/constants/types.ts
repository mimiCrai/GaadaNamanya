// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Runtime
    Config: Symbol.for('Config'),
    Logger: Symbol.for('Logger'),
    Clock: Symbol.for('Clock'),
    Faker: Symbol.for('Faker'),

    // Repositories
    IReportStore: Symbol.for('IReportStore'),

    // Services
    GeneratorService: Symbol.for('GeneratorService'),
    SchemaService: Symbol.for('SchemaService'),
    OutageService: Symbol.for('OutageService'),

    // Middlewares
    OutageMiddleware: Symbol.for('OutageMiddleware'),
    DataAuthMiddleware: Symbol.for('DataAuthMiddleware'),
    AdminAuthMiddleware: Symbol.for('AdminAuthMiddleware'),
    DelayMiddleware: Symbol.for('DelayMiddleware'),

    HealthService: Symbol.for('HealthService'),
};

export type Clock = () => number;
