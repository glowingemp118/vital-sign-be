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

  @Get('/')
  @ApiBearerAuth()
  getRecords(@Request() req) {
    return this.recordService.getRecords(req);
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

  @Get('/history')
  @ApiBearerAuth()
  historyRecords(@Request() req: any) {
    return this.recordService.historyRecords(req);
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

  @Get('/user/:userId')
  @ApiBearerAuth()
  getUserRecords(@Request() req) {
    const user = { _id: req.params.userId };
    const query = req.query || {};
    return this.recordService.homeRecords({ user, fetchUser: true, query });
  }
  @Get('/user/:userId/:key')
  @ApiBearerAuth()
  getUserKeyRecords(@Request() req) {
    const user = { _id: req.params.userId };
    const key = req.params.key;
    return this.recordService.singleVitalRecord({
      user,
      query: { vital: key },
    });
  }
}
