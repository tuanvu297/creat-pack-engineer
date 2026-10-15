"""JSON-lines MCP stdio facade; one adapter/journal, no authority issuance tool."""
import sys
from manus_kit import Adapter,Api,KitError,MAX_BYTES,dumps,strict_load,grant_from_file

SCHEMAS={
 'manus_auth_health':({},[]),
 'manus_available_credits':({},[]),
 'manus_task_create':({'prompt':{'type':'string','maxLength':8000}},['prompt']),
 'manus_task_readback':({},[]),
 'manus_task_resume':({'prompt':{'type':'string','maxLength':8000},'command_key':{'type':'string'},'reason':{'type':'string'}},['prompt','command_key','reason']),
 'manus_task_stop':({'command_key':{'type':'string'}},[]),
 'manus_journal_status':({},[]),
 'agy_dispatch_status':({'task_id':{'type':'string'}},['task_id'])}

class Server:
    def __init__(self,journal,key,grant_path,*,api=None):
        self.journal=journal;self.key=key;self.grant_path=grant_path;self.api=api;self.adapter=None;self.ready=False;self.initializing=False
    def handle(self,m):
        rid=m.get('id') if isinstance(m,dict) else None
        def error(code,message):return {'jsonrpc':'2.0','id':rid,'error':{'code':code,'message':message}}
        def ok(result):return {'jsonrpc':'2.0','id':rid,'result':result}
        if not isinstance(m,dict) or m.get('jsonrpc')!='2.0' or not isinstance(m.get('method'),str):return error(-32600,'Invalid request')
        if rid is not None and (type(rid) not in {str,int}):return error(-32600,'Invalid request ID')
        method=m['method']
        if method=='initialize':
            p=m.get('params',{})
            if self.ready or self.initializing:return error(-32600,'Already initialized')
            if not isinstance(p,dict) or not isinstance(p.get('clientInfo'),dict) or not isinstance(p.get('protocolVersion'),str):return error(-32602,'Invalid initialize')
            if p['protocolVersion'] not in {'2025-11-25','2025-06-18','2025-03-26','2024-11-05'}:return error(-32602,'Unsupported protocol')
            self.initializing=True
            return ok({'protocolVersion':p['protocolVersion'],'capabilities':{'tools':{'listChanged':False}},'serverInfo':{'name':'manus_connection_kit','version':'0.1.1'}})
        if method=='notifications/initialized':
            if self.initializing:self.ready=True
            return None
        if method.startswith('notifications/'):return None
        if not self.ready:return error(-32000,'Initialization required')
        if method=='ping':return ok({})
        if method=='tools/list':
            return ok({'tools':[{'name':name,'description':'Bounded Manus/AGY kit operation; mutating operations require host controller grant',
              'inputSchema':{'type':'object','properties':props,'required':required,'additionalProperties':False}}
              for name,(props,required) in SCHEMAS.items()]})
        if method!='tools/call':return error(-32601,'Method not found')
        try:
            params=m.get('params',{});name=params.get('name');args=params.get('arguments',{})
            if name not in SCHEMAS or not isinstance(args,dict):raise KitError('MCP_ARGUMENTS_DENIED')
            props,required=SCHEMAS[name]
            if not set(args)<=set(props) or not set(required)<=set(args):raise KitError('MCP_ARGUMENTS_DENIED')
            if any(not isinstance(v,str) or len(v)>props[k].get('maxLength',8000) for k,v in args.items()):raise KitError('MCP_ARGUMENTS_DENIED')
            if name=='manus_journal_status':result={'intents':self.journal.pending(),'network_requests':0}
            elif name=='agy_dispatch_status':result=self.journal.dispatch_status(args['task_id'])
            else:
                if not self.adapter:self.adapter=Adapter(self.journal,self.api or Api(self.key))
                if name=='manus_auth_health':result=self.adapter.auth()
                elif name=='manus_available_credits':result=self.adapter.resource()
                else:
                    grant=grant_from_file(self.grant_path)
                    if name=='manus_task_create':result=self.adapter.create(grant,args['prompt'])
                    elif name=='manus_task_readback':result=self.adapter.read(grant,reconcile=True)
                    elif name=='manus_task_resume':result=self.adapter.resume(grant,args['prompt'],args['command_key'],args['reason'])
                    else:result=self.adapter.stop(grant,args.get('command_key','stop'))
            return ok({'content':[{'type':'text','text':dumps(result)}],'structuredContent':result,'isError':False})
        except KitError as e:return ok({'content':[{'type':'text','text':e.code}],'isError':True})
        except Exception:return ok({'content':[{'type':'text','text':'MCP_LOCAL_INPUT_OR_STATE_REJECTED'}],'isError':True})

def serve(journal,key,grant_path):
    server=Server(journal,key,grant_path)
    while True:
        line=sys.stdin.buffer.readline(MAX_BYTES+1)
        if not line:break
        if len(line)>MAX_BYTES:
            response={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Message size exceeded'}}
        else:
            try:response=server.handle(strict_load(line))
            except KitError:response={'jsonrpc':'2.0','id':None,'error':{'code':-32700,'message':'Invalid JSON'}}
        if response is not None:print(dumps(response),flush=True)
