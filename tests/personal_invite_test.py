import http.cookiejar, concurrent.futures, hashlib, uuid
import os
from pathlib import Path
from unittest import mock
import json, tempfile, threading, unittest, urllib.request, urllib.error
from server_test import server, seed, bootstrap, change

class PersonalInvitationTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=server.Database(self.tmp.name);self.state=seed();self.state['guests'][0]['quota']=2
  self.db.sync({'event':'wedding','operations':[bootstrap(self.state)]})
  self.token='t'*40;self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,self.token,{'127.0.0.1'}))
  self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.origin=f'http://127.0.0.1:{self.http.server_port}';self.opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));self.post('/api/invite/device',{})
 def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
 def post(self,path,data,admin=False,opener=None):
  headers={'Content-Type':'application/json','X-Temu-Invite':'1'}
  if admin:headers['Authorization']='Bearer '+self.token
  req=urllib.request.Request(self.origin+path,data=json.dumps(data).encode(),headers=headers)
  with (opener or self.opener).open(req) as response:return json.load(response)
 def browser(self):
  opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  self.post('/api/invite/device',{},opener=opener);return opener
 def update_guest(self,**fields):
  current=self.db.sync({'event':'wedding','operations':[]})['state'];guest=next(guest for guest in current['guests'] if guest['id']=='g')
  op={'id':str(uuid.uuid4()),'event':'wedding','kind':'change','meta':None,'changes':[{'id':'g','before':guest,'after':{**guest,**fields}}],'logs':[]}
  result=self.db.sync({'event':'wedding','operations':[op]});self.assertTrue(result['results'][0]['ok']);return result['state']
 def test_public_mode_preserves_existing_links_and_original_private_owner(self):
  self.state['pin']=hashlib.sha256(b'wedding:1234').hexdigest()
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  link=self.db.reset_invitation_device('wedding','g','1234');self.post('/api/invite/guest',link)
  with self.db.connect() as c:
   secret=c.execute('SELECT value FROM app_secrets WHERE name=?',('invite-signing',)).fetchone()[0]
   nonce=c.execute('SELECT nonce FROM invitation_link_versions WHERE event=? AND guest=?',('wedding','g')).fetchone()[0]
  self.update_guest(invitationMode='public');second=self.browser();third=self.browser()
  for browser in (second,third):
   self.assertEqual(self.post('/api/invite/guest',link,opener=browser)['guest']['invitationMode'],'public')
   for path in ('/invite?open=1','/invitation2?open=1'):
    with browser.open(self.origin+path) as response:self.assertIn('<video',response.read().decode())
  self.assertEqual(self.post('/api/invite/rsvp',{**link,'status':'attending','count':1},opener=second)['rsvp']['count'],1)
  self.assertEqual(self.post('/api/invite/wish',{**link,'message':'Dari browser kedua'},opener=third)['wish']['message'],'Dari browser kedua')
  restarted=server.Database(self.tmp.name)
  self.assertEqual(restarted.guest_link('wedding','g'),link)
  with restarted.connect() as c:
   self.assertEqual(c.execute('SELECT value FROM app_secrets WHERE name=?',('invite-signing',)).fetchone()[0],secret)
   self.assertEqual(c.execute('SELECT nonce FROM invitation_link_versions WHERE event=? AND guest=?',('wedding','g')).fetchone()[0],nonce)
   self.assertEqual(json.loads(c.execute('SELECT state FROM events').fetchone()[0])['guests'][0]['code'],'qr')
  self.update_guest(invitationMode='private');self.assertEqual(self.db.guest_link('wedding','g'),link)
  self.assertEqual(self.post('/api/invite/guest',link)['guest']['name'],'Tamu Uji')
  for browser in (second,third):
   for path,payload in [('guest',link),('rsvp',{**link,'status':'declined','count':0}),('wish',{**link,'message':'Ditolak'})]:
    with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/'+path,payload,opener=browser)
    self.assertEqual(error.exception.code,403);error.exception.close()
   with self.assertRaises(urllib.error.HTTPError) as error:browser.open(self.origin+'/api/invite/wishes')
   self.assertEqual(error.exception.code,403);error.exception.close()
  self.assertEqual(self.db.invite_guest(**link)['wish']['message'],'Dari browser kedua')
  self.update_guest(invitationMode='public');self.assertEqual(self.db.guest_link('wedding','g'),link)
  self.assertEqual(self.post('/api/invite/guest',link,opener=second)['guest']['name'],'Tamu Uji')
 def test_public_visitors_do_not_claim_an_unowned_private_invitation(self):
  self.update_guest(invitationMode='public');link=self.db.guest_link('wedding','g');second=self.browser()
  self.post('/api/invite/guest',link);self.post('/api/invite/guest',link,opener=second)
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM invitation_devices').fetchone()[0],0)
  self.update_guest(invitationMode='private');owner=self.browser();self.post('/api/invite/guest',link,opener=owner)
  for browser in (self.opener,second):
   with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/guest',link,opener=browser)
   self.assertEqual(error.exception.code,403);error.exception.close()
 def test_public_grants_keep_guest_ceremony_and_media_permissions_scoped(self):
  self.state['event']['date']='2026-11-21'
  self.state['event']['wedding']={'ceremonyTime':'15.30 WIB'}
  self.state['guests'][0]['invitationMode']='public'
  self.state['guests'].append({**self.state['guests'][0],'id':'g2','code':'qr2','name':'Keluarga','akad':'y','invitationMode':'private'})
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  link=self.db.guest_link('wedding','g');info=self.post('/api/invite/guest',link)
  with self.opener.open(self.origin+'/api/invite/public?g=g') as response:self.assertEqual(json.load(response)['event']['wedding']['ceremonyTime'],'Family Only')
  with urllib.request.urlopen(self.origin+info['guest']['calendarPath']) as response:self.assertNotIn('SUMMARY:Akad',response.read().decode())
  with self.assertRaises(urllib.error.HTTPError) as error:self.opener.open(self.origin+'/api/invite/public?g=g2')
  self.assertEqual(error.exception.code,403);error.exception.close()
  self.update_guest(akad='y')
  with self.opener.open(self.origin+'/api/invite/public?g=g') as response:self.assertEqual(json.load(response)['event']['wedding']['ceremonyTime'],'15.30 WIB')
  with urllib.request.urlopen(self.origin+info['guest']['calendarPath']) as response:self.assertIn('SUMMARY:Akad',response.read().decode())
  unclaimed=self.browser()
  with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/guest',{**link,'key':'A'*43},opener=unclaimed)
  self.assertEqual(error.exception.code,400);error.exception.close()
  image=b'\xff\xd8\xffphoto\xff\xd9';directory=Path(self.tmp.name)/'media';directory.mkdir();(directory/'portrait-1.jpg').write_bytes(image)
  with mock.patch.dict(os.environ,{'TEMU_PRIVATE_MEDIA_DIR':str(directory)}):
   with self.opener.open(self.origin+'/api/invite/public-media/portrait-1.jpg') as response:self.assertEqual(response.read(),image)
   for browser in (unclaimed,urllib.request.build_opener()):
    with self.assertRaises(urllib.error.HTTPError) as error:browser.open(self.origin+'/api/invite/public-media/portrait-1.jpg')
    self.assertEqual(error.exception.code,403);error.exception.close()
   self.update_guest(active=False)
   for path in ('/api/invite/public?g=g','/api/invite/wishes','/api/invite/album','/api/invite/public-media/portrait-1.jpg'):
    with self.assertRaises(urllib.error.HTTPError) as error:self.opener.open(self.origin+path)
    self.assertEqual(error.exception.code,403);error.exception.close()
 def test_reset_revokes_public_browsers_and_old_signed_link(self):
  self.state['pin']=hashlib.sha256(b'wedding:1234').hexdigest();self.state['guests'][0]['invitationMode']='public'
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  old=self.db.guest_link('wedding','g');second=self.browser()
  for browser in (self.opener,second):self.post('/api/invite/guest',old,opener=browser)
  self.post('/api/invite/wish',{**old,'message':'Tetap tersimpan'})
  new=self.post('/api/invite/admin/reset-device',{'event':'wedding','guest':'g','pin':'1234'},True)
  self.assertNotEqual(new['key'],old['key'])
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM invitation_public_devices').fetchone()[0],0)
  for browser in (self.opener,second):
   with self.assertRaises(urllib.error.HTTPError) as error:browser.open(self.origin+'/api/invite/wishes')
   self.assertEqual(error.exception.code,403);error.exception.close()
   with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/guest',old,opener=browser)
   self.assertEqual(error.exception.code,400);error.exception.close()
   self.assertEqual(self.post('/api/invite/guest',new,opener=browser)['wish']['message'],'Tetap tersimpan')
 def test_binding_rechecks_activity_after_waiting_for_the_write_transaction(self):
  link=self.db.guest_link('wedding','g');other=server.Database(self.tmp.name);connect=self.db.connect;changed=False
  def racing_connect():
   connection=connect()
   def before_transaction(sql):
    nonlocal changed
    if sql=='BEGIN IMMEDIATE' and not changed:
     changed=True;current=other.sync({'event':'wedding','operations':[]})['state'];op=change(current,0);op['changes'][0]['after']['active']=False
     other.sync({'event':'wedding','operations':[op]})
   connection.set_trace_callback(before_transaction);return connection
  with mock.patch.object(self.db,'connect',side_effect=racing_connect):
   with self.assertRaises((ValueError,server.Denied)):self.db.bind_invitation_device('g',link['key'],'A'*43)
  self.assertTrue(changed)
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT COUNT(*) FROM invitation_devices').fetchone()[0],0)
 def test_http_writes_recheck_public_access_after_a_concurrent_mode_change(self):
  link=self.db.guest_link('wedding','g');self.post('/api/invite/guest',link);second=self.browser();other=server.Database(self.tmp.name)
  for method,path,payload in [('save_rsvp','rsvp',{'status':'attending','count':1}),('save_wish','wish',{'message':'Terlambat'})]:
   with self.subTest(path=path):
    self.update_guest(invitationMode='public');self.post('/api/invite/guest',link,opener=second);save=getattr(self.db,method)
    def change_then_save(*args,**kwargs):
     current=other.sync({'event':'wedding','operations':[]})['state'];op=change(current,0);op['changes'][0]['after']['invitationMode']='private'
     other.sync({'event':'wedding','operations':[op]});return save(*args,**kwargs)
    with mock.patch.object(self.db,method,side_effect=change_then_save):
     with self.assertRaises(urllib.error.HTTPError) as error:self.post('/api/invite/'+path,{**link,**payload},opener=second)
     self.assertEqual(error.exception.code,403);error.exception.close()
  info=self.db.invite_guest(**link);self.assertIsNone(info['rsvp']);self.assertIsNone(info['wish'])
 def test_unique_link_rsvp_wish_and_overview(self):
  link=self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True)
  self.assertEqual(len(link['key']),43);self.assertEqual(link,self.post('/api/invite/admin/link',{'event':'wedding','guest':'g'},True))
  guest=self.post('/api/invite/guest',link);self.assertEqual({k:guest['guest'][k] for k in ('name','quota')},{'name':'Tamu Uji','quota':2});self.assertEqual(guest['guest']['akad'],'n');self.assertEqual(json.loads(guest['guest']['qr']),{'v':1,'event':'wedding','code':'qr'});self.assertIsNone(guest['rsvp'])
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

 def test_guest_schedule_and_calendar_are_scoped_and_updated(self):
  state=seed();state['event']['date']='2026-11-21';state['event']['wedding']={'ceremonyTime':'15.30 WIB - 17.00 WIB','receptionTime':'18.30 WIB - 20.30 WIB','giftBank':'Bank Uji','giftAccount':'00123','giftName':'Contoh'}
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(state),))
  link=self.db.guest_link('wedding','g');info=self.post('/api/invite/guest',link)
  with self.opener.open(self.origin+'/api/invite/public?g=g') as response:details=json.load(response)['event']['wedding']
  self.assertEqual(details['ceremonyTime'],'Family Only');self.assertTrue(all(key not in details for key in ('giftBank','giftAccount','giftName')))
  with self.opener.open(self.origin+'/invitation2?open=1') as response:html=response.read().decode()
  for value in ['4380170260','Revalina Vikasturi','1230010313163','Cesar Tribuana Putra']:self.assertIn(value,html)
  self.assertNotIn('00123',html);self.assertNotIn('Bank Uji',html)
  with urllib.request.urlopen(self.origin+info['guest']['calendarPath']) as response:calendar=response.read().decode()
  self.assertNotIn('SUMMARY:Akad',calendar);self.assertIn('DTSTART:20261121T113000Z',calendar)
  with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(self.origin+info['guest']['calendarPath']+'tampered')
  self.assertEqual(error.exception.code,403);error.exception.close()
  state['guests'][0]['akad']='y'
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(state),))
  with self.opener.open(self.origin+'/api/invite/public?g=g') as response:details=json.load(response)['event']['wedding']
  self.assertEqual(details['ceremonyTime'],'15.30 WIB - 17.00 WIB')
  with urllib.request.urlopen(self.origin+info['guest']['calendarPath']) as response:calendar=response.read().decode()
  self.assertIn('SUMMARY:Akad',calendar);self.assertIn('DTSTART:20261121T083000Z',calendar)
  state['guests'][0]['active']=False
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(state),))
  with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(self.origin+info['guest']['calendarPath'])
  self.assertEqual(error.exception.code,403);error.exception.close()

 def test_admin_deletes_one_wish_without_changing_guest_rsvp_or_other_wishes(self):
  self.state['pin']=hashlib.sha256(b'wedding:1234').hexdigest()
  self.state['guests'].append({**self.state['guests'][0],'id':'g2','code':'qr2','name':'Tamu Kedua'})
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  first=self.db.guest_link('wedding','g');second=self.db.guest_link('wedding','g2')
  self.post('/api/invite/guest',first);self.post('/api/invite/rsvp',{**first,'status':'attending','count':2})
  self.post('/api/invite/wish',{**first,'message':'Ucapan pertama'});self.db.save_wish(second['guest'],second['key'],'Ucapan kedua')
  with urllib.request.urlopen(urllib.request.Request(self.origin+'/api/invite/admin/wishes',headers={'Authorization':'Bearer '+self.token})) as response:
   listing=json.load(response);self.assertEqual(response.headers['Cache-Control'],'no-store')
  self.assertEqual(listing['event'],'wedding');self.assertEqual(len(listing['wishes']),2)
  item=next(item for item in listing['wishes'] if item['guest']=='g')
  self.assertEqual(item['name'],'Tamu Uji & Pasangan');self.assertEqual(item['message'],'Ucapan pertama')
  self.assertEqual(self.post('/api/invite/admin/wishes/delete',{'event':'wedding','guest':'g','updated':item['updated'],'pin':'1234'},True),{'ok':True})
  self.assertIsNone(self.post('/api/invite/guest',first)['wish'])
  self.assertEqual(self.db.rsvp_overview('wedding')['summary']['persons'],2)
  with self.db.connect() as c:self.assertEqual(json.loads(c.execute('SELECT state FROM events').fetchone()[0]),self.state)
  self.assertEqual([item['message'] for item in server.Database(self.tmp.name).public_wishes()],['Ucapan kedua'])

 def test_wish_management_rejects_guests_wrong_pin_and_outdated_confirmation(self):
  self.state['pin']=hashlib.sha256(b'wedding:1234').hexdigest()
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  link=self.db.guest_link('wedding','g');self.post('/api/invite/guest',link)
  info=self.post('/api/invite/wish',{**link,'message':'Ucapan lama'})
  payload={'event':'wedding','guest':'g','updated':info['wish']['updated'],'pin':'1234'}
  with self.assertRaises(urllib.error.HTTPError) as failure:self.opener.open(self.origin+'/api/invite/admin/wishes')
  self.assertEqual(failure.exception.code,401);failure.exception.close()
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/admin/wishes/delete',payload)
  self.assertEqual(failure.exception.code,401);failure.exception.close()
  for pin in ('0000','',None):
   with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/admin/wishes/delete',{**payload,'pin':pin},True)
   self.assertEqual(failure.exception.code,403);failure.exception.close()
  self.post('/api/invite/wish',{**link,'message':'Ucapan sudah diperbarui'})
  with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/admin/wishes/delete',payload,True)
  self.assertEqual(failure.exception.code,409);failure.exception.close()
  self.assertEqual(self.db.public_wishes()[0]['message'],'Ucapan sudah diperbarui')
  request=urllib.request.Request(self.origin+'/api/invite/admin/wishes/delete',data=json.dumps(payload).encode(),headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'})
  with self.assertRaises(urllib.error.HTTPError) as failure:self.opener.open(request)
  self.assertEqual(failure.exception.code,403);failure.exception.close()

 def test_wish_deletion_rejects_invalid_identifiers(self):
  self.state['pin']=hashlib.sha256(b'wedding:1234').hexdigest()
  with self.db.connect() as c:c.execute('UPDATE events SET state=?',(json.dumps(self.state),))
  for invalid in ({'event':[]},{'guest':None},{'updated':{}},{'guest':''},{'updated':'x'*201}):
   with self.assertRaises(urllib.error.HTTPError) as failure:self.post('/api/invite/admin/wishes/delete',{'event':'wedding','guest':'g','updated':'2026-10-23T00:00:00Z','pin':'1234',**invalid},True)
   self.assertEqual(failure.exception.code,400);failure.exception.close()



 def test_gallery_upload_is_private_and_rejects_unlisted_names(self):
  image=b'\xff\xd8\xff'+b'photo-test'+b'\xff\xd9'
  directory=Path(self.tmp.name)/'media'
  with mock.patch.dict(os.environ,{'TEMU_PRIVATE_MEDIA_DIR':str(directory)}):
   request=urllib.request.Request(self.origin+'/api/admin/media/gallery-SPW07375.jpg',data=image,method='PUT',headers={'Authorization':'Bearer '+self.token,'X-Temu-Media':'1'})
   with urllib.request.urlopen(request) as response:self.assertTrue(json.load(response)['ok'])
   with self.assertRaises(urllib.error.HTTPError) as denied:urllib.request.urlopen(self.origin+'/api/invite/public-media/gallery-SPW07375.jpg')
   self.assertEqual(denied.exception.code,403);denied.exception.close()
   self.post('/api/invite/guest',self.db.guest_link('wedding','g'))
   with self.opener.open(self.origin+'/api/invite/public-media/gallery-SPW07375.jpg') as response:self.assertEqual(response.read(),image)
   request=urllib.request.Request(self.origin+'/api/admin/media/unknown.jpg',data=image,method='PUT',headers={'Authorization':'Bearer '+self.token,'X-Temu-Media':'1'})
   with self.assertRaises(urllib.error.HTTPError) as denied:urllib.request.urlopen(request)
   self.assertEqual(denied.exception.code,404);denied.exception.close()

if __name__=='__main__':unittest.main()
