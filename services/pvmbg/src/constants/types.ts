// Inversify binding symbols
// Use these to identify injectable services

export const TYPES = {
    // Runtime
    Config: Symbol.for('Config'),
    Logger: Symbol.for('Logger'),
    Clock: Symbol.for('Clock'),
    Faker: Symbol.for('Faker'),
    Database: Symbol.for('Database'),

    // Repositories
    IReportRepository: Symbol.for('IReportRepository'),

    // Services
    GeneratorService: Symbol.for('GeneratorService'),
    SchemaService: Symbol.for('SchemaService'),
    OutageService: Symbol.for('OutageService'),

    // Middlewares
    OutageMiddleware: Symbol.for('OutageMiddleware'),
    DataAuthMiddleware: Symbol.for('DataAuthMiddleware'),
    DelayMiddleware: Symbol.for('DelayMiddleware'),

    HealthService: Symbol.for('HealthService'),
};

export type Clock = () => number;
