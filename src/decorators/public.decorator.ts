import { SetMetadata } from '@nestjs/common';
import { UserType } from 'src/user/dto/user.dto';

export const IS_PUBLIC_KEY = 'isPublic';

export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);


export const ACCESS_KEY = 'access';
export const Access = (...types: UserType[]) =>
  SetMetadata(ACCESS_KEY, types);