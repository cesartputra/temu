import copy,http.cookiejar,json,os,sqlite3,tempfile,threading,unittest,urllib.request,urllib.error,subprocess,sys
from pathlib import Path
from http.cookiejar import CookieJar
from unittest import mock
from server_test import server,seed,bootstrap,change
from guest_access import GuestAccess,Denied,digest
class GuestAccessTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.db=server.Database(self.temp.name);self.state=seed();self.state['guests'][0]['phone']='6281234567890';self.db.sync({'event':'wedding','operations':[bootstrap(self.state)]});self.access=GuestAccess(self.db)
 def tearDown(self):self.temp.cleanup()
 def issue(self):return self.access.issue('wedding','g')
 def cookie(self,issued):return 'temu_guest='+self.access.unlock(issued['link'],issued['code'],'127.0.0.1')
 def test_link_without_code_cannot_unlock(self):
  issued=self.issue();wrong='11111111' if issued['code']!='11111111' else '22222222';self.assertRaises(Denied,self.access.unlock,issued['link'],wrong,'a');self.assertRaises(Denied,self.access.session,'')
 def test_valid_guest_sees_only_own_qr_and_not_admin_fields(self):
  data=self.access.session(self.cookie(self.issue()));self.assertEqual(data['guest']['code'],'qr');self.assertEqual(data['guest']['name'],'Tamu Uji');self.assertNotIn('pin',data);self.assertNotIn('phone',data['guest']);self.assertNotIn('guests',data)
 def test_plaintext_credentials_not_stored(self):
  issued=self.issue()
  with self.db.connect() as c:row=c.execute('SELECT link_hash,code_hash FROM invitation_access').fetchone()
  self.assertNotEqual(row[0],issued['link']);self.assertNotEqual(row[1],issued['code'])
 def test_five_failed_attempts_block_even_correct_code(self):
  issued=self.issue();wrong='11111111' if issued['code']!='11111111' else '22222222'
  for _ in range(5):self.assertRaises(Denied,self.access.unlock,issued['link'],wrong,'a')
  self.assertRaises(Denied,self.access.unlock,issued['link'],issued['code'],'a')
 def test_rotation_and_revocation_invalidate_existing_sessions(self):
  cookie=self.cookie(self.issue());new=self.issue();self.assertRaises(Denied,self.access.session,cookie);cookie=self.cookie(new);self.access.revoke('wedding','g');self.assertRaises(Denied,self.access.session,cookie)
 def test_inactive_guest_and_rotated_qr_invalidates_session(self):
  issued=self.issue();cookie=self.cookie(issued);op=change(self.state,0);op['changes'][0]['after']['active']=False;self.db.sync({'event':'wedding','operations':[op]});self.assertRaises(Denied,self.access.session,cookie)
 def test_expired_session_is_denied(self):
  cookie=self.cookie(self.issue())
  with self.db.connect() as c:c.execute('UPDATE invitation_sessions SET expires=0')
  self.assertRaises(Denied,self.access.session,cookie)
 def test_phone_change_invalidates_session(self):
  cookie=self.cookie(self.issue());op=change(self.state,0);op['changes'][0]['after']['phone']='628999999999';self.db.sync({'event':'wedding','operations':[op]});self.assertRaises(Denied,self.access.session,cookie)
 def test_qr_rotation_invalidates_session(self):
  cookie=self.cookie(self.issue());op=change(self.state,0);op['changes'][0]['after']['code']='new-code';self.db.sync({'event':'wedding','operations':[op]});self.assertRaises(Denied,self.access.session,cookie)
 def test_invitation_expiry_and_logout(self):
  issued=self.issue();cookie=self.cookie(issued);self.access.logout(cookie);self.assertRaises(Denied,self.access.session,cookie)
  with self.db.connect() as c:c.execute('UPDATE invitation_access SET expires=0')
  self.assertRaises(Denied,self.access.unlock,issued['link'],issued['code'],'a')
 def test_public_host_disables_automatic_admin_pairing(self):
  http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,'x'*40,{'localhost','127.0.0.1','wedding.example'}));t=threading.Thread(target=http.serve_forever,daemon=True);t.start()
  try:
   req=urllib.request.Request(f'http://127.0.0.1:{http.server_port}/api/local-session',data=b'',headers={'X-Temu-Local':'1'})
   with self.assertRaises(urllib.error.HTTPError) as e:urllib.request.urlopen(req)
   self.assertEqual(e.exception.code,403);e.exception.close()
  finally:http.shutdown();http.server_close();t.join()
 def test_restore_revokes_access_without_changing_source(self):
  self.cookie(self.issue());self.db.backup(force=True);snapshot=sorted(self.db.backup_dir.glob('*.sqlite3'))[-1];target=Path(self.temp.name)/'restored'
  subprocess.run([sys.executable,str(Path(__file__).resolve().parents[1]/'server/restore_backup.py'),str(snapshot),str(target)],check=True,capture_output=True)
  with sqlite3.connect(target/'temu.sqlite3') as c:
   self.assertEqual(c.execute('SELECT count(*) FROM invitation_access WHERE revoked=0').fetchone()[0],0);self.assertEqual(c.execute('SELECT count(*) FROM invitation_sessions').fetchone()[0],0)
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM invitation_access WHERE revoked=0').fetchone()[0],1)
 def test_guest_cannot_fetch_media_or_admin_data_without_valid_session(self):
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));t=threading.Thread(target=http.serve_forever,daemon=True);t.start();url=f'http://127.0.0.1:{http.server_port}'
  opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(__import__('http.cookiejar',fromlist=['CookieJar']).CookieJar()))
  def request(path,data=None,headers=None,method=None):return opener.open(urllib.request.Request(url+path,data=json.dumps(data).encode() if data is not None else None,headers=headers or {},method=method))
  try:
   for path in ['/api/invite/view','/api/invite/media/portrait-1.jpg','/api/invite/media/film.mp4','/api/events']:
    with self.assertRaises(urllib.error.HTTPError) as e:request(path)
    self.assertEqual(e.exception.code,401);e.exception.close()
   with self.assertRaises(urllib.error.HTTPError) as e:request('/api/invite/media/film.mp4',method='HEAD')
   self.assertEqual(e.exception.code,401);e.exception.close()
   with self.assertRaises(urllib.error.HTTPError) as e:request('/private-media/portrait-1.jpg')
   self.assertEqual(e.exception.code,404);e.exception.close()
   issued=self.issue()
   with request('/api/invite/unlock',{'link':issued['link'],'code':issued['code']},{'X-Temu-Invite':'1'}) as r:
    self.assertIn('HttpOnly',r.headers['Set-Cookie']);self.assertIn('SameSite=Strict',r.headers['Set-Cookie']);self.assertEqual(json.load(r),{'ok':True})
   with request('/api/invite/view?guest=someone-else') as r:self.assertEqual(json.load(r)['guest']['name'],'Tamu Uji');self.assertIn('no-store',r.headers['Cache-Control'])
   with request('/api/invite/media/portrait-1.jpg',headers={'Range':'bytes=0-99'}) as r:self.assertEqual(r.status,206);self.assertEqual(len(r.read()),100);self.assertIn('no-store',r.headers['Cache-Control'])
   with self.assertRaises(urllib.error.HTTPError) as e:request('/api/invite/admin/issue',{'event':'wedding','guest':'g'},{'X-Temu-Invite':'1'})
   self.assertEqual(e.exception.code,401);e.exception.close()
   with self.assertRaises(urllib.error.HTTPError) as e:request('/api/invite/logout',{}, {'X-Temu-Invite':'1','Origin':'https://evil.example'})
   self.assertEqual(e.exception.code,403);e.exception.close()
   self.access.revoke('wedding','g')
   with self.assertRaises(urllib.error.HTTPError) as e:request('/api/invite/media/portrait-1.jpg')
   self.assertEqual(e.exception.code,401);e.exception.close()
  finally:http.shutdown();http.server_close();t.join()
 def test_private_media_upload_requires_admin_and_guest_session(self):
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{http.server_port}';media=b'\xff\xd8\xff'+b'0'*12+b'\xff\xd9'
  target=Path(self.temp.name)/'private-media'
  try:
   with mock.patch.dict(os.environ,{'TEMU_PRIVATE_MEDIA_DIR':str(target)}):
    req=urllib.request.Request(url+'/api/admin/media/portrait-1.jpg',data=media,headers={'X-Temu-Media':'1'},method='PUT')
    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(req)
    self.assertEqual(error.exception.code,401);error.exception.close();self.assertFalse(target.exists())
    req.add_header('Authorization','Bearer '+token)
    with urllib.request.urlopen(req) as response:self.assertEqual(json.load(response)['bytes'],len(media))
    self.assertEqual((target/'portrait-1.jpg').read_bytes(),media)
    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(url+'/api/invite/media/portrait-1.jpg')
    self.assertEqual(error.exception.code,401);error.exception.close()
    issued=self.issue();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    unlock=urllib.request.Request(url+'/api/invite/unlock',data=json.dumps({'link':issued['link'],'code':issued['code']}).encode(),headers={'X-Temu-Invite':'1'})
    with opener.open(unlock) as response:self.assertEqual(response.status,200)
    with opener.open(url+'/api/invite/media/portrait-1.jpg') as response:self.assertEqual(response.read(),media)
  finally:http.shutdown();http.server_close();thread.join()
 def test_public_invitation_exposes_event_and_media_without_guest_data(self):
  token='a'*40;http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,token,{'127.0.0.1'}));thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start();url=f'http://127.0.0.1:{http.server_port}'
  target=Path(self.temp.name)/'public-media';target.mkdir();song=b'ID3'+b'0'*20;(target/'song.mp3').write_bytes(song)
  try:
   with mock.patch.dict(os.environ,{'TEMU_PRIVATE_MEDIA_DIR':str(target)}):
    with urllib.request.urlopen(url+'/api/invite/public') as response:
     payload=json.load(response);self.assertEqual(payload['event']['name'],self.state['event']['name']);self.assertNotIn('guests',payload);self.assertNotIn('pin',payload);self.assertNotIn('code',json.dumps(payload))
    req=urllib.request.Request(url+'/api/invite/public-media/song.mp3',headers={'Range':'bytes=0-3'})
    with urllib.request.urlopen(req) as response:self.assertEqual(response.status,206);self.assertEqual(response.headers['Content-Type'],'audio/mpeg');self.assertEqual(response.read(),song[:4])
    with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(url+'/api/events')
    self.assertEqual(error.exception.code,401);error.exception.close()
  finally:http.shutdown();http.server_close();thread.join()
if __name__=='__main__':unittest.main()
