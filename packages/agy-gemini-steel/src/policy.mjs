export class Denied extends Error{constructor(code){super(code);this.code=code;}}
export const fail=code=>{throw new Denied(code);};
export const PAGE_HOSTS=new Set(['gemini.google.com','accounts.google.com']);
export const RESOURCE_HOSTS=new Set([...PAGE_HOSTS,'www.google.com','www.gstatic.com','gemini.gstatic.com','ssl.gstatic.com','fonts.googleapis.com','fonts.gstatic.com','lh3.googleusercontent.com','www.googleusercontent.com','apis.google.com']);
export function allowed(value,{resource=false}={}){
 let u;try{u=new URL(value);}catch{fail('URL_DENIED');}
 if(u.protocol!=='https:'||u.port||u.username||u.password||!(resource?RESOURCE_HOSTS:PAGE_HOSTS).has(u.hostname))fail('URL_DENIED');
 return u.href;
}
export function publicPage(value){try{const u=new URL(allowed(value));return u.origin+(u.hostname==='accounts.google.com'?'/[AUTH_PATH_REDACTED]':u.pathname);}catch{return'UNVERIFIED_PAGE';}}
export function checkPolicy(p,now=Date.now(),{cleanup=false}={}){
 if(p?.schema_version!==1||p.worker_id!=='GEMINI-STEEL'||!/^AGY-GEMINI-STEEL-[A-Za-z0-9:-]+$/.test(p.task_id??''))fail('POLICY_IDENTITY_DENIED');
 if(!p.owner_request_ref||!p.callback_target||!Number.isSafeInteger(p.expires_at)||(!cleanup&&p.expires_at<=now))fail('POLICY_EXPIRED_OR_UNBOUND');
 if(p.max_sessions!==1||p.max_submissions!==1||p.timeout_ms<60000||p.timeout_ms>900000||!Number.isSafeInteger(p.timeout_ms))fail('POLICY_BUDGET_DENIED');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.project_id??''))fail('PROJECT_BINDING_REQUIRED');
 if(p.persist_profile!==false)fail('PROFILE_PERSISTENCE_NEEDS_EXPLICIT_AUTHORIZATION');
 if(p.allow_guest_probe!==undefined&&typeof p.allow_guest_probe!=='boolean')fail('GUEST_POLICY_BOOLEAN_REQUIRED');
 if(!cleanup&&(p.resource?.eligibility!=='VERIFIED_EXISTING_CREDIT'||!Number.isSafeInteger(p.resource.checked_at)||p.resource.checked_at<now-3600000||p.resource.checked_at>now))fail('RESOURCE_FRESHNESS_DENIED');
 return p;
}
export function validateText(text){if(typeof text!=='string'||text.length<1||text.length>1000||/-----BEGIN .*PRIVATE KEY|\bsk-[\w-]{24,}|\bste-[\w-]{25,}|(?:password|api_key|access_token)\s*[:=]/i.test(text))fail('TEXT_DENIED');return text;}
