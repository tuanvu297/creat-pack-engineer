import {workerTransport} from '../gateway-shadow/config.js';
if (workerTransport() === 'GATEWAY_SHADOW') {
  await (await import('../gateway-shadow/runtime.js')).runGatewayWorker(true);
} else {
  await import('./legacy-worker.js');
}
