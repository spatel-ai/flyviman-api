import { Module } from '@nestjs/common';
import { StorageModule } from '../../integrations/storage/storage.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';
import { StoragePurgeJob } from './storage-purge.job.js';

@Module({
  imports: [StorageModule],
  controllers: [DocumentsController],
  providers: [DocumentsService, StoragePurgeJob],
  exports: [DocumentsService],
})
export class DocumentsModule {}
