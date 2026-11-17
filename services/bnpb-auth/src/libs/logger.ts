import pino from 'pino';
import { traceLogFields } from '../telemetry/context';
import env from '../util/env';

const isProduction = env.NODE_ENV === 'production';

export const logger = pino({
    name: env.SERVICE_NAME,
    mixin: traceLogFields,
    level: isProduction ? 'info' : 'debug',
    transport: isProduction
        ? undefined
        : {
              target: 'pino-pretty',
              options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
              },
          },
});

export default logger;
