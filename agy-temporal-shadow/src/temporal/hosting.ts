export function gatewayListenConfig(env=process.env){
 const hosted=env.AGY_HOSTED_STAGING==='true';
 if(env.AGY_HOSTED_STAGING!==undefined&&!['true','false'].includes(env.AGY_HOSTED_STAGING))throw new Error('INVALID_HOSTED_STAGING_FLAG');
 if(hosted&&(env.AGY_STAGE_ONLY!=='true'||env.AGY_ORCHESTRATION_MODE!=='TEMPORAL_SHADOW'))throw new Error('HOSTED_STAGING_ONLY');
 const raw=hosted?(env.PORT??env.AGY_TEMPORAL_GATEWAY_PORT):(env.AGY_TEMPORAL_GATEWAY_PORT??'8798');
 const port=Number(raw);
 if(!raw||!/^\d+$/.test(raw)||!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('INVALID_GATEWAY_PORT');
 return {host:hosted?'0.0.0.0':'127.0.0.1',port,hosted};
}
