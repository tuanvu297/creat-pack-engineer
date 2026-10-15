import {lstatSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,relative,isAbsolute,sep} from 'node:path';
import {fail} from './policy.mjs';

function canonical(value){
 let current=resolve(value);const tail=[];
 for(;;){
  try{lstatSync(current);break;}catch(e){if(e.code!=='ENOENT')fail('PRIVATE_PATH_RESOLUTION_DENIED');}
  const parent=dirname(current);if(parent===current)fail('PRIVATE_PATH_RESOLUTION_DENIED');
  tail.unshift(basename(current));current=parent;
 }
 try{return resolve(realpathSync.native(current),...tail);}catch{fail('PRIVATE_PATH_RESOLUTION_DENIED');}
}
export function isWithin(value,parent){const r=relative(parent,value);return r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep));}
export function externalPaths(pkg,state,config){
 const base=canonical(pkg),s=canonical(state),c=canonical(config);
 if(isWithin(s,base)||isWithin(c,base))fail('PRIVATE_STATE_MUST_BE_EXTERNAL');
 return{state:s,config:c};
}
