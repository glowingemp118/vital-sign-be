import {
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Post,
    Request
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Access } from 'src/decorators/public.decorator';
import { UserType } from 'src/user/dto/user.dto';
import { ContactTypeService } from './contact-type.service';

@Controller('contact-type') // Change the controller prefix to '/contact-type'

export class ContactTypeController {
    constructor(private readonly contactTypeService: ContactTypeService) { }

    @Post("")
    @ApiBearerAuth()
    @Access(UserType.User)
    @HttpCode(HttpStatus.CREATED)
    async createContactType(@Request() req: any) {
        return await this.contactTypeService.newContactType(req);
    }

    @Get("")
    @ApiBearerAuth()
    @Access(UserType.User)
    @HttpCode(HttpStatus.OK)
    async getContactType(@Request() req:any ) {
        return await this.contactTypeService.getContactType(req);
    }
}