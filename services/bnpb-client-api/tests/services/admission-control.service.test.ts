import { AdmissionControlService } from '../../src/services/admission-control.service';
import env from '../../src/util/env';

describe('AdmissionControlService', () => {
    let service: AdmissionControlService;

    beforeEach(() => {
        jest.replaceProperty(env, 'ADMISSION_MAX_CONCURRENT_REQUESTS', 3);
        jest.replaceProperty(env, 'ADMISSION_RESERVED_LAPANGAN_REQUESTS', 1);
        service = new AdmissionControlService();
    });

    afterEach(() => jest.restoreAllMocks());

    it('reserves capacity for Lapangan when public and internal traffic fill the shared allowance', () => {
        expect(service.tryAcquire('public')).not.toBeNull();
        expect(service.tryAcquire('internal')).not.toBeNull();
        expect(service.tryAcquire('public')).toBeNull();
        expect(service.tryAcquire('internal')).toBeNull();
        expect(service.tryAcquire('lapangan')).not.toBeNull();
        expect(service.tryAcquire('lapangan')).toBeNull();
    });

    it('lets Lapangan use the whole capacity, including unused shared slots', () => {
        for (let i = 0; i < 3; i++) expect(service.tryAcquire('lapangan')).not.toBeNull();
        expect(service.tryAcquire('public')).toBeNull();
        expect(service.tryAcquire('lapangan')).toBeNull();
    });

    it('does not leak capacity when acquisition is rejected repeatedly', () => {
        const first = service.tryAcquire('public');
        service.tryAcquire('public');
        for (let i = 0; i < 20; i++) expect(service.tryAcquire('public')).toBeNull();
        first!.release();
        expect(service.tryAcquire('public')).not.toBeNull();
        expect(service.tryAcquire('public')).toBeNull();
        expect(service.tryAcquire('lapangan')).not.toBeNull();
    });

    it('releases each permit at most once without opening extra capacity', () => {
        const first = service.tryAcquire('public');
        service.tryAcquire('public');
        service.tryAcquire('lapangan');
        first!.release();
        first!.release();
        expect(service.tryAcquire('public')).not.toBeNull();
        expect(service.tryAcquire('lapangan')).toBeNull();
    });

    it('keeps shared capacity reserved while only a Lapangan slot is released', () => {
        service.tryAcquire('public');
        service.tryAcquire('internal');
        const field = service.tryAcquire('lapangan');
        field!.release();
        expect(service.tryAcquire('public')).toBeNull();
        expect(service.tryAcquire('lapangan')).not.toBeNull();
    });

    it('enforces the limit during a burst with no awaits between acquisition attempts', () => {
        const permits = Array.from({ length: 1000 }, () => service.tryAcquire('public'));
        expect(permits.filter(Boolean)).toHaveLength(2);
        expect(service.tryAcquire('lapangan')).not.toBeNull();
    });
});
