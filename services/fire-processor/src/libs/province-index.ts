import provincesFile from '../data/provinces.json';
import { Province } from '../types/fire';
import { compareText } from '../util/format';
import { haversineKm } from './geo';

export class ProvinceIndex {
    private readonly provinces: Province[];

    constructor(provinces: readonly Province[]) {
        if (provinces.length === 0) throw new Error('province table is empty');
        this.provinces = [...provinces].sort((a, b) => compareText(a.name, b.name));
    }

    nearest(latitude: number, longitude: number): string {
        let best = this.provinces[0];
        let bestKm = Infinity;
        for (const province of this.provinces) {
            const km = haversineKm(latitude, longitude, province.latitude, province.longitude);
            if (km < bestKm) {
                best = province;
                bestKm = km;
            }
        }
        return best.name;
    }
}

let defaultIndex: ProvinceIndex | undefined;

export const defaultProvinces = (): ProvinceIndex => (defaultIndex ??= new ProvinceIndex(provincesFile.provinces));
