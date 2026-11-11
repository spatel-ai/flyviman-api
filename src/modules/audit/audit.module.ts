import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminAuditController } from './admin-audit.controller.js';
import { AuditService } from './audit.service.js';
import { AuditInterceptor } from './audited.js';

/** Global so any module can record an audit entry without importing it. */
@Global()
@Module({
  controllers: [AdminAuditController],
  providers: [
    AuditService,
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AuditService],
})
export class AuditModule {}
