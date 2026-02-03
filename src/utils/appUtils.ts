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
    const isExist = await models.dr.findOne({ user: user._id });
    if (isExist) {
      return isExist;
    }
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
type VitalKey =
  | 'bloodPressure'
  | 'heartRate'
  | 'respiratoryRate'
  | 'oxygenSaturation'
  | 'bloodGlucose';
type VitalStatus = 'low' | 'normal' | 'high' | 'critical' | 'unknown';
export function getVitalStatus(vital: VitalKey, value: string): VitalStatus {
  switch (vital) {
    case 'bloodPressure': {
      const [systolic, diastolic] = value.split('/').map(Number);
      if (isNaN(systolic) || isNaN(diastolic)) return 'unknown';

      // 🚨 CRITICAL
      if (systolic >= 180 || diastolic >= 120) return 'critical';
      if (systolic < 70 || diastolic < 40) return 'critical';

      if (systolic < 90 || diastolic < 60) return 'low';
      if (systolic > 130 || diastolic > 80) return 'high';

      return 'normal';
    }

    case 'heartRate': {
      const hr = Number(value);
      if (isNaN(hr)) return 'unknown';

      // 🚨 CRITICAL
      if (hr < 40 || hr > 130) return 'critical';

      if (hr < 60) return 'low';
      if (hr > 100) return 'high';

      return 'normal';
    }

    case 'respiratoryRate': {
      const rr = Number(value);
      if (isNaN(rr)) return 'unknown';

      // 🚨 CRITICAL
      if (rr < 8 || rr > 30) return 'critical';

      if (rr < 12) return 'low';
      if (rr > 20) return 'high';

      return 'normal';
    }

    case 'oxygenSaturation': {
      const spo2 = Number(value);
      if (isNaN(spo2)) return 'unknown';

      // 🚨 CRITICAL
      if (spo2 < 90) return 'critical';

      if (spo2 < 95) return 'low';

      return 'normal';
    }

    case 'bloodGlucose': {
      const glucose = Number(value);
      if (isNaN(glucose)) return 'unknown';

      // 🚨 CRITICAL
      if (glucose < 54 || glucose > 250) return 'critical';

      if (glucose < 70) return 'low';
      if (glucose > 100) return 'high';

      return 'normal';
    }

    default:
      return 'unknown';
  }
}
const STATUS_COPY: Record<
  Exclude<VitalStatus, 'normal' | 'unknown'>,
  {
    label: (title: string) => string;
    message: (title: string, value: string, unit?: string) => string;
  }
> = {
  high: {
    label: (t) => `High ${t}`,
    message: (t, v, u) => `${t} is higher than usual (${v}${u ? ` ${u}` : ''})`,
  },
  low: {
    label: (t) => `Low ${t}`,
    message: (t, v, u) => `${t} is lower than normal (${v}${u ? ` ${u}` : ''})`,
  },
  critical: {
    label: (t) => `Critical ${t}`,
    message: (t, v, u) =>
      `Dangerously abnormal ${t.toLowerCase()} detected (${v}${u ? ` ${u}` : ''})`,
  },
};
export function getVitalMessage(
  vital: any,
  value: string,
  status: string,
): any {
  const copy = STATUS_COPY[status];
  return {
    status,
    label: copy.label(vital.title),
    message: copy.message(vital.title, value, vital.unit),
  };
}
