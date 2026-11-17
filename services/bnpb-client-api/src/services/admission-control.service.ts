import { injectable } from 'inversify';
import { UserRole } from '../types/auth';
import env from '../util/env';
import { admissionActive, admissionLimit, admissionRejected } from '../telemetry/admission-metrics';

export interface AdmissionPermit {
    release(): void;
}

export interface IAdmissionControlService {
    tryAcquire(role: UserRole): AdmissionPermit | null;
}

@injectable()
export class AdmissionControlService implements IAdmissionControlService {
    private active = 0;
    private sharedActive = 0;
    private readonly maxActive = env.ADMISSION_MAX_CONCURRENT_REQUESTS;
    private readonly sharedLimit = this.maxActive - env.ADMISSION_RESERVED_LAPANGAN_REQUESTS;

    constructor() {
        admissionLimit.set({ pool: 'total' }, this.maxActive);
        admissionLimit.set({ pool: 'shared' }, this.sharedLimit);
        admissionLimit.set({ pool: 'reserved' }, env.ADMISSION_RESERVED_LAPANGAN_REQUESTS);
    }

    tryAcquire(role: UserRole): AdmissionPermit | null {
        const shared = role !== 'lapangan';
        if (this.active >= this.maxActive || (shared && this.sharedActive >= this.sharedLimit)) {
            admissionRejected.inc({ role });
            return null;
        }

        this.active++;
        if (shared) this.sharedActive++;
        admissionActive.inc({ pool: 'total' });
        admissionActive.inc({ pool: shared ? 'shared' : 'lapangan' });
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                this.active--;
                if (shared) this.sharedActive--;
                admissionActive.dec({ pool: 'total' });
                admissionActive.dec({ pool: shared ? 'shared' : 'lapangan' });
            },
        };
    }
}
