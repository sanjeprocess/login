import { app } from './app.js';
import { config } from './config.js';

const server = app.listen(config.PORT, () => {
  console.log(`Motor Insurance Gateway backend listening on port ${config.PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
