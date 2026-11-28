import { pathToFileURL } from 'node:url';
import { loadState, makeSaver } from './src/store.mjs';
import { seedFromFixtures } from './src/seed.mjs';
import { createApp } from './src/server.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stateFile = process.env.APP_STATE ?? '.local/app.json';
  const { state, seeded } = loadState(stateFile, seedFromFixtures);
  const save = makeSaver(stateFile, state);
  if (seeded) save();
  const server = createApp(state, { partnerUrl: process.env.PARTNER_URL, save });
  server.listen(Number(process.env.PORT ?? 4318), '0.0.0.0', () => {
    console.log(JSON.stringify({ message: '业务服务已启动', port: server.address().port, stateFile, seeded, partner: process.env.PARTNER_URL ?? null }));
  });
}
