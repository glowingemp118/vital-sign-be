import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Types } from 'mongoose';

@Schema({ timestamps: true,collection:"contact-type" })
export class ContactType {

    @Prop({
        required: true, enum: ['primary', 'secondary', 'third'],
        default: 'primary',
    })
    type: string;

    @Prop({ type: String, required: true })
    contact: string; // list of users

    @Prop({ type: Types.ObjectId, ref: 'users' })
    user: Types.ObjectId

    // @Prop({ default: false })
    // isRequired: boolean; // e.g. Primary must be required

    // @Prop({ default: 1 })
    // order: number; // display order (Primary = 1, Secondary = 2)

}

export const ContactTypeSchema = SchemaFactory.createForClass(ContactType);