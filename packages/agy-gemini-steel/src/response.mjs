// Pure formatting normalization. DOM role and durable SEND identity remain separate gates.
export function normalizeResponse(text,nonce){
 if(typeof text!=='string'||typeof nonce!=='string'||!(/^[A-Z0-9-]{8,60}$/).test(nonce))return null;
 let body=text.replace(/\r\n/g,'\n').trim();
 for(const heading of ['Gemini said','Gemini đã nói']){
  if(body.startsWith(heading+'\n')){body=body.slice(heading.length+1).replace(/^\n+/,'');break;}
 }
 const lines=body.split('\n');
 if(lines.length!==2||lines[0]!=='ACK:'+nonce||!['SUM:42','SUM:42 (19+23)'].includes(lines[1]))return null;
 return'ACK:'+nonce+'\nSUM:42';
}
