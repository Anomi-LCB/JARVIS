"""Fault injection for real worker tests only: lose one completed step response."""
import json,runpy,sys
from pathlib import Path
original=sys.stdout
class DropOneReply:
 def __init__(self):self.buffer='';self.dropped=False
 def write(self,value):
  self.buffer+=value
  while '\n' in self.buffer:
   line,self.buffer=self.buffer.split('\n',1)
   try:message=json.loads(line)
   except Exception:message={}
   if not self.dropped and message.get('result',{}).get('version')=='browsergym-action-receipt-v1':
    self.dropped=True
   else:original.write(line+'\n')
  return len(value)
 def flush(self):original.flush()
sys.stdout=DropOneReply()
runpy.run_path(str(Path(__file__).resolve().parents[2]/'scripts/benchmarks/browsergym-worker.py'),run_name='__main__')
