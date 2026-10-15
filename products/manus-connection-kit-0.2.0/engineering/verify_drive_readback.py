from pathlib import Path
import hashlib,json,urllib.request
ROOT=Path(__file__).resolve().parents[1]
expected={'ai':'9dfd29c46063be497ec099e39264ed6b27457f59f410c1e26c6c7284901060ad','human':'5246f39546b064a55abed32d6b5efe5bdb6fe74b19a56156c393b1fce43fdd13','aiEvidence':'5a12eec84f75e399fe2d89926ebf1ecb095df409357d56c259dc0eadf59b4941','humanEvidence':'73fa715911d79fe3b37a3710e84687468f69bba5d0a3fd27e74e7f48a67e2e20'}
rows=[]
for item in json.loads((ROOT/'readback-private'/'downloads.json').read_text(encoding='utf-8')):
 h=hashlib.sha256();size=0
 with urllib.request.urlopen(item['url'],timeout=45) as response:
  while True:
   data=response.read(1024*1024)
   if not data:break
   size+=len(data)
   if size>25*1024*1024:raise RuntimeError('READBACK_SIZE_LIMIT')
   h.update(data)
 actual=h.hexdigest();assert actual==expected[item['key']],item['key']
 rows.append({'artifact':item['key'],'sha256':actual,'bytes':size,'readback':'EXACT_SHA256_MATCH','classification':'OBSERVED'})
(ROOT/'engineering'/'DRIVE-BINARY-READBACK.json').write_text(json.dumps(rows,indent=2)+'\n',encoding='utf-8')
print(json.dumps(rows))
