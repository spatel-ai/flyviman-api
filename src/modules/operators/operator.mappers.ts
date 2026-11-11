import { day } from '../../common/validation/formats.js';
import {
  AddressDto,
  AdminOperatorSummaryDto,
  OperatorDocumentResponseDto,
  OperatorProfileResponseDto,
} from './dto/operator.dto.js';
import type {
  OperatorDocumentRecord,
  OperatorRecord,
} from './operators.service.js';

export function toProfileDto(
  operator: OperatorRecord,
  missing: string[],
): OperatorProfileResponseDto {
  return {
    id: operator.id,
    status: operator.status,
    legalName: operator.legalName,
    tradingName: operator.tradingName,
    registrationNumber: operator.registrationNumber,
    taxNumber: operator.taxNumber,
    businessAddress: operator.businessAddress as AddressDto | null,
    billingAddress: operator.billingAddress as AddressDto | null,
    contactName: operator.contactName,
    contactEmail: operator.contactEmail,
    contactPhone: operator.contactPhone,
    serviceCategories: operator.serviceCategories,
    operatingRegions: operator.operatingRegions,
    submittedAt: operator.submittedAt?.toISOString() ?? null,
    reviewedAt: operator.reviewedAt?.toISOString() ?? null,
    reviewNote: operator.reviewNote,
    missing,
  };
}

export function toSummaryDto(
  operator: OperatorRecord,
): AdminOperatorSummaryDto {
  return {
    id: operator.id,
    status: operator.status,
    legalName: operator.legalName,
    tradingName: operator.tradingName,
    contactName: operator.contactName,
    contactEmail: operator.contactEmail,
    serviceCategories: operator.serviceCategories,
    submittedAt: operator.submittedAt?.toISOString() ?? null,
    createdAt: operator.createdAt.toISOString(),
  };
}

export function toDocumentDto(
  document: OperatorDocumentRecord,
): OperatorDocumentResponseDto {
  return {
    id: document.id,
    type: document.type,
    fileId: document.fileId,
    fileName: document.fileName,
    issuedAt: day(document.issuedAt),
    expiresAt: day(document.expiresAt),
    verificationStatus: document.verificationStatus,
    verificationNote: document.verificationNote,
    createdAt: document.createdAt.toISOString(),
  };
}
