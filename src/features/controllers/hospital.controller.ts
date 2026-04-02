import {
    Controller,
    Get,
    Post,
    Query,
    Request
} from '@nestjs/common';
import { Access } from '../../decorators/public.decorator';
import { UserType } from '../../user/dto/user.dto';
import { HospitalService } from '../services/hosiptal.service';
@Controller('hospital')
export class HospitalController {
    constructor(private readonly hospitalService: HospitalService) { }

    @Post('/')
    @Access(UserType.User)
    async create(@Request() req) {
        return await this.hospitalService.createHospital(req);
    }

    @Get('/')
    @Access(UserType.User)
    getHospital(@Request() req) {
        return this.hospitalService.getHospitalWithSpecialist(req.user._id);
    }

    @Get('/admin')
    @Access(UserType.Admin)
    getHospitalByAdmin(@Query() query) {
        return this.hospitalService.getHospitalByAdmin({ ...query });
    }

    @Get('/specialist')
    @Access(UserType.Admin)
    getSpecialistByAdmin(@Query() query) {
        return this.hospitalService.getSpecialistByAdmin({ ...query });
    }
}
