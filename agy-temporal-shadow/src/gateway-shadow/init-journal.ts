import {GatewayJournal} from './journal.js';
import {GatewayError} from './transport.js';
import {gatewayWorkerSettings} from './runtime.js';

// Offline first-use provisioning only. Never invoke this automatically on worker restart.
try {
  const {config,context} = gatewayWorkerSettings();
  await GatewayJournal.initialize(config.stateDir,context);
  console.log(JSON.stringify({outcome:'JOURNAL_INITIALIZED',transport:'GATEWAY_SHADOW',network_requests:0,production:false}));
} catch (e) {
  console.error(JSON.stringify({outcome:'BLOCKED',code:e instanceof GatewayError ? e.code : 'JOURNAL_INITIALIZATION_FAILED'}));
  process.exitCode = 1;
}
