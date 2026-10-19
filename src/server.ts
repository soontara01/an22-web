import { pino } from 'pino';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const logger = pino({
  level: config.logLevel,
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
});

const server = createApp(config, logger).listen(config.port, () => {
  logger.info({ port: config.port, apiUrl: config.apiUrl, distDir: config.distDir }, 'an22-web started');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
