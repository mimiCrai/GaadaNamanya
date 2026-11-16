import { injectable } from 'inversify';
import { UserRole } from '../types/auth';
import env from '../util/env';

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

    tryAcquire(role: UserRole): AdmissionPermit | null {
        const shared = role !== 'lapangan';
        if (this.active >= this.maxActive || (shared && this.sharedActive >= this.sharedLimit)) return null;

        this.active++;
        if (shared) this.sharedActive++;
        let released = false;
        return {
            release: () => {
                if (released) return;
                released = true;
                this.active--;
                if (shared) this.sharedActive--;
            },
        };
    }
}
