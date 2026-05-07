import pino from 'pino';
import config from './config';

// formatters.level outputs "info"/"error" instead of pino's default numeric 30/50
const logger = pino({
  level: config.logLevel,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export default logger;
