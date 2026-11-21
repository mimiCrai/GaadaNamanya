#!/usr/bin/env node
// Usage: node scripts/satellite/build-provinces.mjs <adm1.geojson> <adm2.geojson> > services/fire-processor/src/data/provinces.json
import { readFileSync } from 'node:fs';

const [adm1Path, adm2Path] = process.argv.slice(2);
if (!adm1Path || !adm2Path) {
    console.error('usage: build-provinces.mjs <geoBoundaries-IDN-ADM1.geojson> <geoBoundaries-IDN-ADM2.geojson>');
    process.exit(2);
}

const ADM1_NAMES = {
    Aceh: 'Aceh',
    'North Sumatra': 'Sumatera Utara',
    'West Sumatra': 'Sumatera Barat',
    Riau: 'Riau',
    Jambi: 'Jambi',
    'South Sumatra': 'Sumatera Selatan',
    Bengkulu: 'Bengkulu',
    Lampung: 'Lampung',
    'Bangka-Belitung Islands': 'Kepulauan Bangka Belitung',
    'Riau Islands': 'Kepulauan Riau',
    'Jakarta Special Capital Region': 'DKI Jakarta',
    'West Java': 'Jawa Barat',
    'Central Java': 'Jawa Tengah',
    'Special Region of Yogyakarta': 'DI Yogyakarta',
    'East Java': 'Jawa Timur',
    Banten: 'Banten',
    Bali: 'Bali',
    'West Nusa Tenggara': 'Nusa Tenggara Barat',
    'East Nusa Tenggara': 'Nusa Tenggara Timur',
    'West Kalimantan': 'Kalimantan Barat',
    'Central Kalimantan': 'Kalimantan Tengah',
    'South Kalimantan': 'Kalimantan Selatan',
    'East Kalimantan': 'Kalimantan Timur',
    'North Kalimantan': 'Kalimantan Utara',
    'North Sulawesi': 'Sulawesi Utara',
    'Central Sulawesi': 'Sulawesi Tengah',
    'South Sulawesi': 'Sulawesi Selatan',
    'Southeast Sulawesi': 'Sulawesi Tenggara',
    Gorontalo: 'Gorontalo',
    'West Sulawesi': 'Sulawesi Barat',
    Maluku: 'Maluku',
    'North Maluku': 'Maluku Utara',
};

// UU 14, 15, 16/2022 (Papua Selatan, Papua Tengah, Papua Pegunungan) dan UU 29/2022 (Papua Barat Daya).
const PAPUA_REGENCIES = {
    Papua: ['Jayapura', 'Kota Jayapura', 'Keerom', 'Sarmi', 'Mamberamo Raya', 'Biak Numfor', 'Supiori', 'Kepulauan Yapen', 'Waropen'],
    'Papua Selatan': ['Merauke', 'Boven Digoel', 'Mappi', 'Asmat'],
    'Papua Tengah': ['Nabire', 'Paniai', 'Mimika', 'Puncak Jaya', 'Puncak', 'Dogiyai', 'Intan Jaya', 'Deiyai'],
    'Papua Pegunungan': ['Jayawijaya', 'Lanny Jaya', 'Mamberamo Tengah', 'Nduga', 'Pegunungan Bintang', 'Tolikara', 'Yahukimo', 'Yalimo'],
    'Papua Barat': ['Manokwari', 'Manokwari Selatan', 'Pegunungan Arfak', 'Teluk Bintuni', 'Teluk Wondama', 'Fakfak', 'Kaimana'],
    'Papua Barat Daya': ['Sorong', 'Kota Sorong', 'Sorong Selatan', 'Raja Ampat', 'Tambrauw', 'Maybrat'],
};

function polygonsOf(geometry) {
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    throw new Error(`unsupported geometry ${geometry.type}`);
}

function accumulate(acc, geometry) {
    for (const polygon of polygonsOf(geometry)) {
        for (const ring of polygon) {
            for (let i = 0; i < ring.length - 1; i++) {
                const [x0, y0] = ring[i];
                const [x1, y1] = ring[i + 1];
                const cross = x0 * y1 - x1 * y0;
                acc.a += cross;
                acc.x += (x0 + x1) * cross;
                acc.y += (y0 + y1) * cross;
            }
        }
    }
}

function centroid(geometries) {
    const acc = { a: 0, x: 0, y: 0 };
    for (const geometry of geometries) accumulate(acc, geometry);
    const area = acc.a / 2;
    return { longitude: round5(acc.x / (6 * area)), latitude: round5(acc.y / (6 * area)) };
}

const round5 = (value) => Number(value.toFixed(5));

const adm1 = JSON.parse(readFileSync(adm1Path, 'utf8'));
const adm2 = JSON.parse(readFileSync(adm2Path, 'utf8'));
const provinces = [];

for (const feature of adm1.features) {
    const english = feature.properties.shapeName;
    if (english === 'Papua' || english === 'West Papua') continue;
    const name = ADM1_NAMES[english];
    if (!name) throw new Error(`ADM1 tanpa pemetaan nama: ${english}`);
    provinces.push({ name, ...centroid([feature.geometry]) });
}

const byName = new Map();
for (const feature of adm2.features) {
    const list = byName.get(feature.properties.shapeName) ?? [];
    list.push(feature);
    byName.set(feature.properties.shapeName, list);
}
for (const [name, regencies] of Object.entries(PAPUA_REGENCIES)) {
    const geometries = regencies.map((regency) => {
        const matches = byName.get(regency) ?? [];
        if (matches.length !== 1) throw new Error(`ADM2 '${regency}' ditemukan ${matches.length}×`);
        return matches[0].geometry;
    });
    provinces.push({ name, ...centroid(geometries) });
}

provinces.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (provinces.length !== 38) throw new Error(`jumlah provinsi ${provinces.length}, seharusnya 38`);

const output = {
    description:
        'Titik pusat (centroid area, rumus shoelace pada koordinat lon/lat WGS84) 38 provinsi Indonesia untuk area_name HazardEvent WILDFIRE.',
    sources: [
        {
            dataset: 'geoBoundaries gbOpen IDN ADM1 (34 provinsi, sebelum pemekaran Papua 2022)',
            url: 'https://www.geoboundaries.org/api/current/gbOpen/IDN/ADM1/',
            upstream: 'OpenStreetMap, Wambacher (2017)',
            license: 'ODbL 1.0',
            used_for: '32 provinsi selain Papua dan Papua Barat',
        },
        {
            dataset: 'geoBoundaries gbOpen IDN ADM2 (519 kabupaten/kota)',
            url: 'https://www.geoboundaries.org/api/current/gbOpen/IDN/ADM2/',
            upstream: 'BPS, World Food Programme, OCHA ROAP (2020)',
            license: 'CC BY 3.0 IGO',
            used_for:
                'Papua, Papua Barat, Papua Selatan, Papua Tengah, Papua Pegunungan, Papua Barat Daya (gabungan kabupaten sesuai UU 14, 15, 16, 29 Tahun 2022)',
        },
    ],
    generator: 'scripts/satellite/build-provinces.mjs',
    papua_regencies: PAPUA_REGENCIES,
    provinces,
};
process.stdout.write(`${JSON.stringify(output, null, 4)}\n`);
