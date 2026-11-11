import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { UsersModule } from '../users/users.module.js';
import { CustomersService } from './customers.service.js';
import { MeController } from './me.controller.js';
import { PassengersController } from './passengers.controller.js';

@Module({
  imports: [UsersModule],
  controllers: [MeController, PassengersController],
  providers: [CustomersService, FieldCipher],
  exports: [CustomersService],
})
export class CustomersModule {}
