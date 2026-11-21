import { Injectable } from '@nestjs/common';
import {
  type ErasureFacts,
  SCRUBBED_AIR_AMBULANCE_CONTACT,
} from '../../common/erasure.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A requester's air ambulance requests in an erasure of their personal data
 * (W5-8b, `modules/privacy`).
 */
@Injectable()
export class AirAmbulanceErasureService {
  /**
   * Locks the requester's requests (`FOR UPDATE`, by id), after their
   * bookings and before their account row, as every request change locks
   * its row before it queues a notification. No request can be added
   * meanwhile (creation takes the customer's lock).
   */
  async lockAll(
    requesterId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$queryRaw`SELECT 1 FROM "AirAmbulanceRequest"
      WHERE "requesterId" = ${requesterId}::uuid ORDER BY "id" FOR UPDATE`;
  }
  /** The requester's requests, for the decision. */
  async facts(
    requesterId: string,
    tx: Prisma.TransactionClient,
  ): Promise<ErasureFacts['airAmbulance']> {
    return tx.airAmbulanceRequest.findMany({
      where: { requesterId },
      select: { status: true, updatedAt: true },
    });
  }

  /**
   * Erases the patient and contact data of the requester's requests, in the
   * caller's transaction, once the caller has found them all closed. Kept:
   * the operational record (reference, route, preferred time, counts,
   * status, quotation, operator, feasibility checklist and the timeline,
   * which holds no free text or medical data). Gone: contact and emergency
   * contact details, pickup address and receiving facility, the medical
   * details row and the medical document links. Returns the documents' file
   * ids, whose files the caller deletes with the documents module.
   */
  async erase(
    requesterId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ requests: number; medical: number; documents: number }> {
    const ofRequester = { request: { requesterId } };
    const requests = await tx.airAmbulanceRequest.updateMany({
      where: { requesterId },
      data: SCRUBBED_AIR_AMBULANCE_CONTACT,
    });
    const medical = await tx.airAmbulanceMedical.deleteMany({
      where: ofRequester,
    });
    const documents = await tx.airAmbulanceDocument.deleteMany({
      where: ofRequester,
    });
    return {
      requests: requests.count,
      medical: medical.count,
      documents: documents.count,
    };
  }
}
