export function temporalConfig(env=process.env){
 const mode=env.AGY_ORCHESTRATION_MODE??'LEGACY';
 if(!['LEGACY','TEMPORAL_SHADOW'].includes(mode))throw new Error('INVALID_ORCHESTRATION_MODE');
 const address=env.TEMPORAL_ADDRESS??'127.0.0.1:7238',namespace=env.TEMPORAL_NAMESPACE??'agy-local',taskQueue=env.TEMPORAL_TASK_QUEUE??'agy-control-shadow-v1';
 // This first release is local synthetic staging only. Cloud/native cutover is separate.
 if(mode==='TEMPORAL_SHADOW'&&(env.AGY_STAGE_ONLY!=='true'||!/^127\.0\.0\.1:\d+$/.test(address)||!/^agy-(local|staging)$/.test(namespace)))throw new Error('LOCAL_STAGING_ONLY');
 return {mode,address,namespace,taskQueue};
}
