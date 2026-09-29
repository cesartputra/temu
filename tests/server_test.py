import copy, importlib.util, json, sqlite3, tempfile, unittest, uuid, threading, urllib.request, urllib.error
from pathlib import Path
spec=importlib.util.spec_from_file_location('server',Path(__file__).resolve().parents[1]/'server/server.py');server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
def seed():return {'version':1,'event':{'id':'wedding','name':'Acara uji','date':''},'guests':[{'id':'g','code':'qr','name':'Tamu Uji','group':'','quota':2,'arrived':0,'active':True}],'logs':[],'pin':None}
def bootstrap(state):return {'id':str(uuid.uuid4()),'event':'wedding','kind':'bootstrap','state':state}
def change(before,amount=1):
 g=copy.deepcopy(before['guests'][0]);g['arrived']+=amount
 return {'id':str(uuid.uuid4()),'event':'wedding','kind':'change','meta':None,'changes':[{'id':'g','before':before['guests'][0],'after':g}],'logs':[{'id':str(uuid.uuid4()),'guest':'g','count':amount,'at':'2026-09-28T01:00:00Z'}]}
class ServerTests(unittest.TestCase):
 def setUp(self):self.tmp=tempfile.TemporaryDirectory();self.db=server.Database(self.tmp.name);self.initial=seed();self.db.sync({'event':'wedding','operations':[bootstrap(self.initial)]})
 def tearDown(self):self.tmp.cleanup()
 def test_retry_is_idempotent_and_survives_restart(self):
  op=change(self.initial);first=self.db.sync({'event':'wedding','operations':[op]});self.db=server.Database(self.tmp.name);retry=self.db.sync({'event':'wedding','operations':[op]});self.assertEqual(retry['state']['guests'][0]['arrived'],1);self.assertEqual(len(retry['state']['logs']),1);self.assertEqual(first['revision'],retry['revision'])
 def test_two_disconnected_devices_create_visible_conflict(self):
  a=change(self.initial);b=change(self.initial);self.db.sync({'event':'wedding','operations':[a]});result=self.db.sync({'event':'wedding','operations':[b]});self.assertFalse(result['results'][0]['ok']);self.assertEqual(result['state']['guests'][0]['arrived'],1)
 def test_failed_operation_does_not_partially_update(self):
  op=change(self.initial);op['changes'].append({'id':'missing','before':{'id':'bad'},'after':None});r=self.db.sync({'event':'wedding','operations':[op]});self.assertFalse(r['results'][0]['ok']);self.assertEqual(r['state']['guests'][0]['arrived'],0)
 def test_overquota_and_invalid_log_rejected(self):
  r=self.db.sync({'event':'wedding','operations':[change(self.initial,3)]});self.assertFalse(r['results'][0]['ok']);op=change(self.initial);op['logs'][0]['guest']='absent';self.assertFalse(self.db.sync({'event':'wedding','operations':[op]})['results'][0]['ok'])
 def test_backup_is_restorable_sqlite(self):
  self.db.sync({'event':'wedding','operations':[change(self.initial)]});self.db.backup(force=True);p=sorted(self.db.backup_dir.glob('*.sqlite3'))[-1]
  with sqlite3.connect(p) as c:self.assertEqual(c.execute('PRAGMA integrity_check').fetchone()[0],'ok');self.assertEqual(json.loads(c.execute('SELECT state FROM events').fetchone()[0])['guests'][0]['arrived'],1)
 def test_reused_id_with_different_payload_rejected(self):
  op=change(self.initial);self.db.sync({'event':'wedding','operations':[op]});op['changes'][0]['after']['name']='Another';self.assertRaises(ValueError,self.db.sync,{'event':'wedding','operations':[op]})
 def test_phone_and_message_template_sync_and_backup(self):
  op=change(self.initial,0);op['changes'][0]['after']['phone']='6281234567890';op['meta']={'before':{'event':self.initial['event'],'pin':None},'after':{'event':{**self.initial['event'],'invitationText':'Halo {nama}, undangan {acara}'},'pin':None}}
  r=self.db.sync({'event':'wedding','operations':[op]});self.assertTrue(r['results'][0]['ok']);self.assertEqual(r['state']['guests'][0]['phone'],'6281234567890');self.db.backup(force=True)
  with sqlite3.connect(sorted(self.db.backup_dir.glob('*.sqlite3'))[-1]) as c:
   saved=json.loads(c.execute('SELECT state FROM events').fetchone()[0]);self.assertEqual(saved['guests'][0]['phone'],'6281234567890');self.assertIn('{nama}',saved['event']['invitationText'])
 def test_invalid_phone_and_oversized_template_rejected(self):
  op=change(self.initial);op['changes'][0]['after']['phone']='javascript:bad';self.assertFalse(self.db.sync({'event':'wedding','operations':[op]})['results'][0]['ok'])
  bad=seed();bad['event']['invitationText']='x'*2001;self.assertRaises(ValueError,server.validate,bad)
 def test_only_one_event_and_deleted_event_cannot_return(self):
  other=seed();other['event']['id']='other';op={'id':str(uuid.uuid4()),'event':'other','kind':'bootstrap','state':other}
  self.assertFalse(self.db.sync({'event':'other','operations':[op]})['results'][0]['ok'])
  self.assertTrue(self.db.delete_event('wedding'))
  self.assertEqual(self.db.events(),[])
  self.assertFalse(self.db.sync({'event':'wedding','operations':[bootstrap(self.initial)]})['results'][0]['ok'])
  with sqlite3.connect(sorted(self.db.backup_dir.glob('*.sqlite3'))[-1]) as c:self.assertEqual(c.execute('SELECT count(*) FROM events').fetchone()[0],0)
 def test_guest_removal_revokes_private_access(self):
  access=server.GuestAccess(self.db);with_phone=copy.deepcopy(self.initial);with_phone['guests'][0]['phone']='6281234567890'
  op={'id':str(uuid.uuid4()),'event':'wedding','kind':'change','meta':None,'changes':[{'id':'g','before':self.initial['guests'][0],'after':with_phone['guests'][0]}],'logs':[]}
  self.assertTrue(self.db.sync({'event':'wedding','operations':[op]})['results'][0]['ok'])
  issued=access.issue('wedding','g')
  removed={'id':str(uuid.uuid4()),'event':'wedding','kind':'change','meta':None,'changes':[{'id':'g','before':with_phone['guests'][0],'after':None}],'logs':[]}
  self.assertTrue(self.db.sync({'event':'wedding','operations':[removed]})['results'][0]['ok'])
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM invitation_access').fetchone()[0],0)
  self.assertRaises(server.Denied,access.unlock,issued['link'],issued['code'],'127.0.0.1')
 def test_api_auth_and_same_origin(self):
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{http.server_port}'
  try:
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(url+'/api/events')
   self.assertEqual(error.exception.code,401)
   req=urllib.request.Request(url+'/api/events',headers={'Authorization':'Bearer '+token})
   self.assertEqual(len(json.load(urllib.request.urlopen(req))['events']),1)
   req=urllib.request.Request(url+'/api/local-session',data=b'',headers={'X-Temu-Local':'1','Origin':'https://evil.example'})
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
   self.assertEqual(error.exception.code,403)
   req=urllib.request.Request(url+'/api/events/wedding',method='DELETE',headers={'Authorization':'Bearer '+token})
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
   self.assertEqual(error.exception.code,401)
   req.add_header('X-Temu-Delete','1')
   with urllib.request.urlopen(req) as response:self.assertTrue(json.load(response)['ok'])
   self.assertEqual(self.db.events(),[])
  finally:http.shutdown();http.server_close();thread.join()
if __name__=='__main__':unittest.main()
