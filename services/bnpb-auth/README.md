# Repo Template

A Node.js API template with Express, Inversify (DI), Drizzle ORM, and RabbitMQ.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Node.js 22+ |
| Language | TypeScript 5.x |
| Web Framework | Express 4.x |
| DI Container | Inversify |
| ORM | Drizzle ORM |
| Database | PostgreSQL |
| Message Queue | RabbitMQ |
| Caching | Redis |
| Validation | Zod + OpenAPI Validator |
| Logging | Pino |
| Testing | Jest + Supertest |

## Project Structure

```
src/
├── app.ts                 # Express app setup with middleware
├── server.ts              # Entry point
├── config/
│   └── inversify.config.ts # Dependency injection bindings
├── constants/
│   └── types.ts           # DI symbols
├── controllers/           # HTTP route handlers
│   ├── health.controller.ts
│   └── auth.controller.ts
├── services/              # Business logic (includes interface)
│   ├── health.service.ts
│   ├── auth.service.ts
│   ├── message-publisher.service.ts
│   └── message-subscriber.service.ts
├── repositories/          # Data access layer (includes interface)
│   ├── user.repository.ts
│   └── session.repository.ts
├── types/                 # DTOs only
│   ├── index.ts
│   └── auth.ts            # Authentication DTOs
├── db/
│   ├── index.ts           # Database connection
│   ├── schema/            # Drizzle table definitions
│   └── migrations/        # Database migrations
├── libs/
│   └── logger.ts          # Pino logger setup
└── util/
    └── env.ts             # Zod-validated environment config

tests/
├── setup.ts               # Jest setup
├── controllers/           # API tests
└── services/              # Unit tests

docs/
└── openapi.yaml           # API specification
```

## Getting Started

### Prerequisites

- Node.js 22+
- Docker & Docker Compose

### Setup

1. **Clone and install dependencies**
   ```bash
   git clone <repo-url>
   cd repo-template
   npm install
   ```

2. **Set up environment**
   ```bash
   cp .env.example .env
   ```

3. **Start infrastructure**
   ```bash
   docker compose up -d
   ```
   This starts PostgreSQL, Redis, and RabbitMQ.

4. **Run database migrations**
   ```bash
   npm run db:push    # Push schema to database (dev)
   # OR
   npm run db:migrate # Run migrations (prod)
   ```

5. **Provision the initial administrator**
   ```bash
   # Set ADMIN_EMAIL and ADMIN_PASSWORD in .env, then:
   npm run build
   npm run db:seed-admin
   ```
   The command creates the account if absent or promotes the matching existing account to `admin` without changing its password. Public registration can create only `public` accounts; administrators use the admin API to provision other roles.

5. **Start the server**
   ```bash
   npm run dev    # Development with watch mode
   # OR
   npm run start  # Production
   ```

The API will be available at http://localhost:3000

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start in development mode with watch |
| `npm run start` | Start in production mode |
| `npm run build` | Compile TypeScript |
| `npm test` | Run tests |
| `npm run lint` | Run ESLint |
| `npm run lint:fix` | Fix ESLint issues |
| `npm run format` | Format code with Prettier |
| `npm run db:generate` | Generate migration from schema changes |
| `npm run db:migrate` | Run pending migrations |
| `npm run db:seed-admin` | Create or promote the configured initial administrator |
| `npm run db:push` | Push schema directly to database |
| `npm run db:studio` | Open Drizzle Studio (DB GUI) |

## API Endpoints

### Health
- `GET /health` - Service health status
- `GET /health/live` - Liveness probe
- `GET /health/ready` - Readiness probe

See `docs/openapi.yaml` for full API specification.

## Adding New Features

Example: adding a `User` feature.

### Step 1. Database schema

```typescript
// src/db/schema/users.ts
import { pgTable, uuid, varchar, timestamp } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
    id: uuid('id').primaryKey().defaultRandom(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
```

Export from `src/db/schema/index.ts`, then run `npm run db:generate && npm run db:migrate`.

### Step 2. DTOs

```typescript
// src/types/user.ts
export interface CreateUserDto {
    email: string;
}
```

### Step 3. Repository

Interface + implementation in the same file:

```typescript
// src/repositories/user.repository.ts
import { injectable, inject } from 'inversify';
import { eq } from 'drizzle-orm';
import { TYPES } from '../constants/types';
import { users, User, NewUser } from '../db/schema/users';
// ... other imports

export interface IUserRepository {
    findById(id: string): Promise<User | undefined>;
    create(user: NewUser): Promise<User>;
}

@injectable()
export class UserRepository implements IUserRepository {
    constructor(@inject(TYPES.Database) private db: NodePgDatabase<typeof schema>) {}

    async findById(id: string): Promise<User | undefined> {
        const result = await this.db.select().from(users).where(eq(users.id, id));
        return result[0];
    }

    async create(data: NewUser): Promise<User> {
        const result = await this.db.insert(users).values(data).returning();
        return result[0];
    }
}
```

### Step 4. Service

```typescript
// src/services/user.service.ts
import { injectable, inject } from 'inversify';
import { TYPES } from '../constants/types';
import { User } from '../db/schema/users';
import { IUserRepository } from '../repositories/user.repository';
import { CreateUserDto } from '../types/user';

export interface IUserService {
    getUserById(id: string): Promise<User | null>;
    createUser(dto: CreateUserDto): Promise<User>;
}

@injectable()
export class UserService implements IUserService {
    constructor(@inject(TYPES.IUserRepository) private userRepository: IUserRepository) {}

    async getUserById(id: string) {
        return (await this.userRepository.findById(id)) ?? null;
    }

    async createUser(dto: CreateUserDto) {
        return this.userRepository.create({ email: dto.email });
    }
}
```

### Step 5. Controller

```typescript
// src/controllers/user.controller.ts
import { inject } from 'inversify';
import { controller, httpGet, httpPost } from 'inversify-express-utils';
import { Request, Response } from 'express';
import { TYPES } from '../constants/types';
import { IUserService } from '../services/user.service';

@controller('/users')
export class UserController {
    constructor(@inject(TYPES.IUserService) private userService: IUserService) {}

    @httpGet('/:id')
    async getUserById(req: Request, res: Response) {
        const user = await this.userService.getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: { message: 'User not found' } });
        return res.json({ data: user });
    }

    @httpPost('/')
    async createUser(req: Request, res: Response) {
        const user = await this.userService.createUser(req.body);
        return res.status(201).json({ data: user });
    }
}
```

### Step 6. Wire it up

Add to `src/constants/types.ts`:
```typescript
IUserRepository: Symbol.for('IUserRepository'),
IUserService: Symbol.for('IUserService'),
```

Add to `src/config/inversify.config.ts`:
```typescript
import { IUserRepository, UserRepository } from '../repositories/user.repository';
import { IUserService, UserService } from '../services/user.service';
// ...
bind<IUserRepository>(TYPES.IUserRepository).to(UserRepository).inSingletonScope();
bind<IUserService>(TYPES.IUserService).to(UserService).inSingletonScope();
```

Import controller in `src/app.ts`:
```typescript
import './controllers/user.controller';
```

Update `docs/openapi.yaml` with the new endpoints.

## Message Queue Usage

### Publishing messages
```typescript
@inject(TYPES.MessagePublisher) private publisher: MessagePublisher;

await this.publisher.publish(
    { userId: '123', action: 'created' },
    { routingKey: 'user.events' }
);
```

### Subscribing to messages
```typescript
@inject(TYPES.MessageSubscriber) private subscriber: MessageSubscriber;

await this.subscriber.subscribe(
    { queue: 'user.events' },
    async (message, ack, nack) => {
        try {
            // Process message
            ack();
        } catch (error) {
            nack(false); // Don't requeue
        }
    }
);
```

## Redis Usage

```typescript
@inject(TYPES.ICacheService) private cache: ICacheService;

// Set with TTL (default 3600 seconds)
await this.cache.set('user:123', { name: 'John', email: 'john@example.com' });

// Set with custom TTL
await this.cache.set('session:abc', { token: 'xyz' }, 1800);

// Get
const user = await this.cache.get<{ name: string; email: string }>('user:123');

// Delete
await this.cache.del('user:123');
```

## Testing

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/services/auth.service.test.ts

# Watch mode
npm run test:watch
```

## Docker

Build and run with Docker:
```bash
# Run with Docker Compose
docker compose up -d
```
