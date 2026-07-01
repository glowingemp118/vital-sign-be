import { SetMetadata } from '@nestjs/common';

export const SKIP_INTERCEPTOR_KEY = 'skipInterceptor';

export const SkipInterceptor = () => SetMetadata(SKIP_INTERCEPTOR_KEY, true);
