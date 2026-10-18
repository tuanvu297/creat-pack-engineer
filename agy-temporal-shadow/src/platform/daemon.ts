import {workerTransport} from '../gateway-shadow/config.js';
if (workerTransport() === 'GATEWAY_SHADOW') {
  await (await import('../gateway-shadow/runtime.js')).runGatewayWorker(false);
} else {
  await import('./legacy-daemon.js');
}
