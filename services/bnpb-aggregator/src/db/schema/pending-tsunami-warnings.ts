import { TsunamiWarning } from '../../clients/source-client.types';

export const pendingTsunamiWarnings = 'pending_tsunami_warnings';

export interface PendingTsunamiWarning {
    warningId: string;
    relatedEventId: string;
    warning: TsunamiWarning;
    firstReceivedAt: Date;
    updatedAt: Date;
}
