export const JWT_SECRET = 'Some Complex Secrete Value';
export const VERSION = '1';

export const NOTIFICATION_TYPE = {
  MESSAGE_NEW: 'message_new',

  APPOINTMENT_NEW: 'appointment_new',
  APPOINTMENT_CONFIRMED: 'appointment_confirmed',
  APPOINTMENT_CANCELLED: 'appointment_cancelled',
  APPOINTMENT_COMPLETED: 'appointment_completed',

  VITAL_ALERT: 'vital_alert',
} as const;

export const NOTIFICATION_CONFIG = {
  [NOTIFICATION_TYPE.MESSAGE_NEW]: {
    title: 'New Message',
    type: NOTIFICATION_TYPE.MESSAGE_NEW,
    message: 'message...',
  },

  [NOTIFICATION_TYPE.APPOINTMENT_NEW]: {
    title: 'New Appointment',
    type: NOTIFICATION_TYPE.APPOINTMENT_NEW,
    message: 'You have a new appointment.',
  },

  [NOTIFICATION_TYPE.APPOINTMENT_CONFIRMED]: {
    title: 'Appointment Confirmed',
    type: NOTIFICATION_TYPE.APPOINTMENT_CONFIRMED,
    message: 'Your appointment has been confirmed.',
  },

  [NOTIFICATION_TYPE.APPOINTMENT_CANCELLED]: {
    title: 'Appointment Cancelled',
    type: NOTIFICATION_TYPE.APPOINTMENT_CANCELLED,
    message: 'Your appointment has been cancelled.',
  },

  [NOTIFICATION_TYPE.APPOINTMENT_COMPLETED]: {
    title: 'Appointment Completed',
    type: NOTIFICATION_TYPE.APPOINTMENT_COMPLETED,
    message: 'Your appointment has been completed.',
  },

  [NOTIFICATION_TYPE.VITAL_ALERT]: {
    title: 'Vital Alert',
    type: NOTIFICATION_TYPE.VITAL_ALERT,
    message: 'A vital alert requires your attention.',
  },
} as const;
