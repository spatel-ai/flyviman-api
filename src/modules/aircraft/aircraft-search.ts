import {
  AircraftAvailabilityStatus,
  AircraftListingStatus,
  OperatorStatus,
} from '../../generated/prisma/enums.js';

/**
 * Why an aircraft would not be offered in search (M3 step 8; search itself
 * arrives in M5 and must apply the same rules). Empty means searchable. The
 * codes after the status checks are `missing()`'s: `homeBaseId`, `rangeKm`
 * and `document:<TYPE>` for a required document that is absent, rejected or
 * expired, so an expired insurance takes the aircraft out of search the day
 * it lapses.
 */
export function searchBlockers(input: {
  listingStatus: AircraftListingStatus;
  availabilityStatus: AircraftAvailabilityStatus;
  operatorStatus: OperatorStatus;
  missing: string[];
}): string[] {
  return [
    ...(input.listingStatus === AircraftListingStatus.APPROVED
      ? []
      : ['listingNotApproved']),
    ...(input.operatorStatus === OperatorStatus.APPROVED
      ? []
      : ['operatorNotApproved']),
    ...(input.availabilityStatus === AircraftAvailabilityStatus.AVAILABLE
      ? []
      : ['notAvailable']),
    ...input.missing,
  ];
}
