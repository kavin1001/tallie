import { getMessagingService, seedRequestNotifications } from '@tallie/app-services';
import { identityDatabase } from '@tallie/identity';
import { messagingConfigured } from '@tallie/messaging';

let stopped = false;
process.on('SIGINT', () => {
  stopped = true;
});
process.on('SIGTERM', () => {
  stopped = true;
});

if (!messagingConfigured()) {
  console.info('Messaging worker disabled: configuration is incomplete.');
} else {
  const service = getMessagingService();
  let lastMaintenance = 0;
  console.info('Messaging worker ready. Provider sending remains separately gated.');
  while (!stopped) {
    try {
      await service.processInbound(10);
      await service.processReadyReceipts(10);
      await seedRequestNotifications(50, service);
      await service.dispatch(10);
      if (Date.now() - lastMaintenance > 60_000) {
        await service.purgeExpired();
        lastMaintenance = Date.now();
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'messaging_worker_interrupted',
          errorType: error instanceof Error ? error.name : 'Unknown',
        }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  await identityDatabase().destroy();
}
