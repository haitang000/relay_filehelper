import { createApp } from './app.mjs';
const service = createApp();
const server = service.app.listen(Number(process.env.PORT ?? 3001), process.env.HOST ?? '0.0.0.0', () => {
  console.log(`轻传已启动：http://localhost:${server.address().port}`);
});
// Long uploads are streamed; reverse proxies must configure their own timeouts.
server.requestTimeout = 30 * 60 * 1000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(() => { service.close(); process.exit(0); });
  setTimeout(() => { server.closeAllConnections(); }, 10000).unref();
});
