import copy, hashlib, importlib.util, json, os, sqlite3, tempfile, unittest, uuid, threading, urllib.request, urllib.error
from pathlib import Path
from unittest import mock
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
 def test_clear_all_guests_requires_pin_and_revokes_personal_data(self):
  pin='123456';digest=hashlib.sha256(('wedding:'+pin).encode()).hexdigest()
  current=self.db.sync({'event':'wedding','operations':[]})
  with self.db.connect() as c:
   state=current['state'];state['pin']=digest;state['guests'][0]['phone']='6281234567890'
   c.execute('UPDATE events SET state=? WHERE id=?',(server.encode(state),'wedding'))
  access=server.GuestAccess(self.db);issued=access.issue('wedding','g')
  with self.db.connect() as c:
   c.execute('INSERT INTO rsvps VALUES(?,?,?,?,?)',('wedding','g','attending',1,server.now()))
   c.execute('INSERT INTO wishes VALUES(?,?,?,?)',('wedding','g','Semoga bahagia',server.now()))
  self.assertRaises(ValueError,self.db.clear_guests,'wedding',current['revision'],'0000')
  self.assertRaises(ValueError,self.db.clear_guests,'wedding',current['revision']+1,pin)
  self.db.backup(force=True)
  result=self.db.clear_guests('wedding',current['revision'],pin)
  self.assertTrue(result['ok']);self.assertEqual(result['state']['guests'],[]);self.assertEqual(result['state']['logs'],[])
  self.assertEqual(result['state']['guestEpoch'],1)
  with self.db.connect() as c:
   for table in ('rsvps','wishes','invitation_access','operations'):
    self.assertEqual(c.execute(f'SELECT count(*) FROM {table} WHERE event=?',('wedding',)).fetchone()[0],0)
  backups=list(self.db.backup_dir.glob('temu-*.sqlite3'));self.assertEqual(len(backups),1)
  with sqlite3.connect(backups[0]) as c:self.assertEqual(json.loads(c.execute('SELECT state FROM events').fetchone()[0])['guests'],[])
  self.assertRaises(server.Denied,access.unlock,issued['link'],issued['code'],'127.0.0.1')
  stale=self.db.sync({'event':'wedding','operations':[change(self.initial)]})
  self.assertFalse(stale['results'][0]['ok']);self.assertEqual(stale['state']['guests'],[])
 def test_reset_attendance_preserves_guests_qr_rsvp_wishes_and_links(self):
  pin='8426';digest=hashlib.sha256(('wedding:'+pin).encode()).hexdigest()
  current=self.db.sync({'event':'wedding','operations':[]})
  with self.db.connect() as c:
   state=current['state'];state['pin']=digest;state['guests'][0]['phone']='6281234567890'
   c.execute('UPDATE events SET state=? WHERE id=?',(server.encode(state),'wedding'))
  access=server.GuestAccess(self.db);issued=access.issue('wedding','g')
  with self.db.connect() as c:
   c.execute('INSERT INTO rsvps VALUES(?,?,?,?,?)',('wedding','g','attending',2,server.now()))
   c.execute('INSERT INTO wishes VALUES(?,?,?,?)',('wedding','g','Semoga bahagia',server.now()))
  checked=self.db.sync({'event':'wedding','operations':[change(state)]})
  self.assertEqual(checked['state']['guests'][0]['arrived'],1)
  self.assertRaises(ValueError,self.db.reset_attendance,'wedding',checked['revision'],'0000')
  self.assertRaises(ValueError,self.db.reset_attendance,'wedding',checked['revision']+1,pin)
  result=self.db.reset_attendance('wedding',checked['revision'],pin)
  self.assertEqual(result['state']['guests'][0]['code'],'qr')
  self.assertEqual(result['state']['guests'][0]['name'],'Tamu Uji')
  self.assertEqual(result['state']['guests'][0]['arrived'],0)
  self.assertEqual(result['state']['logs'],[])
  self.assertEqual(result['state']['guestEpoch'],1)
  with self.db.connect() as c:
   for table in ('rsvps','wishes','invitation_access'):
    self.assertEqual(c.execute(f'SELECT count(*) FROM {table} WHERE event=?',('wedding',)).fetchone()[0],1)
  self.assertTrue(access.unlock(issued['link'],issued['code'],'127.0.0.1'))
  stale=self.db.sync({'event':'wedding','operations':[change(checked['state'])]})
  self.assertFalse(stale['results'][0]['ok']);self.assertEqual(stale['state']['guests'][0]['arrived'],0)
 def test_reset_attendance_endpoint_requires_auth_and_pin(self):
  pin='8426';digest=hashlib.sha256(('wedding:'+pin).encode()).hexdigest()
  with self.db.connect() as c:
   state=self.db.sync({'event':'wedding','operations':[]})['state'];state['pin']=digest
   c.execute('UPDATE events SET state=? WHERE id=?',(server.encode(state),'wedding'))
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
  try:
   url=f'http://127.0.0.1:{http.server_port}/api/events/wedding/attendance/reset'
   headers={'Content-Type':'application/json','X-Temu-Reset':'1'}
   req=urllib.request.Request(url,data=json.dumps({'revision':1,'pin':pin}).encode(),headers=headers)
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
   self.assertEqual(error.exception.code,401);error.exception.close()
   headers['Authorization']='Bearer '+token
   bad=urllib.request.Request(url,data=json.dumps({'revision':1,'pin':'1111'}).encode(),headers=headers)
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(bad)
   self.assertEqual(error.exception.code,409);error.exception.close()
   req=urllib.request.Request(url,data=json.dumps({'revision':1,'pin':pin}).encode(),headers=headers)
   with urllib.request.urlopen(req) as response:self.assertEqual(json.load(response)['state']['guests'][0]['code'],'qr')
  finally:http.shutdown();http.server_close();thread.join()
 def test_deleting_legacy_extra_event_preserves_main_event_media(self):
  extra=copy.deepcopy(self.initial);extra['event']['id']='legacy-extra'
  with self.db.connect() as c:c.execute('INSERT INTO events VALUES(?,?,?,?)',('legacy-extra',json.dumps(extra),1,server.now()))
  media_dir=Path(self.tmp.name)/'private-media';media_dir.mkdir();portrait=media_dir/'portrait-1.jpg';portrait.write_bytes(b'portrait')
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
  try:
   with mock.patch.dict(os.environ,{'TEMU_PRIVATE_MEDIA_DIR':str(media_dir)}):
    req=urllib.request.Request(f'http://127.0.0.1:{http.server_port}/api/events/legacy-extra',method='DELETE',headers={'Authorization':'Bearer '+token,'X-Temu-Delete':'1'})
    with urllib.request.urlopen(req) as response:self.assertTrue(json.load(response)['ok'])
   self.assertEqual([event['id'] for event in self.db.events()],['wedding'])
   self.assertEqual(portrait.read_bytes(),b'portrait')
  finally:http.shutdown();http.server_close();thread.join()
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
 def test_clear_guests_endpoint_needs_server_token_and_fresh_pin(self):
  pin='8426';digest=hashlib.sha256(('wedding:'+pin).encode()).hexdigest()
  with self.db.connect() as c:
   state=self.db.sync({'event':'wedding','operations':[]})['state'];state['pin']=digest
   c.execute('UPDATE events SET state=? WHERE id=?',(server.encode(state),'wedding'))
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
  try:
   url=f'http://127.0.0.1:{http.server_port}/api/events/wedding/guests'
   payload=json.dumps({'revision':1,'pin':pin}).encode()
   req=urllib.request.Request(url,data=payload,method='DELETE',headers={'Content-Type':'application/json','X-Temu-Delete':'1'})
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
   self.assertEqual(error.exception.code,401);error.exception.close()
   req.add_header('Authorization','Bearer '+token)
   bad=urllib.request.Request(url,data=json.dumps({'revision':1,'pin':'1111'}).encode(),method='DELETE',headers=dict(req.headers))
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(bad)
   self.assertEqual(error.exception.code,409);error.exception.close()
   with urllib.request.urlopen(req) as response:self.assertEqual(json.load(response)['state']['guests'],[])
  finally:http.shutdown();http.server_close();thread.join()
if __name__=='__main__':unittest.main()
