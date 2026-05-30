import './logger.js';
import { config } from './config.js';
import { TeamBot } from './bot.js';
import { JsonStore } from './store.js';
import { createWebApp } from './web.js';

const store = new JsonStore(config.DATA_FILE);
await store.init();

const bot = new TeamBot(store);
await bot.start();

const app = createWebApp(bot, store);
app.listen(config.PORT, config.HOST, () => {
  console.log(`Website listening on ${config.PUBLIC_URL} via ${config.HOST}:${config.PORT}`);
});
