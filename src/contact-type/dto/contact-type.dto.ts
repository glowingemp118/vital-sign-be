import { IsString } from "class-validator";

export class ContactTypeDto {

    @IsString()
    type: string;

    @IsString()
    contact: string;

}