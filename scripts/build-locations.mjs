// Builds prisma/data/locations-in.json, the location reference data that
// `npm run db:seed` loads, from OurAirports (https://ourairports.com/data/,
// public domain). Run it only to refresh the data; the output is committed.
//
//   node scripts/build-locations.mjs                  # downloads the CSVs
//   node scripts/build-locations.mjs <airports.csv> <runways.csv>
//
// Selection (decision D-046, India only):
// - Airports: every large and medium airport, plus small airports with
//   scheduled service, plus EXTRA_AIRPORTS. Military airfields without
//   scheduled service are left out; nobody can charter into them.
// - Heliports: the public and tourist heliports in HELIPORTS. Most of the
//   310 Indian heliports in OurAirports are military, factory, campus or
//   private pads, so they are picked by hand rather than by filter.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SOURCE = 'https://github.com/davidmegginson/ourairports-data';
const RAW = 'https://raw.githubusercontent.com/davidmegginson/ourairports-data/main';
const OUTPUT = path.resolve(
  import.meta.dirname,
  '../prisma/data/locations-in.json',
);

/** Juhu: Mumbai's helicopter and general aviation aerodrome. */
const EXTRA_AIRPORTS = ['VAJJ'];

const HELIPORTS = [
  'IN-0004', // Leh
  'IN-0007', // Minicoy
  'IN-0008', // Kavaratti
  'IN-0009', // Gangtok
  'IN-0036', // Pelling
  'IN-0047', // Mahalaxmi Race Course, Mumbai
  'IN-0049', // Kohima
  'IN-0075', // Itanagar (Naharlagun)
  'IN-0081', // Annadale, Shimla
  'IN-0108', // Digha
  'IN-0110', // Puri
  'IN-0158', // Kadmat
  'IN-0160', // Bangaram
  'IN-0209', // Rohini, Delhi
  'IN-0246', // Pushkar
  'IN-0267', // Sabarimala Nilakkal
  'IN-0285', // Diglipur
  'IN-0286', // Mayabunder
  'IN-0287', // Rangat
  'IN-0288', // Havelock
  'IN-0289', // Neil Island
  'IN-0292', // Hut Bay
  'IN-0303', // Kargil
  'IN-0309', // HeliTaxii, Bengaluru
  'IN-0326', // Kalpa
  'IN-0384', // Sonamarg
  'IN-0386', // Pahalgam
  'IN-0403', // Sahastradhara, Dehradun
];

const MILITARY =
  /air force|\bAFS\b|army|naval|navy|\bINS\b|\bBSF\b|military|academy|air base/i;

/** OurAirports region codes, some of which predate ISO 3166-2:IN changes. */
const STATES = {
  'IN-AN': 'Andaman and Nicobar Islands',
  'IN-AP': 'Andhra Pradesh',
  'IN-AR': 'Arunachal Pradesh',
  'IN-AS': 'Assam',
  'IN-BR': 'Bihar',
  'IN-CH': 'Chandigarh',
  'IN-CT': 'Chhattisgarh',
  'IN-DH': 'Dadra and Nagar Haveli and Daman and Diu',
  'IN-DL': 'Delhi',
  'IN-GA': 'Goa',
  'IN-GJ': 'Gujarat',
  'IN-HP': 'Himachal Pradesh',
  'IN-HR': 'Haryana',
  'IN-JH': 'Jharkhand',
  'IN-JK': 'Jammu and Kashmir',
  'IN-KA': 'Karnataka',
  'IN-KL': 'Kerala',
  'IN-LA': 'Ladakh',
  'IN-LD': 'Lakshadweep',
  'IN-ML': 'Meghalaya',
  'IN-MM': 'Maharashtra',
  'IN-MH': 'Maharashtra',
  'IN-MN': 'Manipur',
  'IN-MP': 'Madhya Pradesh',
  'IN-MZ': 'Mizoram',
  'IN-NL': 'Nagaland',
  'IN-OR': 'Odisha',
  'IN-PB': 'Punjab',
  'IN-PY': 'Puducherry',
  'IN-RJ': 'Rajasthan',
  'IN-SK': 'Sikkim',
  'IN-TG': 'Telangana',
  'IN-TN': 'Tamil Nadu',
  'IN-TR': 'Tripura',
  'IN-UP': 'Uttar Pradesh',
  'IN-UT': 'Uttarakhand',
  'IN-WB': 'West Bengal',
};

/** RFC 4180 CSV, as OurAirports publishes it. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) rows.push([...row, field]);
  const [header, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(header.map((name, i) => [name, values[i] ?? ''])),
  );
}

async function load(file, name) {
  if (file) return readFile(file, 'utf8');
  const response = await fetch(`${RAW}/${name}`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  return response.text();
}

const [airportsFile, runwaysFile] = process.argv.slice(2);
const airports = parseCsv(await load(airportsFile, 'airports.csv')).filter(
  (row) => row.iso_country === 'IN',
);
const runways = parseCsv(await load(runwaysFile, 'runways.csv'));

const runwaysByAirport = new Map();
for (const runway of runways) {
  if (runway.closed === '1') continue;
  const list = runwaysByAirport.get(runway.airport_ident) ?? [];
  list.push(runway);
  runwaysByAirport.set(runway.airport_ident, list);
}

function isAirport(row) {
  if (EXTRA_AIRPORTS.includes(row.ident)) return true;
  const scheduled = row.scheduled_service === 'yes';
  if (MILITARY.test(row.name) && !scheduled) return false;
  return (
    row.type === 'large_airport' ||
    row.type === 'medium_airport' ||
    (row.type === 'small_airport' && scheduled)
  );
}

/** Where OurAirports has no municipality and the name is not the town. */
const CITIES = { 'IN-0015': 'Tura' };

function city(row) {
  return (
    row.municipality.trim() ||
    CITIES[row.ident] ||
    row.name.replace(/\s+(Airport|Heliport|Helipad)$/, '').trim()
  );
}

function icao(row) {
  const code = row.icao_code || row.gps_code;
  return /^V[A-Z]{3}$/.test(code) ? code : null;
}

function toLocation(row, type) {
  const pads = runwaysByAirport.get(row.ident) ?? [];
  const longest = Math.max(0, ...pads.map((pad) => Number(pad.length_ft) || 0));
  const state = STATES[row.iso_region];
  if (!state) throw new Error(`Unknown region ${row.iso_region} (${row.ident})`);
  return {
    externalRef: `ourairports:${row.ident}`,
    type,
    name: row.name.trim(),
    iata: row.iata_code || null,
    icao: icao(row),
    city: city(row),
    state,
    country: 'IN',
    latitude: Number(Number(row.latitude_deg).toFixed(6)),
    longitude: Number(Number(row.longitude_deg).toFixed(6)),
    timeZone: 'Asia/Kolkata',
    capabilities: {
      runwayLengthM:
        type === 'AIRPORT' && longest > 0 ? Math.round(longest * 0.3048) : null,
      // OurAirports leaves the lighting flag unset for many airports that do
      // operate at night, so an unset flag means unknown, not no.
      nightOperations: pads.some((pad) => pad.lighted === '1') ? true : null,
      helicopterApproved: true,
    },
  };
}

const selected = [
  ...airports.filter(isAirport).map((row) => toLocation(row, 'AIRPORT')),
  ...HELIPORTS.map((ident) => {
    const row = airports.find((candidate) => candidate.ident === ident);
    if (!row) throw new Error(`Heliport ${ident} is no longer in OurAirports`);
    return toLocation(row, 'HELIPORT');
  }),
].sort(
  (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name),
);

await writeFile(
  OUTPUT,
  `${JSON.stringify(
    {
      source: SOURCE,
      licence: 'Public domain',
      retrievedAt: new Date().toISOString().slice(0, 10),
      locations: selected,
    },
    null,
    2,
  )}\n`,
);
const counts = selected.reduce(
  (total, location) => ({
    ...total,
    [location.type]: (total[location.type] ?? 0) + 1,
  }),
  {},
);
console.log(`Wrote ${selected.length} locations`, counts);
