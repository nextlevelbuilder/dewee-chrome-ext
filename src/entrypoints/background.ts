import { startServiceWorker } from '@/background/service-worker';

export default defineBackground(() => {
  startServiceWorker();
});
