import {
    BadRequestException,
    Injectable
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { validateParams } from 'src/utils/validations';
import { ContactType } from './schemas/contac-type.schema';
import mongoose from 'mongoose';

type ContactTypeUnion = 'primary' | 'secondary' | 'third';


interface Contact {
    name: string;
    type: ContactType;
}
const order: Record<ContactTypeUnion, number> = {
    primary: 1,
    secondary: 2,
    third: 3,
};
@Injectable()
export class ContactTypeService {
    constructor(
        @InjectModel(ContactType.name) private contactTypeModel: Model<ContactType>,
    ) { }

    async createUpdateContactType(req: any) {

        const contact = req.body;

        const user = req.user;

        validateParams(this.contactTypeModel.schema, contact, {
            requiredFields: ['type', 'contact'],
            allowExtraFields: true,
        });

        if (contact.type !== 'primary' && contact.type !== 'secondary' && contact.type !== 'third') {
            throw new Error('Only primary, secondary and third are allowed')
        }

        const contactExist: any = await this.contactTypeModel.findOne({ type: contact.type, user: user._id });

        if (contactExist) {
            contactExist.type === contact.type;
            contactExist.contact = contact.contact;
            return await contactExist.save();
        }

        return await this.contactTypeModel.create({
            type: contact.type,
            contact: contact.contact,
            user: new mongoose.Types.ObjectId(user._id)
        });

    }


    newContactType(req: any) {
        try {

            let contacts: any = req.body;

            const user = req.user;

            let result: any = [];

            contacts = Array.isArray(contacts) ? contacts : [contacts];

            contacts.sort((a, b: any) => {
                return order[a.type] - order[b.type];
            });

            contacts.map((contact: { type: string, contact: string }) => {
                result.push(this.createUpdateContactType({
                    body: contact,
                    user
                }));
            });


            return Promise.all(result);

        } catch (error) {
            throw new BadRequestException(error?.message);
        }

    }

    async getContactType(req: any) {

        const user = req.user;

        return await this.contactTypeModel.find({ user: user._id });

    }
}