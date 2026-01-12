import { UserType } from '../user/dto/user.dto';
import { processObject } from './encrptdecrpt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import mongoose from 'mongoose';

export const modifiedUser = (user: any) => {
  const { password, hashes, roles, ...rest } =
    typeof user?.toObject === 'function' ? user.toObject() : user;

  if (!rest.otp) delete rest.otp;
  rest.image = user.image ? `${process.env.IB_URL}${user.image}` : null;
  rest.role = UserType[rest.user_type];
  const { name, email, phone } = rest || {};
  const mObj = { ...rest, ...processObject({ name, email, phone }, 'decrypt') };
  return mObj;
};
export const addDr = async (user: any, body: any, models: any) => {
  try {
    let { specialties: sps, experience, about } = body;
    sps = sps?.map((s: string) => new mongoose.Types.ObjectId(s));
    const specialties = await models.specialty
      .find({
        _id: { $in: sps },
        status: 'active',
      })
      .lean();

    if (specialties.length === 0) {
      throw new Error('Specialty does not exist');
    }

    const doctor = await models.dr.create({
      user: user._id,
      specialties: sps,
      experience: experience,
      about: about || '',
    });

    doctor.specialties = specialties;
    return doctor;
  } catch (error) {
    throw new BadRequestException(error?.message);
  }
};
