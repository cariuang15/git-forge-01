// Local dev runner: start the forge on its own port without an env to register with.
// Not part of the entry contract (main.ts is); used only to test the server by hand.
// Usage: MAKEFUN_SHOP_TOKEN=test-token PORT=3000 node --experimental-strip-types dev.ts

import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[gitforge] dev server on http://127.0.0.1:${port} (token: ${process.env.MAKEFUN_SHOP_TOKEN ?? '(any bearer)'})\n`);
});
