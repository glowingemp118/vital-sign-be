import { UserType } from '../user/dto/user.dto';
import { processObject, processValue } from './encrptdecrpt';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import mongoose, { ObjectId, Types } from 'mongoose';
import moment from 'moment-timezone';

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

/** Strip units / noise so "30 bpm", "97%", "120/80 mmHg" still classify. */
export function normalizeVitalRawValue(vital: string, value: any): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';

  if (vital === 'bloodPressure') {
    const match = raw.match(/(\d{2,3})\s*\/\s*(\d{2,3})/);
    return match ? `${match[1]}/${match[2]}` : raw;
  }

  const match = raw.match(/-?\d+(\.\d+)?/);
  return match ? match[0] : raw;
}

export function getVitalStatus(vital: VitalKey | string, value: string): VitalStatus {
  const key = String(vital || '');
  const normalized = normalizeVitalRawValue(key, value);
  const num = Number(normalized);

  switch (key) {
    case 'bloodPressure': {
      const [s, d] = normalized.split('/').map(Number);
      if (isNaN(s) || isNaN(d)) return 'unknown';

      // Shock-range / hypertensive emergency
      if (s >= 180 || d >= 120 || s < 70 || d < 40) return 'critical';
      if (s < 90 || d < 60) return 'low';
      if (s > 140 || d > 90) return 'high';
      if (s > 120 || d > 80) return 'medium';
      return 'normal';
    }

    case 'heartRate':
      if (isNaN(num)) return 'unknown';
      // HR ≈ 30 (severe bradycardia) and extreme tachycardia → critical
      if (num <= 40 || num >= 130) return 'critical';
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
    case 'spo2':
      if (isNaN(num)) return 'unknown';
      if (num < 90) return 'critical';
      if (num < 92) return 'low';
      if (num < 95) return 'medium';
      return 'normal';

    case 'bloodGlucose':
    case 'glucose':
      if (isNaN(num)) return 'unknown';
      if (num < 54 || num > 250) return 'critical';
      if (num < 70) return 'low';
      if (num > 125) return 'high';
      if (num > 100) return 'medium';
      return 'normal';

    default:
      return 'normal';
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
      `Critical ${t.toLowerCase()} detected (${v}${u ? ` ${u}` : ''}). Immediate attention may be needed.`,
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

export function getLast24HoursBoundary(timezone: string) {
  const end = moment.tz(timezone);
  const start = end.clone().subtract(24, 'hours');

  return {
    start: start.toDate(),
    end: end.toDate(),
  };
}

export function dedupeByVital(bodies: any[]) {
  // latest record per vital wins
  const map = new Map<string, any>();
  for (const b of bodies.sort(
    (a, b) =>
      new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
  )) {
    // console.log('dedupeByVital', b.vital, b.recorded_at);
    if (!map.has(b.vital)) map.set(b.vital, b);
  }
  return [...map.values()];
}
function isSameDay(a: Date, b: Date) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

export function buildRecordOp(body: any, uid: ObjectId, existing: any) {
  const value = processValue(String(body.value), 'encrypt');
  if (!value || body.vstatus === 'unknown' || body.vstatus === 'not-measured') {
    return null; // no record to create or update
  }
  const status = body.vstatus !== 'unknown' ? body.vstatus : 'not-measured';
  const recorded_at = new Date(body.recorded_at);
  if (
    existing &&
    existing.recorded_at
    // &&
    // isSameDay(existing.recorded_at, recorded_at)
  ) {
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
  // Persist clinical alerts for low/high/critical (not normal/medium noise)
  if (['normal', 'medium', 'unknown', 'not-measured'].includes(body.vstatus))
    return null; // no alert needed
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

/** FCM only for clinically serious events — mobile already handles local "Vitals Updated". */
export function shouldSendVitalPush(status: string): boolean {
  return status === 'high' || status === 'critical';
}
