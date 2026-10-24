import { createApp } from './app.mjs';

const service = createApp();
const server = service.app.listen(
  Number(process.env.PORT ?? 3001),
  process.env.HOST ?? '0.0.0.0',
  () => {
    console.log(`轻传已启动：http://localhost:${server.address().port}`);
    setImmediate(() => service.cleanup());
  },
);
// Absolute cap for an active upload. Rejected requests destroy unread sockets instead of waiting this out.
server.requestTimeout = 30 * 60 * 1000;
server.headersTimeout = 60 * 1000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.close(() => {
      service.close();
      process.exit(0);
    });
    setTimeout(() => {
      server.closeAllConnections();
    }, 10000).unref();
  });
}
