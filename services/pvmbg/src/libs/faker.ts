import { createHash } from 'crypto';
import { base, Faker } from '@faker-js/faker';

export function createFaker(seed?: string): Faker {
    const faker = new Faker({ locale: [base] });
    if (seed !== undefined) {
        faker.seed(createHash('sha256').update(seed).digest().readUInt32LE(0));
    }
    return faker;
}
