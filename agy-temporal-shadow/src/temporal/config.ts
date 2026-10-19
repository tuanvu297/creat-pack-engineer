export function temporalConfig(env=process.env){
 const mode=env.AGY_ORCHESTRATION_MODE??'LEGACY';
 if(!['LEGACY','TEMPORAL_SHADOW'].includes(mode))throw new Error('INVALID_ORCHESTRATION_MODE');
 const address=env.TEMPORAL_ADDRESS??'127.0.0.1:7238',namespace=env.TEMPORAL_NAMESPACE??'agy-local',taskQueue=env.TEMPORAL_TASK_QUEUE??'agy-control-shadow-v1';
 const hosted=env.AGY_HOSTED_STAGING==='true';
 const localAddress=/^127\.0\.0\.1:(\d+)$/.exec(address);
 const privateAddress=/^[a-z0-9-]+\.railway\.internal:(\d+)$/.exec(address);
 const port=Number((hosted?privateAddress:localAddress)?.[1]);
 if(mode==='TEMPORAL_SHADOW'&&(env.AGY_STAGE_ONLY!=='true'||!Number.isInteger(port)||port<1||port>65535||
  !(hosted?namespace==='agy-staging':/^agy-(local|staging)$/.test(namespace))))throw new Error(hosted?'PRIVATE_HOSTED_STAGING_ONLY':'LOCAL_STAGING_ONLY');
 return {mode,address,namespace,taskQueue};
}
