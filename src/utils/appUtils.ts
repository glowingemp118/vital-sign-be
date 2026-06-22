import { UserType } from '../user/dto/user.dto';
import { processObject, processValue } from './encrptdecrpt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import mongoose, { ObjectId, Types } from 'mongoose';

export const modifiedUser = (user: any) => {
  const { password, hashes, roles, ...rest } =
    typeof user?.toObject === 'function' ? user.toObject() : user;

  if (!rest.otp) delete rest.otp;
  rest.image = user.image ? `${process.env.IB_URL}${user.image}` : null;
  rest.role = UserType[rest.user_type];
  const { name, email, phone } = rest || {};
  const mObj = { ...rest, ...processObject({ name, email, phone }, 'decrypt') };

  if (
    user?.user_type === UserType.Admin ||
    user?.user_type === UserType.Doctor
  ) {
    delete mObj.medicalConditions;
  }
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
type VitalStatus =
  | 'low'
  | 'medium'
  | 'normal'
  | 'high'
  | 'critical'
  | 'unknown';
type AlertStatus = Exclude<VitalStatus, 'normal' | 'unknown'>;
export function getVitalStatus(vital: VitalKey, value: string): VitalStatus {
  const num = Number(value);

  switch (vital) {
    case 'bloodPressure': {
      const [s, d] = value.split('/').map(Number);
      if (isNaN(s) || isNaN(d)) return 'unknown';

      if (s >= 180 || d >= 120 || s < 70 || d < 40) return 'critical';
      if (s < 90 || d < 60) return 'low';
      if (s > 140 || d > 90) return 'high';
      if (s > 120 || d > 80) return 'medium';
      return 'normal';
    }

    case 'heartRate':
      if (isNaN(num)) return 'unknown';
      if (num < 40 || num > 130) return 'critical';
      if (num < 60) return 'low';
      if (num > 110) return 'high';
      if (num > 100) return 'medium';
      return 'normal';

    case 'respiratoryRate':
      if (isNaN(num)) return 'unknown';
      if (num < 8 || num > 30) return 'critical';
      if (num < 12) return 'low';
      if (num > 24) return 'high';
      if (num > 20) return 'medium';
      return 'normal';

    case 'oxygenSaturation':
      if (isNaN(num)) return 'unknown';
      if (num < 90) return 'critical';
      if (num < 92) return 'low';
      if (num < 95) return 'medium';
      return 'normal';

    case 'bloodGlucose':
      if (isNaN(num)) return 'unknown';
      if (num < 54 || num > 250) return 'critical';
      if (num < 70) return 'low';
      if (num > 125) return 'high';
      if (num > 100) return 'medium';
      return 'normal';

    default:
      return 'unknown';
  }
}
const STATUS_COPY: Record<
  string,
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
  medium: {
    label: (t) => `Medium ${t}`,
    message: (t, v, u) =>
      `${t} is moderately abnormal (${v}${u ? ` ${u}` : ''})`,
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

export function getTodayBoundary(timezone: string) {
  const start = new Date(
    new Date().toLocaleDateString('en-CA', { timeZone: timezone }) +
      'T00:00:00.000Z',
  );
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

export function dedupeByVital(bodies: any[]) {
  // latest record per vital wins
  const map = new Map<string, any>();
  for (const b of bodies.sort(
    (a, b) =>
      new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  )) {
    if (!map.has(b.vital)) map.set(b.vital, b);
  }
  return [...map.values()];
}

export function buildRecordOp(body: any, uid: ObjectId, existing: any) {
  const value = processValue(String(body.value), 'encrypt');
  const status = body.vstatus !== 'unknown' ? body.vstatus : 'not-measured';
  const recorded_at = new Date(body.recorded_at);

  if (existing) {
    if (existing.value === value && existing.status === status) return null;
    return {
      isNew: false,
      statusChanged: existing.status !== status, // ← did severity change?
      op: {
        updateOne: {
          filter: { _id: existing._id },
          update: { $set: { value, status, recorded_at } },
        },
      },
    };
  }

  return {
    isNew: true,
    statusChanged: false,
    op: {
      insertOne: {
        document: {
          user: uid,
          vital: new Types.ObjectId(body.vital),
          recorded_at,
          value,
          status,
        },
      },
    },
  };
}

export function buildAlertEntry(vitalDoc: any, body: any) {
  if (['normal', 'unknown'].includes(body.vstatus)) return null; // no alert needed
  const msg = getVitalMessage(vitalDoc, body.value, body.vstatus);
  if (!msg) return null;
  return {
    vital: vitalDoc.key,
    status: body.vstatus,
    label: msg.label,
    message: msg.message,
    value: body.value,
    recorded_at: new Date(body.recorded_at),
  };
}
