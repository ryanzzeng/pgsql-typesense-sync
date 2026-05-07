const logger = {
  trace: jest.fn(),
  debug: jest.fn(),
  info:  jest.fn(),
  warn:  jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

export default logger;
