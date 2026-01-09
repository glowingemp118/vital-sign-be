import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema()
export class Speciality {
  @Prop({ required: true })
  title: string;

  @Prop()
  description: string;

  @Prop({ default: 'active' })
  status: string;

  @Prop({ default: 'noimage.png' })
  image: string;
}

export type SpecialityDocument = Speciality & Document;
export const SpecialitySchema = SchemaFactory.createForClass(Speciality);
