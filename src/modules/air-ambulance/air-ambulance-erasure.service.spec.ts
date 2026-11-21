import { describe, expect, it, vi } from 'vitest';
import { SCRUBBED_AIR_AMBULANCE_CONTACT } from '../../common/erasure.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AirAmbulanceErasureService } from './air-ambulance-erasure.service.js';

function fakeTx() {
  const count = (n: number) => vi.fn(async () => ({ count: n }));
  return {
    airAmbulanceRequest: { updateMany: count(2) },
    airAmbulanceMedical: { deleteMany: count(2) },
    airAmbulanceDocument: { deleteMany: count(1) },
    airAmbulanceQuoteRevision: { deleteMany: count(1) },
    airAmbulanceRequestEvent: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
}

describe('AirAmbulanceErasureService.erase', () => {
  it('deletes the reasons for replaced quotations with the medical details and documents, leaving the append-only timeline alone', async () => {
    const tx = fakeTx();
    const result = await new AirAmbulanceErasureService().erase(
      'u-customer',
      tx as unknown as Prisma.TransactionClient,
    );
    const ofRequester = { where: { request: { requesterId: 'u-customer' } } };
    expect(tx.airAmbulanceRequest.updateMany).toHaveBeenCalledWith({
      where: { requesterId: 'u-customer' },
      data: SCRUBBED_AIR_AMBULANCE_CONTACT,
    });
    expect(tx.airAmbulanceMedical.deleteMany).toHaveBeenCalledWith(ofRequester);
    expect(tx.airAmbulanceDocument.deleteMany).toHaveBeenCalledWith(
      ofRequester,
    );
    expect(tx.airAmbulanceQuoteRevision.deleteMany).toHaveBeenCalledWith(
      ofRequester,
    );
    expect(tx.airAmbulanceRequestEvent.updateMany).not.toHaveBeenCalled();
    expect(tx.airAmbulanceRequestEvent.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ requests: 2, medical: 2, documents: 1 });
  });
});
