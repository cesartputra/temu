import io,json,hashlib,os,tarfile,tempfile,threading,unittest,subprocess,sys
from pathlib import Path
from unittest import mock
import album_test
from album_test import server,album
from album_server import AlbumDatabase,make_album_handler
from album_proxy import internal_target

class SplitAlbumTests(unittest.TestCase):
 request=album_test.AlbumTests.request
 config=album_test.AlbumTests.config
 join=album_test.AlbumTests.join
 upload=album_test.AlbumTests.upload
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();root=Path(self.tmp.name);self.token='test-album-admin-key-'+('x'*32);self.proxy='private-proxy-'+('p'*32);self.cookie=''
  self.db=server.Database(root/'guestbook');self.state={'version':1,'event':{'id':'wedding','name':'Reva & Cesar','date':'2026-11-21'},'guests':[],'logs':[],'pin':hashlib.sha256(b'wedding:123456').hexdigest()}
  with self.db.connect() as c:c.execute('INSERT INTO events VALUES(?,?,0,?)',('wedding',json.dumps(self.state),server.now()))
  self.albumdb=AlbumDatabase(root/'album','http://127.0.0.1:1',self.token)
  self.albumhttp=server.ThreadingHTTPServer(('127.0.0.1',0),make_album_handler(self.albumdb,self.token,self.proxy))
  with mock.patch.dict(os.environ,{'TEMU_ALBUM_UPSTREAM_URL':'http://127.0.0.1:'+str(self.albumhttp.server_port),'TEMU_ALBUM_PROXY_KEY':self.proxy}):handler=server.make_handler(self.db,self.token,{'127.0.0.1','localhost'})
  self.http=server.ThreadingHTTPServer(('127.0.0.1',0),handler);self.albumdb.guestbook=('127.0.0.1',self.http.server_port);self.origin='http://127.0.0.1:'+str(self.http.server_port)
  self.threads=[threading.Thread(target=s.serve_forever,daemon=True) for s in (self.http,self.albumhttp)]
  for t in self.threads:t.start()
 def tearDown(self):
  for s in (self.http,self.albumhttp):s.shutdown();s.server_close()
  for t in self.threads:t.join()
  self.tmp.cleanup()
 def test_separate_storage_and_public_origin_cookie_range(self):
  c=self.config();status,headers,_=self.join(c);self.assertEqual(status,200);self.assertIn('Path=/api/album',headers['Set-Cookie']);item,data=self.upload()
  self.assertFalse((self.db.directory/'album-media').exists());self.assertTrue((self.albumdb.directory/'album-media'/(item+'.jpg')).exists())
  self.assertEqual(self.request('/api/album/file/'+item)[2],data);self.assertEqual(self.request('/api/album/file/'+item,headers={'Range':'bytes=5-14'})[2],data[5:15])
  with self.albumdb.connect() as connection:self.assertEqual(connection.execute('SELECT count(*) FROM events').fetchone()[0],0)
 def test_admin_reset_checks_pin_with_guestbook_without_copying_guests(self):
  c=self.config('after','2099-11-21T20:30:00+07:00');self.join(c);item,_=self.upload()
  self.assertEqual(self.request('/api/album/items')[0],403);self.assertEqual(self.request('/api/album/admin/items',admin=True)[0],200)
  body={'event':'wedding','pin':'654321','count':1};self.assertEqual(self.request('/api/album/admin/items','DELETE',body,admin=True)[0],403)
  body['pin']='123456';self.assertEqual(self.request('/api/album/admin/items','DELETE',body,admin=True)[0],200)
  self.assertEqual(album.Album(self.albumdb).config()['key'],c['key'])
  with self.db.connect() as connection:self.assertEqual(json.loads(connection.execute('SELECT state FROM events').fetchone()[0]),self.state)
 def test_album_outage_does_not_break_guestbook(self):
  self.albumhttp.shutdown();self.albumhttp.server_close()
  self.assertEqual(self.request('/api/album/info')[0],503);self.assertEqual(self.request('/')[0],200);self.assertEqual(self.request('/api/events',admin=True)[0],200)
 def test_gateway_required_even_with_shared_admin_token(self):
  source=self.origin;self.origin='http://127.0.0.1:'+str(self.albumhttp.server_port)
  try:
   self.assertEqual(self.request('/api/album/admin',admin=True)[0],403);self.assertEqual(self.request('/health')[0],200)
  finally:self.origin=source
  self.assertRaises(ValueError,internal_target,'http://public.example.com:8080')
 def migration(self,config,items,files):
  content=io.BytesIO()
  with tarfile.open(fileobj=content,mode='w:') as out:
   for name,value in {'manifest.json':json.dumps({'config':config,'items':items}).encode(),**files}.items():
    member=tarfile.TarInfo(name);member.size=len(value);out.addfile(member,io.BytesIO(value))
  return content.getvalue()
 def test_album_migration_preserves_existing_qr_ids_bytes_and_dates(self):
  config={'key':'k'*43,'mode':'after','filter':'film','uploadsOpen':True,'title':'Old album','releaseAt':'2099-11-21T20:30:00+07:00'};photo=b'\xff\xd8\xff'+b'original-photo'*10+b'\xff\xd9';identifier='a'*32;item={'id':identifier,'name':'Tamu','caption':'Momen','filter':'film','mime':'image/jpeg','size':len(photo),'created':'2026-10-07T01:00:00+00:00'}
  data=self.migration(config,[item],{identifier+'.jpg':photo});headers={'X-Temu-Album-Proxy':self.proxy}
  # Migration is directly internal; not available through the public gateway.
  self.assertEqual(self.request('/api/album/admin/migration','POST',data,admin=True,mime='application/x-tar')[0],404)
  source=self.origin;self.origin='http://127.0.0.1:'+str(self.albumhttp.server_port)
  try:
   self.assertEqual(self.request('/api/album/admin/migration','POST',self.migration(config,[item],{'../wrong.jpg':photo}),admin=True,mime='application/x-tar',headers=headers)[0],400)
   self.assertEqual(self.request('/api/album/admin/migration','POST',data,admin=True,mime='application/x-tar',headers=headers)[0],200)
   self.assertEqual(self.request('/api/album/admin/migration','POST',data,admin=True,mime='application/x-tar',headers=headers)[0],409)
  finally:self.origin=source
  self.assertEqual(album.Album(self.albumdb).config()['key'],config['key']);self.assertEqual(self.request('/api/album/admin/file/'+identifier,admin=True)[2],photo)
  self.assertEqual(json.loads(self.request('/api/album/admin/items',admin=True)[2])['items'][0]['created'],item['created'])
 def test_migration_command_copies_originals_without_removing_source(self):
  source=album.Album(self.db);config=source.configure({'title':'Existing album','mode':'live','filter':'film','uploadsOpen':True})
  identifier='b'*32;photo=b'\xff\xd8\xff'+b'original-camera-bytes'*10+b'\xff\xd9';created='2026-10-07T01:00:00+00:00'
  with self.db.connect() as c:c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',(identifier,'Tamu','Kenangan','film','image/jpeg',len(photo),created))
  (source.directory/(identifier+'.jpg')).write_bytes(photo)
  environment={**os.environ,'TEMU_SERVER_TOKEN':self.token,'TEMU_ALBUM_PROXY_KEY':self.proxy,'TEMU_ALBUM_UPSTREAM_URL':'http://127.0.0.1:'+str(self.albumhttp.server_port)}
  command=[sys.executable,str(Path(server.__file__).with_name('migrate_album.py')),'--data-dir',str(self.db.directory)]
  result=subprocess.run(command,env=environment,capture_output=True,text=True,timeout=15)
  self.assertEqual(result.returncode,0,result.stderr);self.assertIn('Album migrated: 1 items',result.stdout)
  self.assertEqual(album.Album(self.albumdb).config()['key'],config['key'])
  self.assertEqual(self.request('/api/album/admin/file/'+identifier,admin=True)[2],photo)
  self.assertEqual((source.directory/(identifier+'.jpg')).read_bytes(),photo)
  self.assertEqual(source.config()['key'],config['key'])
if __name__=='__main__':unittest.main()
