import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  maxYearOfManufacture,
  parseMedicalEquipment,
  parseRestrictions,
  parseSpecifications,
} from './aircraft-json.js';
import {
  AircraftMedicalEquipmentDto,
  AircraftRestrictionsDto,
  AircraftSpecificationsDto,
} from './dto/aircraft-json.dto.js';

const LOCATION = '5f0c6a5e-2b7d-4c1a-9a7e-0d3c2b1a0f9e';

/** The property paths the global ValidationPipe would refuse. */
async function refused(
  type: new () => object,
  plain: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(type, plain), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  const paths: string[] = [];
  const walk = (list: typeof errors, prefix: string) => {
    for (const error of list) {
      const path = prefix + error.property;
      if (error.constraints) paths.push(path);
      walk(error.children ?? [], `${path}.`);
    }
  };
  walk(errors, '');
  return paths.sort();
}

describe('aircraft JSON shapes on write', () => {
  it('accepts complete, valid shapes and empty objects', async () => {
    expect(
      await refused(AircraftRestrictionsDto, {
        operatingHours: { start: '22:00', end: '06:00' },
        excludedLocationIds: [LOCATION],
        minimumNoticeMinutes: 240,
      }),
    ).toEqual([]);
    expect(
      await refused(AircraftSpecificationsDto, {
        cabin: 'Club four,\nleather seats',
        yearOfManufacture: 2019,
        amenities: ['Wi-Fi', 'Enclosed lavatory'],
      }),
    ).toEqual([]);
    expect(
      await refused(AircraftMedicalEquipmentDto, {
        stretcher: true,
        oxygen: { litres: 3000 },
        ventilator: false,
        defibrillator: true,
        patientMonitor: true,
        incubator: false,
        infusionPumps: 2,
        notes: 'Neonatal set on request',
      }),
    ).toEqual([]);
    for (const type of [
      AircraftRestrictionsDto,
      AircraftSpecificationsDto,
      AircraftMedicalEquipmentDto,
    ]) {
      expect(await refused(type, {})).toEqual([]);
    }
  });

  it('refuses unknown keys, including nested ones, and never keep `constructor`', async () => {
    expect(await refused(AircraftSpecificationsDto, { seats: 4 })).toEqual([
      'seats',
    ]);
    expect(
      await refused(AircraftMedicalEquipmentDto, {
        oxygen: { litres: 10, pressure: 200 },
      }),
    ).toEqual(['oxygen.pressure']);
    // class-transformer drops a `constructor` key before validation, so it
    // can never be stored.
    const plain = JSON.parse('{"constructor": {"name": "x"}}') as object;
    const instance = plainToInstance(AircraftRestrictionsDto, plain);
    expect(Object.hasOwn(instance, 'constructor')).toBe(false);
    expect(JSON.stringify(instance)).toBe('{}');
  });

  it('refuses null inside a shape (leave the key out instead)', async () => {
    expect(
      await refused(AircraftRestrictionsDto, { minimumNoticeMinutes: null }),
    ).toEqual(['minimumNoticeMinutes']);
    expect(
      await refused(AircraftMedicalEquipmentDto, { oxygen: null }),
    ).toEqual(['oxygen']);
  });

  it('checks restrictions: times, distinct ends, location ids and notice bounds', async () => {
    expect(
      await refused(AircraftRestrictionsDto, {
        operatingHours: { start: '6:00', end: '24:00' },
      }),
    ).toEqual(['operatingHours.end', 'operatingHours.start']);
    expect(
      await refused(AircraftRestrictionsDto, {
        operatingHours: { start: '08:00', end: '08:00' },
      }),
    ).toEqual(['operatingHours.end']);
    expect(
      await refused(AircraftRestrictionsDto, {
        operatingHours: { start: '08:00' },
      }),
    ).toEqual(['operatingHours.end']);
    expect(
      await refused(AircraftRestrictionsDto, {
        excludedLocationIds: ['BOM', LOCATION, LOCATION],
      }),
    ).toEqual(['excludedLocationIds']);
    expect(
      await refused(AircraftRestrictionsDto, {
        excludedLocationIds: Array.from({ length: 101 }, (_, i) =>
          LOCATION.replace(/.{3}$/, String(i).padStart(3, '0')),
        ),
      }),
    ).toEqual(['excludedLocationIds']);
    for (const minutes of [-1, 10_081, 30.5, '60']) {
      expect(
        await refused(AircraftRestrictionsDto, {
          minimumNoticeMinutes: minutes,
        }),
      ).toEqual(['minimumNoticeMinutes']);
    }
    expect(
      await refused(AircraftRestrictionsDto, { operatingHours: [] }),
    ).toEqual(['operatingHours']);
  });

  it('checks specifications: text, year and amenities', async () => {
    expect(await refused(AircraftSpecificationsDto, { cabin: '   ' })).toEqual([
      'cabin',
    ]);
    expect(
      await refused(AircraftSpecificationsDto, { cabin: 'x'.repeat(501) }),
    ).toEqual(['cabin']);
    expect(
      await refused(AircraftSpecificationsDto, { cabin: 'Club ‮four' }),
    ).toEqual(['cabin']);
    expect(
      await refused(AircraftSpecificationsDto, {
        yearOfManufacture: maxYearOfManufacture() + 1,
      }),
    ).toEqual(['yearOfManufacture']);
    expect(
      await refused(AircraftSpecificationsDto, { yearOfManufacture: 1949 }),
    ).toEqual(['yearOfManufacture']);
    for (const amenities of [
      ['Wi-Fi', 'Wi-Fi'],
      ['Wi-Fi\nfast'],
      [''],
      ['x'.repeat(41)],
      [42],
      Array.from({ length: 21 }, (_, i) => `Amenity ${i}`),
      'Wi-Fi',
    ]) {
      expect(await refused(AircraftSpecificationsDto, { amenities })).toEqual([
        'amenities',
      ]);
    }
  });

  it('checks medical equipment: flags, oxygen and pump counts', async () => {
    expect(
      await refused(AircraftMedicalEquipmentDto, { stretcher: 'yes' }),
    ).toEqual(['stretcher']);
    expect(
      await refused(AircraftMedicalEquipmentDto, { oxygen: { litres: 0 } }),
    ).toEqual(['oxygen.litres']);
    expect(await refused(AircraftMedicalEquipmentDto, { oxygen: 10 })).toEqual([
      'oxygen',
    ]);
    expect(
      await refused(AircraftMedicalEquipmentDto, { infusionPumps: 11 }),
    ).toEqual(['infusionPumps']);
  });
});

describe('aircraft JSON shapes on read', () => {
  it('returns null for a missing or non-object value', () => {
    for (const raw of [null, undefined, 'text', 42, [], [{ cabin: 'x' }]]) {
      expect(parseRestrictions(raw)).toBeNull();
      expect(parseSpecifications(raw)).toBeNull();
      expect(parseMedicalEquipment(raw)).toBeNull();
    }
  });

  it('keeps an empty object, which is not the same as none', () => {
    expect(parseMedicalEquipment({})).toEqual({});
  });

  it('keeps well-formed fields and drops unknown or malformed ones', () => {
    expect(
      parseRestrictions({
        operatingHours: { start: '06:00', end: '20:00', zone: 'x' },
        excludedLocationIds: [LOCATION, 'BOM', LOCATION, 7],
        minimumNoticeMinutes: 90,
        legacy: true,
      }),
    ).toEqual({
      operatingHours: { start: '06:00', end: '20:00' },
      excludedLocationIds: [LOCATION],
      minimumNoticeMinutes: 90,
    });
    expect(
      parseRestrictions({
        operatingHours: { start: '06:00', end: '06:00' },
        minimumNoticeMinutes: -5,
      }),
    ).toEqual({});
    expect(
      parseSpecifications({
        cabin: 'Club four',
        seats: { leather: true },
        yearOfManufacture: '2019',
        amenities: ['Wi-Fi', 'Wi-Fi', '', 3, 'Galley'],
      }),
    ).toEqual({ cabin: 'Club four', amenities: ['Wi-Fi', 'Galley'] });
    expect(
      parseMedicalEquipment({
        stretcher: 'true',
        ventilator: true,
        oxygen: { litres: 10.5 },
        infusionPumps: 3,
        notes: 'Bad\u0007text',
      }),
    ).toEqual({ ventilator: true, infusionPumps: 3 });
  });
});
