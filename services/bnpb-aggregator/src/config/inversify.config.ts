import { AsyncContainerModule, interfaces } from 'inversify';
import { db } from '../db';
import { TYPES } from '../constants/types';

import { HazardEventRepository, IHazardEventRepository } from '../repositories/hazard-event.repository';
import { ISourceSyncStateRepository, SourceSyncStateRepository } from '../repositories/source-sync-state.repository';
import { IOutboxEventRepository, OutboxEventRepository } from '../repositories/outbox-event.repository';
import {
    IPendingTsunamiWarningRepository,
    PendingTsunamiWarningRepository,
} from '../repositories/pending-tsunami-warning.repository';

import { HealthService, IHealthService } from '../services/health.service';
import { HazardEventService, IHazardEventService } from '../services/hazard-event.service';
import { ISourceSyncStateService, SourceSyncStateService } from '../services/source-sync-state.service';
import { IMessagePublisher, MessagePublisher } from '../services/message-publisher.service';
import { HazardEventIngestionService, IHazardEventIngestionService } from '../services/hazard-event-ingestion.service';
import { IOutboxRelayService, OutboxRelayService } from '../services/outbox-relay.service';
import { IPollingService, PollingService } from '../services/polling.service';

import { BmkgClient, IBmkgClient } from '../clients/bmkg.client';
import { IPvmbgClient, PvmbgClient } from '../clients/pvmbg.client';
import { InternalAuthMiddleware } from '../middlewares/internal-auth.middleware';
import { AuditAuthMiddleware } from '../middlewares/audit-auth.middleware';
import { CanonicalReadRepository, ICanonicalReadRepository } from '../repositories/canonical-read.repository';
import { CanonicalQueryService, ICanonicalQueryService } from '../services/canonical-query.service';
import { StorageTopologyService, IStorageTopologyService } from '../services/storage-topology.service';
import { BackgroundLeaseRepository, IBackgroundLeaseRepository } from '../repositories/background-lease.repository';
import { BackgroundLeadershipService, IBackgroundLeadershipService } from '../services/background-leadership.service';

export const bindings = new AsyncContainerModule(async (bind: interfaces.Bind) => {
    bind(TYPES.Database).toConstantValue(db);
    bind<IBackgroundLeaseRepository>(TYPES.IBackgroundLeaseRepository).to(BackgroundLeaseRepository).inSingletonScope();
    bind<IBackgroundLeadershipService>(TYPES.IBackgroundLeadershipService)
        .to(BackgroundLeadershipService)
        .inSingletonScope();
    bind<IStorageTopologyService>(TYPES.IStorageTopologyService).to(StorageTopologyService).inSingletonScope();
    bind<ICanonicalReadRepository>(TYPES.ICanonicalReadRepository).to(CanonicalReadRepository).inSingletonScope();
    bind<ICanonicalQueryService>(TYPES.ICanonicalQueryService).to(CanonicalQueryService).inSingletonScope();
    bind<AuditAuthMiddleware>(TYPES.AuditAuthMiddleware).to(AuditAuthMiddleware);

    bind<IHazardEventRepository>(TYPES.IHazardEventRepository).to(HazardEventRepository).inSingletonScope();
    bind<ISourceSyncStateRepository>(TYPES.ISourceSyncStateRepository).to(SourceSyncStateRepository).inSingletonScope();
    bind<IOutboxEventRepository>(TYPES.IOutboxEventRepository).to(OutboxEventRepository).inSingletonScope();
    bind<IPendingTsunamiWarningRepository>(TYPES.IPendingTsunamiWarningRepository)
        .to(PendingTsunamiWarningRepository)
        .inSingletonScope();

    bind<IHealthService>(TYPES.IHealthService).to(HealthService).inSingletonScope();
    bind<IHazardEventService>(TYPES.IHazardEventService).to(HazardEventService).inSingletonScope();
    bind<ISourceSyncStateService>(TYPES.ISourceSyncStateService).to(SourceSyncStateService).inSingletonScope();
    bind<IHazardEventIngestionService>(TYPES.IHazardEventIngestionService)
        .to(HazardEventIngestionService)
        .inSingletonScope();
    bind<IPollingService>(TYPES.IPollingService).to(PollingService).inSingletonScope();
    bind<IOutboxRelayService>(TYPES.IOutboxRelayService).to(OutboxRelayService).inSingletonScope();

    bind<IBmkgClient>(TYPES.IBmkgClient).to(BmkgClient).inSingletonScope();
    bind<IPvmbgClient>(TYPES.IPvmbgClient).to(PvmbgClient).inSingletonScope();

    bind<IMessagePublisher>(TYPES.IMessagePublisher).to(MessagePublisher).inSingletonScope();

    bind<InternalAuthMiddleware>(TYPES.InternalAuthMiddleware).to(InternalAuthMiddleware);
});
