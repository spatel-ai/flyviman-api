import { PriceType } from '../../generated/prisma/enums.js';
import {
  missingFeasibility,
  parseChecklist,
} from './air-ambulance-transitions.js';
import type {
  AirAmbulanceActor,
  AirAmbulanceRequestView,
  AirAmbulanceService,
} from './air-ambulance.service.js';
import type {
  AdminAirAmbulanceRequestDto,
  AdminAirAmbulanceSummaryDto,
} from './dto/admin-air-ambulance.dto.js';
import {
  type AirAmbulanceQuotePriceDto,
  type AirAmbulanceRequestDto,
  type AirAmbulanceSummaryDto,
  EMERGENCY_NOTICE,
} from './dto/air-ambulance.dto.js';
import type {
  OperatorAirAmbulanceRequestDto,
  OperatorAirAmbulanceSummaryDto,
} from './dto/operator-air-ambulance.dto.js';

/** Response DTOs from service views. Medical data only through `findOne`. */

function price(
  view: AirAmbulanceRequestView,
): AirAmbulanceQuotePriceDto | null {
  return view.quote
    ? {
        priceType: PriceType.QUOTE,
        amountMinor: view.quote.amountMinor,
        currency: view.quote.currency,
      }
    : null;
}

export async function summaries(
  service: AirAmbulanceService,
  views: AirAmbulanceRequestView[],
): Promise<AirAmbulanceSummaryDto[]> {
  const names = await service.locationNames(
    views.flatMap((v) => [v.originLocationId, v.destinationLocationId]),
  );
  return views.map((view) => ({
    reference: view.reference,
    status: view.status,
    originName: names.get(view.originLocationId) ?? null,
    destinationName: names.get(view.destinationLocationId) ?? null,
    preferredAt: view.preferredAt.toISOString(),
    price: price(view),
    createdAt: view.createdAt.toISOString(),
    emergencyNotice: EMERGENCY_NOTICE,
  }));
}

export async function adminSummaries(
  service: AirAmbulanceService,
  views: AirAmbulanceRequestView[],
): Promise<AdminAirAmbulanceSummaryDto[]> {
  const names = await service.locationNames(
    views.flatMap((v) => [v.originLocationId, v.destinationLocationId]),
  );
  return views.map((view) => ({
    reference: view.reference,
    status: view.status,
    originName: names.get(view.originLocationId) ?? null,
    destinationName: names.get(view.destinationLocationId) ?? null,
    preferredAt: view.preferredAt.toISOString(),
    patientCount: view.patientCount,
    assignedToId: view.assignedToId,
    price: price(view),
    createdAt: view.createdAt.toISOString(),
  }));
}

export async function operatorSummaries(
  service: AirAmbulanceService,
  views: AirAmbulanceRequestView[],
): Promise<OperatorAirAmbulanceSummaryDto[]> {
  const names = await service.locationNames(
    views.flatMap((v) => [v.originLocationId, v.destinationLocationId]),
  );
  return views.map((view) => ({
    reference: view.reference,
    status: view.status,
    originName: names.get(view.originLocationId) ?? null,
    destinationName: names.get(view.destinationLocationId) ?? null,
    preferredAt: view.preferredAt.toISOString(),
    patientCount: view.patientCount,
    createdAt: view.createdAt.toISOString(),
  }));
}

/**
 * One mission for the selected operator's administrator: `findOne` decides
 * (404 before acceptance, to other operators and to a suspended one) and
 * audits the medical read. Contacts and the quotation stay out.
 */
export async function operatorDetail(
  service: AirAmbulanceService,
  reference: string,
  actor: AirAmbulanceActor,
): Promise<OperatorAirAmbulanceRequestDto> {
  const { customer, view } = await build(service, reference, actor);
  return {
    reference: customer.reference,
    status: customer.status,
    originName: customer.originName,
    destinationName: customer.destinationName,
    preferredAt: customer.preferredAt,
    patientCount: customer.patientCount,
    createdAt: customer.createdAt,
    pickupAddress: customer.pickupAddress,
    destinationFacility: customer.destinationFacility,
    accompanyingPersons: view.accompanyingPersons,
    confirmedAt: customer.confirmedAt,
    completedAt: customer.completedAt,
    medical: customer.medical,
    timeline: customer.timeline,
    emergencyNotice: EMERGENCY_NOTICE,
  };
}

/**
 * One request for its requester (or, with `admin`, for operations): the
 * medical details only when `findOne` allows them, and that read audited.
 */
export async function detail(
  service: AirAmbulanceService,
  reference: string,
  actor: AirAmbulanceActor,
): Promise<AirAmbulanceRequestDto> {
  return (await build(service, reference, actor)).customer;
}

export async function adminDetail(
  service: AirAmbulanceService,
  reference: string,
  actor: AirAmbulanceActor,
): Promise<AdminAirAmbulanceRequestDto> {
  const { customer, view, events } = await build(service, reference, actor);
  const checklist = parseChecklist({
    checklist: await service.feasibilityOf(view.id),
  });
  return {
    ...customer,
    assignedToId: view.assignedToId,
    selectedOperatorId: view.selectedOperatorId,
    feasibility: checklist
      ? { ...checklist, complete: missingFeasibility(checklist).length === 0 }
      : null,
    events: events.map((event) => ({
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorId: event.actorId,
      actorRole: event.actorRole,
      payload:
        typeof event.payload === 'object' && event.payload !== null
          ? (event.payload as Record<string, unknown>)
          : null,
      at: event.createdAt.toISOString(),
    })),
  };
}

async function build(
  service: AirAmbulanceService,
  reference: string,
  actor: AirAmbulanceActor,
) {
  const view = await service.findOne(reference, actor);
  const [names, operatorName, events, documents] = await Promise.all([
    service.locationNames([view.originLocationId, view.destinationLocationId]),
    service.operatorName(view.selectedOperatorId),
    service.timeline(view.id),
    view.medical
      ? service.documentInfo(view.medical.documentFileIds)
      : Promise.resolve([]),
  ]);
  const customer: AirAmbulanceRequestDto = {
    reference: view.reference,
    status: view.status,
    contactName: view.contactName,
    contactPhone: view.contactPhone,
    contactEmail: view.contactEmail,
    emergencyContactName: view.emergencyContactName,
    emergencyContactPhone: view.emergencyContactPhone,
    originLocationId: view.originLocationId,
    originName: names.get(view.originLocationId) ?? null,
    destinationLocationId: view.destinationLocationId,
    destinationName: names.get(view.destinationLocationId) ?? null,
    pickupAddress: view.pickupAddress,
    destinationFacility: view.destinationFacility,
    preferredAt: view.preferredAt.toISOString(),
    patientCount: view.patientCount,
    accompanyingPersons: view.accompanyingPersons,
    quote: view.quote
      ? {
          price: price(view)!,
          operatorName,
          conditions: view.quote.conditions,
          quotedAt: view.quote.quotedAt.toISOString(),
        }
      : null,
    confirmedAt: view.confirmedAt?.toISOString() ?? null,
    completedAt: view.completedAt?.toISOString() ?? null,
    closedAt: view.closedAt?.toISOString() ?? null,
    medical: view.medical
      ? {
          patientCondition: view.medical.patientCondition,
          mobility: view.medical.mobility,
          stretcherRequired: view.medical.stretcherRequired,
          oxygenRequired: view.medical.oxygenRequired,
          medicalStaffRequired: view.medical.medicalStaffRequired,
          equipmentRequired: view.medical.equipmentRequired,
          specialisedCare: view.medical.specialisedCare,
          notes: view.medical.notes,
          documents,
        }
      : null,
    // Status changes only; the steps within a status are for operations.
    timeline: events
      .filter((event) => event.fromStatus !== event.toStatus)
      .map((event) => ({
        status: event.toStatus,
        at: event.createdAt.toISOString(),
      })),
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    emergencyNotice: EMERGENCY_NOTICE,
  };
  return { customer, view, events };
}
