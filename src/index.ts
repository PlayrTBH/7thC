import './logger.js';
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { config } from './config.js';
import { TeamBot } from './bot.js';
import { createBotProxy, handleBotRpcRequest, isRpcRequest } from './bot-proxy.js';
import { JsonStore } from './store.js';
import { createWebApp } from './web.js';

if (cluster.isPrimary) {
  const store = new JsonStore(config.DATA_FILE);
  await store.init();

  const bot = new TeamBot(store);
  await bot.start();

  const webWorkerCount = config.WEB_CONCURRENCY ?? Math.max(1, availableParallelism() - 1);
  for (let workerIndex = 0; workerIndex < webWorkerCount; workerIndex += 1) {
    cluster.fork({ TEAM_HUB_WORKER_ROLE: 'web' });
  }

  cluster.on('message', async (worker, message: unknown) => {
    if (!isRpcRequest(message)) return;
    worker.send(await handleBotRpcRequest(bot, message));
  });

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`Website worker ${worker.process.pid ?? worker.id} exited (${signal ?? code ?? 'unknown'}). Starting a replacement.`);
    cluster.fork({ TEAM_HUB_WORKER_ROLE: 'web' });
  });

  console.log(`Primary process ${process.pid} started the Discord bot and ${webWorkerCount} website worker(s).`);
} else {
  const store = new JsonStore(config.DATA_FILE);
  await store.init();

  const bot = createBotProxy();
  const app = createWebApp(bot, store);
  app.listen(config.PORT, config.HOST, () => {
    console.log(`Website worker ${process.pid} listening on ${config.PUBLIC_URL} via ${config.HOST}:${config.PORT}`);
  });
}
