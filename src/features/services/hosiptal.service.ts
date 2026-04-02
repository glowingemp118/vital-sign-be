import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Model } from 'mongoose';
import { User } from 'src/user/schemas/user.schema';
import { checkHospital, validateParams } from '../../utils/validations';
import { Hospital } from '../schemas/hospital.schema';
import { HospitalUser } from '../schemas/HospitalUser.schema';
import { Record } from '../schemas/records.schema';
import { Specialist } from '../schemas/specialist.schema';
import { Vital } from '../schemas/vital.schema';
import { finalRes, GetHospitals, paginationPipeline } from 'src/utils/dbUtils';
import { Types } from 'mongoose';
import { processObject, processValue } from 'src/utils/encrptdecrpt';

@Injectable()
export class HospitalService {
    constructor(
        @InjectModel(Hospital.name) private hospitalModel: Model<Hospital>,
        @InjectModel(User.name) private userModel: Model<User>,
        @InjectModel(HospitalUser.name) private hospitalUserModel: Model<HospitalUser>,
        @InjectModel(Specialist.name) private specialistModel: Model<Specialist>,
        @InjectModel(Record.name) private recordModel: Model<Record>,
        @InjectModel(Vital.name) private vitalModel: Model<Vital>,

    ) { }

    async createHospital(req: any) {
        try {
            const body = req.body;
            const uid = new mongoose.Types.ObjectId(req?.user?._id);


            validateParams(this.specialistModel.schema, body, {
                requiredFields: ['doctor_name', 'doctor_email'],
                allowExtraFields: true,
            });

            let { hospitals, doctor_name, doctor_email } = body;

            if (!checkHospital(hospitals)) {
                throw new Error("Please enter valid hospital details");
            }

            const user = uid;

            const hospitalDocs = await Promise.all(

                hospitals.map(async (item: any) => {
                    let hospital = await this.hospitalModel
                        .findOne({ name: item.name })
                        .exec();

                    if (!hospital) {
                        hospital = await new this.hospitalModel({
                            name: item.name,
                            location: item.location,
                            areaLevel: item.areaLevel,
                        }).save();
                    }

                    return hospital;
                })
            );

            await Promise.all(
                hospitalDocs.map(async (item: any) => {
                    const exists = await this.hospitalUserModel
                        .findOne({ hospital: item._id, user })
                        .exec();

                    if (!exists) {
                        return await new this.hospitalUserModel({
                            hospital: item._id,
                            user,
                        }).save();
                    }

                    return exists;
                })
            );

            let specialist = await this.specialistModel
                .findOne({ email: doctor_email, user })
                .exec();

            if (!specialist) {
                specialist = await new this.specialistModel({
                    email: doctor_email,
                    name: doctor_name,
                    user,
                }).save();
            }

            return {
                hospitals: hospitalDocs,
                specialist,
            }

        } catch (error) {
            console.error('Error in createHospital:', error?.message);
            throw new Error(error?.message);
        }
    }
    async getHospitalWithSpecialist(
        userId: mongoose.Types.ObjectId,
    ) {
        try {

            const hospitals = await this.hospitalUserModel.aggregate(GetHospitals(userId));

            const specialist = await this.specialistModel.findOne({ user: new Types.ObjectId(userId) });

            return {
                hospitals,
                specialist
            };

        } catch (error) {
            throw new Error(error?.message);
        }
    }
    async getHospitalByAdmin(query: any) {

        const { pageno, limit, search } = query;


        let obj: any = {};
        try {
            if (search) {
                obj['$or'] = [
                    { name: { $regex: `.*${search}.*`, $options: 'i' } },
                    { location: { $regex: `.*${search}.*`, $options: 'i' } },
                    { areaLevel: { $regex: `.*${search}.*`, $options: 'i' } },
                ];
            }

            const pipeline: any[] = [{ $match: obj }]; // Match the filter

            pipeline.push({
                $lookup: {
                    from: "hospitalusers",
                    as: "hospitals",
                    let: { id: "$_id" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$hospital", "$$id"]
                                }
                            }
                        }
                    ]
                }
            });

            pipeline.push({
                $addFields: {
                    selectedBy: {
                        $size: "$hospitals"
                    }
                }
            })
            pipeline.push({
                $project: {
                    hospitals: 0
                }
            })

            if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination

            const data = await this.hospitalModel.aggregate(pipeline);

            const result = finalRes({ pageno, limit, data });

            return { ...result, meta: { ...result?.meta } };
        } catch (err) {
            throw new NotFoundException('No requests found');
        }

    }

    async getSpecialistByAdmin(query: any) {

        let { pageno, limit, search } = query;

        let obj: any = {};
        try {
            if (search) {
                obj['$or'] = [
                    { name: { $regex: `.*${search}.*`, $options: 'i' } },
                    { email: { $regex: `.*${search}.*`, $options: 'i' } },
                ];
            }


            const pipeline: any[] = [];

            // 1. Lookup first
            pipeline.push({
                $lookup: {
                    from: "users",
                    let: { id: "$user" },
                    as: "patient",
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$_id", "$$id"]
                                }
                            }
                        },
                        {
                            $project: {
                                email: 1,
                                name: 1,
                                hashes: 1,
                            }
                        }
                    ]
                }
            });

            // 2. Unwind
            pipeline.push({
                $unwind: "$patient"
            });

            if (search) {
                const hashSearch = processValue(search, 'hash');

                pipeline.push({
                    $match: {
                        $or: [
                            // Specialist (plain)
                            { name: { $regex: search, $options: 'i' } },
                            { email: { $regex: search, $options: 'i' } },

                            // Patient (hashed)
                            { "patient.hashes.name": { $regex: hashSearch, $options: 'i' } },
                            { "patient.hashes.email": { $regex: hashSearch, $options: 'i' } },
                        ]
                    }
                });
            }
            if (pageno && limit) pipeline.push(paginationPipeline({ pageno, limit })); // Pagination

            const data = await this.specialistModel.aggregate(pipeline);

            const result = finalRes({ pageno, limit, data });

            return {
                data: result?.data?.map((r: any) => {
                    delete r?.patient.hashes;
                    return {
                        ...r,
                        patient: processObject(r.patient, 'decrypt'),
                    };
                }), meta: { ...result?.meta }
            };
        } catch (err) {
            throw new NotFoundException('No requests found');
        }
    }

}
