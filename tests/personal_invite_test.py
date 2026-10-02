import http.cookiejar, concurrent.futures, hashlib
import json, tempfile, threading, unittest, urllib.request, urllib.error
from server_test import server, seed, bootstrap, change

class PersonalInvitationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=server.Database(self.tmp.name);self.state=seed();self.state['guests'][0]['quota']=2
  self.db.sync({'event':'wedding','operations':[bootstrap(self.state)]})
  self.token='t'*40;self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,self.token,{'127.0.0.1'}))
  self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.http.server_port}';self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));self.post('/api/invite/device',{})
 def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
 def post(self,path,data,admin=False):
  headers={'Content-Type':'application/json','X-Temu-Invite':'1'}
  if admin:headers['Authorization']='Bearer '+self.token
  req=urllib.request.Request(self.origin+path,data=json.dumps(data).encode(),headers=headers)
  with self.opener.open(req) as response:return json.load(response)
 def test_unique_link_rsvp_wish_and_overview(self):
  link=self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True)
  self.assertEqual(len(link['key']),43);self.assertEqual(link,self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True))
  guest=self.post('/api/invite/guest',link);self.assertEqual(guest['guest'],{'name':'Tamu Uji','quota':2});self.assertIsNone(guest['rsvp'])
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/rsvp',{**link,'status':'attending','count':3})
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  self.post('/api/invite/rsvp',{**link,'status':'attending','count':2})
  overview=json.load(urllib.request.urlopen(urllib.request.Request(self.origin+'/api/invite/admin/rsvp',headers={'Authorization':'Bearer '+self.token})))
  self.assertEqual(overview['summary'],{'attending':1,'declined':0,'pending':0,'persons':2})
  self.post('/api/invite/wish',{**link,'message':'Semoga bahagia <selalu>'})
  with self.opener.open(self.origin+'/api/invite/wishes') as response:wishes=json.load(response)['wishes']
  self.assertEqual(wishes[0]['message'],'Semoga bahagia <selalu>');self.assertEqual(wishes[0]['name'],'Tamu Uji & Pasangan');self.assertEqual(wishes[0]['status'],'attending')
  self.post('/api/invite/rsvp',{**link,'status':'declined','count':0})
  self.assertEqual(self.db.rsvp_overview('wedding')['summary']['declined'],1)
  restarted=server.Database(self.tmp.name)
  self.assertEqual(restarted.guest_link('wedding','g'),link)
  self.assertEqual(restarted.invite_guest(**link)['rsvp']['status'],'declined')
  self.assertEqual(restarted.public_wishes()[0]['message'],'Semoga bahagia <selalu>')
  self.db.backup(force=True);self.assertTrue(list(self.db.backup_dir.glob('*.sqlite3')))
 def test_invalid_link_and_deleted_guest_cannot_submit(self):
  link=self.db.guest_link('wedding','g')
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/guest',{**link,'key':'A'*43})
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  op=change(self.state,0);op['changes'][0]['after']['active']=False;self.db.sync({'event':'wedding','operations':[op]})
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/guest',link)
  self.assertEqual(failure.exception.code,400);failure.exception.close()
  self.assertEqual(self.db.public_wishes(),[])

 def test_device_lock_survives_restart_and_blocks_other_browser(self):
  link=self.db.guest_link('wedding','g');self.post('/api/invite/guest',link)
  self.assertEqual(self.post('/api/invite/guest',link)['guest']['name'],'Tamu Uji')
  other=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  def other_post(path,data):
   return other.open(urllib.request.Request(self.origin+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','X-Temu-Invite':'1'}))
  other_post('/api/invite/device',{}).close()
  for path,payload in [('guest',link),('rsvp',{**link,'status':'attending','count':1}),('wish',{**link,'message':'Forwarded'})]:
   with self.assertRaises(urllib.error.HTTPError) as error:other_post('/api/invite/'+path,payload)
   self.assertEqual(error.exception.code,403);error.exception.close()
  restarted=server.Database(self.tmp.name)
  with restarted.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM invitation_devices').fetchone()[0],1)
  with self.assertRaises(server.Denied):restarted.bind_invitation_device('g',link['key'],'B'*43)
 def test_simultaneous_first_open_has_exactly_one_owner(self):
  link=self.db.guest_link('wedding','g');barrier=threading.Barrier(2)
  def claim(device):
   db=server.Database(self.tmp.name);barrier.wait()
   try:db.bind_invitation_device('g',link['key'],device);return True
   except server.Denied:return False
  with concurrent.futures.ThreadPoolExecutor(2) as pool:
   results=list(pool.map(claim,['A'*43,'B'*43]))
  self.assertEqual(sum(results),1)
 def test_private_content_denied_without_cookie_and_gate_has_no_content(self):
  for path in ['/api/invite/public','/api/invite/wishes','/api/invite/public-media/portrait-1.jpg']:
   with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(self.origin+path)
   self.assertEqual(error.exception.code,403);error.exception.close()
  for path in ['/invite','/invite.html?open=1','/./invite.html','/%69nvite.html']:
   try:
    with urllib.request.urlopen(self.origin+path) as response:html=response.read().decode()
   except urllib.error.HTTPError as error:
    self.assertEqual(error.code,404);error.close();continue
   self.assertIn('invite-gate.js',html);self.assertNotIn('Revalina Vikasturi',html);self.assertNotIn('<video',html)
  link=self.db.guest_link('wedding','g');self.post('/api/invite/guest',link)
  with self.opener.open(self.origin+'/invite?open=1') as response:self.assertIn('Revalina Vikasturi',response.read().decode())
  with self.opener.open(self.origin+'/api/invite/public') as response:self.assertNotIn('guests',json.load(response))
 def test_version2_route_requires_same_invitation_device(self):
  for path in ['/invitation2','/invitation2/','/invitation2?open=1']:
   with self.opener.open(self.origin+path) as response:
    html=response.read().decode();self.assertIn('invite-gate.js',html);self.assertNotIn('<video',html)
  link=self.db.guest_link('wedding','g');self.post('/api/invite/guest',link)
  with self.opener.open(self.origin+'/invitation2?open=1') as response:
   html=response.read().decode();self.assertIn('/invitation2.css',html);self.assertIn('/invitation2.js',html);self.assertIn('Revalina Vikasturi',html);self.assertIn('pathLength="1"',html)
  with self.opener.open(self.origin+'/invite?open=1') as response:
   html=response.read().decode();self.assertIn('/invite.css',html);self.assertNotIn('/invitation2.css',html)
  with urllib.request.urlopen(self.origin+'/invitation2?open=1') as response:
   self.assertNotIn('Revalina Vikasturi',response.read().decode())

 def test_reset_requires_pin_rotates_link_and_preserves_qr(self):
  with self.db.connect() as c:
   row=c.execute('SELECT state FROM events WHERE id=?',('wedding',)).fetchone();state=json.loads(row[0]);state['pin']=hashlib.sha256(b'wedding:1234').hexdigest();c.execute('UPDATE events SET state=? WHERE id=?',(json.dumps(state),'wedding'))
  old=self.db.guest_link('wedding','g');self.post('/api/invite/guest',old)
  with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/admin/reset-device',{'event':'wedding','guest':'g','pin':'4321'},True)
  self.assertEqual(error.exception.code,403);error.exception.close()
  new=self.post('/api/invite/admin/reset-device',{'event':'wedding','guest':'g','pin':'1234'},True);self.assertNotEqual(new['key'],old['key'])
  with self.assertRaises(ValueError):self.db.invite_guest('g',old['key'])
  self.db.bind_invitation_device('g',new['key'],'C'*43)
  with self.db.connect() as c:self.assertEqual(json.loads(c.execute('SELECT state FROM events').fetchone()[0])['guests'][0]['code'],self.state['guests'][0]['code'])
  self.assertEqual(server.Database(self.tmp.name).guest_link('wedding','g'),new)

if __name__=='__main__':unittest.main()
