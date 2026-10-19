import {provisionStaging} from './provision.js';
try{const result=await provisionStaging();console.log(JSON.stringify({event:'STAGING_SCHEMA_READY',...result}));}
catch{console.error(JSON.stringify({event:'STAGING_PROVISION_BLOCKED',code:'CONFIG_OR_MIGRATION_FAILED',production:false}));process.exitCode=1;}
