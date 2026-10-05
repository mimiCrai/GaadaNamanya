export interface SeismicRegion {
    name: string;
    lat: number;
    lon: number;
    spread: number;
    isSea: boolean;
    affectedZones: string[];
}

export const SEISMIC_REGIONS: readonly SeismicRegion[] = [
    {
        name: 'Samudra Hindia Barat Daya Kepulauan Mentawai',
        lat: -2.8,
        lon: 99.4,
        spread: 0.5,
        isSea: true,
        affectedZones: ['Kepulauan Mentawai', 'Kota Padang', 'Kabupaten Pesisir Selatan', 'Kota Bengkulu'],
    },
    {
        name: 'Samudra Hindia Selatan Jawa Barat',
        lat: -8.3,
        lon: 107.2,
        spread: 0.5,
        isSea: true,
        affectedZones: ['Kabupaten Garut', 'Kabupaten Sukabumi', 'Kabupaten Cianjur', 'Kabupaten Pangandaran'],
    },
    {
        name: 'Samudra Hindia Selatan Jawa Timur',
        lat: -9.1,
        lon: 112.5,
        spread: 0.5,
        isSea: true,
        affectedZones: ['Kabupaten Malang', 'Kabupaten Blitar', 'Kabupaten Jember', 'Kabupaten Banyuwangi'],
    },
    {
        name: 'Selat Sunda',
        lat: -6.4,
        lon: 105.3,
        spread: 0.3,
        isSea: true,
        affectedZones: ['Kabupaten Pandeglang', 'Kabupaten Serang', 'Kabupaten Lampung Selatan', 'Kota Cilegon'],
    },
    {
        name: 'Samudra Hindia Barat Aceh',
        lat: 3.6,
        lon: 95.6,
        spread: 0.4,
        isSea: true,
        affectedZones: ['Kabupaten Aceh Barat', 'Kabupaten Simeulue', 'Kota Banda Aceh', 'Kabupaten Nagan Raya'],
    },
    {
        name: 'Laut Banda',
        lat: -6.6,
        lon: 129.3,
        spread: 0.8,
        isSea: true,
        affectedZones: ['Kabupaten Maluku Tengah', 'Kabupaten Maluku Barat Daya', 'Kota Ambon'],
    },
    {
        name: 'Laut Maluku',
        lat: 1.4,
        lon: 126.4,
        spread: 0.5,
        isSea: true,
        affectedZones: ['Kota Bitung', 'Kabupaten Halmahera Barat', 'Kota Ternate', 'Kabupaten Minahasa Utara'],
    },
    {
        name: 'Laut Flores',
        lat: -7.6,
        lon: 121.5,
        spread: 0.6,
        isSea: true,
        affectedZones: ['Kabupaten Flores Timur', 'Kabupaten Sikka', 'Kabupaten Kepulauan Selayar'],
    },
    {
        name: 'Laut Sulawesi',
        lat: 2.6,
        lon: 122.1,
        spread: 0.6,
        isSea: true,
        affectedZones: ['Kabupaten Tolitoli', 'Kabupaten Buol', 'Kabupaten Gorontalo Utara'],
    },
    {
        name: 'Utara Papua (Samudra Pasifik)',
        lat: -1.0,
        lon: 137.5,
        spread: 0.6,
        isSea: true,
        affectedZones: ['Kabupaten Biak Numfor', 'Kabupaten Kepulauan Yapen', 'Kabupaten Sarmi'],
    },
    { name: 'Kabupaten Cianjur, Jawa Barat', lat: -6.85, lon: 107.1, spread: 0.15, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Pidie Jaya, Aceh', lat: 5.15, lon: 96.2, spread: 0.12, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Lombok Utara, NTB', lat: -8.35, lon: 116.3, spread: 0.1, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Mamasa, Sulawesi Barat', lat: -2.95, lon: 119.3, spread: 0.15, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Sigi, Sulawesi Tengah', lat: -1.35, lon: 119.95, spread: 0.15, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Jayapura, Papua', lat: -2.6, lon: 140.3, spread: 0.15, isSea: false, affectedZones: [] },
    { name: 'Kabupaten Bantul, DI Yogyakarta', lat: -7.95, lon: 110.35, spread: 0.08, isSea: false, affectedZones: [] },
];

export const SEA_REGIONS = SEISMIC_REGIONS.filter((region) => region.isSea);
export const LAND_REGIONS = SEISMIC_REGIONS.filter((region) => !region.isSea);

export function findRegion(name: string): SeismicRegion {
    const region = SEISMIC_REGIONS.find((candidate) => candidate.name === name);
    if (!region) {
        throw new Error(`Unknown seismic region: ${name}`);
    }
    return region;
}
