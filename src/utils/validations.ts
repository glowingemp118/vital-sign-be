import { BadRequestException } from '@nestjs/common';
import { Schema } from 'mongoose';

type ValidateOptions = {
  requiredFields?: string[];
  allowExtraFields?: boolean;
};

export function validateParams(
  schema: Schema,
  data: Record<string, any>,
  options: ValidateOptions = {},
) {
  const errors: { field: string; error: string }[] = [];

  const schemaFields = schema && Object.keys(schema.obj);
  const requiredFields = options.requiredFields || [];
  const allowExtraFields = options.allowExtraFields ?? false;
  // 1️⃣ Required fields (CUSTOM PER REQUEST)
  for (const field of requiredFields) {
    if (data[field] === undefined || data[field] === null) {
      errors.push({
        field,
        error: `${field} is required`,
      });
    }
  }

  // 2️⃣ Extra fields check
  if (!allowExtraFields) {
    for (const field of Object.keys(data)) {
      if (!schemaFields.includes(field)) {
        errors.push({
          field,
          error: 'field is not allowed',
        });
      }
    }
  }

  // 3️⃣ Type validation
  for (const field of schemaFields) {
    if (data[field] === undefined) continue;

    const expectedType = getExpectedType(schema.obj[field]);
    let actualType = getActualType(data[field]);

    // Special handling for date fields: allow string if it can be parsed as a date
    if (expectedType === 'date' && typeof data[field] === 'string') {
      const parsedDate = new Date(data[field]);
      if (!isNaN(parsedDate.getTime())) {
        actualType = 'date';
        data[field] = parsedDate; // Optionally convert to Date object
      }
    }

    if (expectedType && expectedType !== actualType) {
      errors.push({
        field,
        error: `${field} must be a ${expectedType}`,
      });
    }
  }

  if (errors.length) {
    throw new BadRequestException({
      message: 'Validation failed',
      errors,
    });
  }
}

/* helpers */

function getExpectedType(schemaDef: any): string | null {
  const type = schemaDef?.type || schemaDef;

  if (type === String) return 'string';
  if (type === Number) return 'number';
  if (type === Boolean) return 'boolean';
  if (type === Date) return 'date';
  if (Array.isArray(type)) return 'array';
  if (type?.name === 'ObjectId') return 'string';

  return null;
}

function getActualType(value: any): string {
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}
