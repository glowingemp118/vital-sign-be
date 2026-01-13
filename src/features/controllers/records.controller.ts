import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  Request,
  Put,
  Query,
} from '@nestjs/common';
import { RecordService } from '../services/records.services';
import { ApiBearerAuth } from '@nestjs/swagger';

@Controller('record')
export class RecordController {
  constructor(private readonly recordService: RecordService) {}

  @Post('/')
  @ApiBearerAuth()
  create(@Request() req) {
    return this.recordService.createUpdate(req);
  }

  @Post('/bulk')
  @ApiBearerAuth()
  bulkCreateUpdate(@Request() req) {
    return this.recordService.bulkCreateUpdate(req);
  }

  @Get('/vitals')
  @ApiBearerAuth()
  getVitals(@Request() req: any) {
    return this.recordService.getVitals(req);
  }

  @Get('/vital')
  @ApiBearerAuth()
  singleVital(@Request() req: any) {
    return this.recordService.singleVital(req);
  }

  @Get('/home')
  @ApiBearerAuth()
  homeRecords(@Request() req: any) {
    return this.recordService.homeRecords(req);
  }

  @Get('/home/single')
  @ApiBearerAuth()
  singleRecord(@Request() req: any) {
    return this.recordService.singleVitalRecord(req);
  }

  @Get('/home/activity')
  @ApiBearerAuth()
  activityRecords(@Request() req: any) {
    return this.recordService.activityRecords(req);
  }

  @Get('/:id')
  @ApiBearerAuth()
  findOne(@Param('id') id: string) {
    return this.recordService.findOne(id);
  }

  @Put('/:id')
  @ApiBearerAuth()
  update(@Param('id') id: string, @Body() updateRecordDto: any) {
    return this.recordService.update(id, updateRecordDto);
  }

  @Delete('/:id')
  @ApiBearerAuth()
  remove(@Param('id') id: string) {
    return this.recordService.remove(id);
  }
}
