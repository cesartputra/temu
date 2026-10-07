import hashlib,importlib.util,json,tempfile,threading,unittest,urllib.request,urllib.error
from pathlib import Path
from unittest import mock
spec=importlib.util.spec_from_file_location('album_server',Path(__file__).resolve().parents[1]/'server/server.py');server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
import album

class AlbumTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.db=server.Database(self.tmp.name);self.token='test-album-admin-key-'+('x'*32)
  self.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(self.db,self.token,{'127.0.0.1','localhost'}));self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start();self.origin='http://127.0.0.1:'+str(self.http.server_port);self.cookie=''
 def tearDown(self):self.http.shutdown();self.http.server_close();self.thread.join();self.tmp.cleanup()
 def request(self,path,method='GET',body=None,admin=False,mime=None,headers=None):
  h={'X-Temu-Album':'1','Origin':self.origin}
  if self.cookie:h['Cookie']=self.cookie
  if admin:h['Authorization']='Bearer '+self.token
  if isinstance(body,dict):body=json.dumps(body).encode();h['Content-Type']='application/json'
  if mime:h['Content-Type']=mime
  h.update(headers or {})
  try:
   with urllib.request.urlopen(urllib.request.Request(self.origin+path,data=body,headers=h,method=method)) as r:
    cookie=r.headers.get('Set-Cookie')
    if cookie:self.cookie=cookie.split(';')[0]
    return r.status,r.headers,r.read()
  except urllib.error.HTTPError as e:
   with e:return e.code,e.headers,e.read()
 def config(self,mode='live',release='',uploads=True):
  status,_,raw=self.request('/api/album/admin','POST',{'title':'Test album','mode':mode,'releaseAt':release,'filter':'film','uploadsOpen':uploads},admin=True);self.assertEqual(status,200);return json.loads(raw)['config']
 def join(self,c):return self.request('/api/album/join','POST',{'key':c['key']})
 def upload(self):
  data=b'\xff\xd8\xff'+b'full-resolution-original'*100+b'\xff\xd9'
  status,_,raw=self.request('/api/album/upload','PUT',data,mime='image/jpeg',headers={'X-Album-Name':'Bayu','X-Album-Filter':'film'});self.assertEqual(status,201);return json.loads(raw)['id'],data
 def test_admin_required_and_qr_stable_after_config_change(self):
  self.assertEqual(self.request('/api/album/admin')[0],401);c=self.config();self.assertEqual(c['key'],self.config('after','2026-11-21T20:30:00+07:00')['key']);self.assertEqual(self.request('/api/album/admin',admin=True)[0],200)
 def test_gate_no_cookie_and_invalid_shared_key(self):
  self.config();self.assertEqual(self.request('/album')[0],200);self.assertEqual(self.request('/api/album/info')[0],403);self.assertEqual(self.request('/api/album/join','POST',{'key':'wrong'})[0],403);self.assertEqual(self.request('/api/invite/album')[0],403)
 def test_full_original_download_and_range_for_video(self):
  c=self.config();self.join(c);item,original=self.upload();status,headers,data=self.request('/api/album/file/'+item+'?download=1');self.assertEqual(status,200);self.assertEqual(data,original);self.assertIn('attachment',headers['Content-Disposition'])
  status,headers,data=self.request('/api/album/file/'+item,headers={'Range':'bytes=2-9'});self.assertEqual(status,206);self.assertEqual(data,original[2:10]);self.assertEqual(headers['Content-Range'],f'bytes 2-9/{len(original)}')
  listed=json.loads(self.request('/api/album/items')[2]);self.assertEqual(listed['items'][0]['filter'],'film');self.assertEqual(listed['items'][0]['name'],'Bayu');self.assertNotIn('key',json.loads(self.request('/api/album/info')[2]))
 def test_timed_reveal_blocks_list_and_direct_download_until_open(self):
  c=self.config('after','2099-11-21T20:30:00+07:00');self.join(c);item,_=self.upload();self.assertFalse(json.loads(self.request('/api/album/info')[2])['revealed']);self.assertEqual(self.request('/api/album/items')[0],403);self.assertEqual(self.request('/api/album/file/'+item)[0],403)
  self.config('after','2000-11-21T20:30:00+07:00');self.assertEqual(self.request('/api/album/items')[0],200);self.assertEqual(self.request('/api/album/file/'+item)[0],200)
 def test_closed_uploads_unsafe_formats_and_cross_origin_rejected(self):
  c=self.config();self.join(c);self.assertEqual(self.request('/api/album/upload','PUT',b'<script>bad</script>',mime='image/jpeg')[0],415)
  self.assertEqual(self.request('/api/album/upload','PUT',b'<script>bad</script>',mime='text/html')[0],415)
  self.assertEqual(self.request('/api/album/upload','PUT',b'\xff\xd8\xff'+b'x'*20,mime='image/jpeg',headers={'Origin':'https://other.example'})[0],403)
  self.config(uploads=False);self.assertEqual(self.request('/api/album/upload','PUT',b'\xff\xd8\xff'+b'x'*20,mime='image/jpeg')[0],403)
 def test_album_survives_restart_and_quota_rejects_before_writing(self):
  c=self.config();self.join(c);item,data=self.upload();a=album.Album(server.Database(self.tmp.name));self.assertEqual(a.config()['key'],c['key']);self.assertEqual(a.list_items(c)['items'][0]['id'],item)
  with mock.patch.object(album,'MAX_ALBUM',len(data)):
   self.assertEqual(self.request('/api/album/upload','PUT',data,mime='image/jpeg')[0],413)
  self.assertEqual(len(list((Path(self.tmp.name)/'album-media').glob('*.jpg'))),1)
 def test_thumbnail_is_private_timed_and_does_not_change_original(self):
  c=self.config();self.join(c);item,original=self.upload();a=album.Album(self.db);thumb=b'\xff\xd8\xff'+b'preview-jpeg'*10+b'\xff\xd9'
  self.assertEqual(self.request('/api/album/thumbnail/'+item,'PUT',thumb,mime='image/jpeg',headers={'X-Album-Thumbnail-Key':'wrong'})[0],403)
  self.assertEqual(self.request('/api/album/thumbnail/'+item,'PUT',thumb,mime='image/jpeg',headers={'X-Album-Thumbnail-Key':a.thumbnail_key(item)})[0],200)
  self.assertEqual(self.request('/api/album/file/'+item+'?thumb=1')[2],thumb)
  self.assertEqual(self.request('/api/album/file/'+item)[2],original)
  self.assertTrue(json.loads(self.request('/api/album/items')[2])['items'][0]['thumbnail'])
  self.config('after','2099-11-21T20:30:00+07:00');self.assertEqual(self.request('/api/album/file/'+item+'?thumb=1')[0],403)
 def test_mp4_upload_and_playback_range(self):
  c=self.config();self.join(c);video=b'\x00\x00\x00\x18ftypmp42'+b'video-original'*100
  status,_,raw=self.request('/api/album/upload','PUT',video,mime='video/mp4');self.assertEqual(status,201);item=json.loads(raw)['id']
  status,headers,content=self.request('/api/album/file/'+item,headers={'Range':'bytes=8-20'});self.assertEqual(status,206);self.assertEqual(content,video[8:21]);self.assertEqual(headers['Content-Type'],'video/mp4')
 def test_offsets_and_config_validation(self):
  c=self.config();self.join(c);self.assertEqual(self.request('/api/album/items?offset=-1')[0],400)
  self.assertEqual(self.request('/api/album/admin','POST',{'title':'x','mode':'after','releaseAt':'2026-11-21T20:30','filter':'film'},admin=True)[0],400)
  self.assertEqual(self.request('/api/album/file/../../secret')[0],404)
 def event_with_pin(self):
  state={'version':1,'event':{'id':'wedding','name':'Reva & Cesar','date':'2026-11-21'},'guests':[],'logs':[],'pin':hashlib.sha256(b'wedding:123456').hexdigest()}
  with self.db.connect() as c:c.execute('INSERT INTO events VALUES(?,?,0,?)',('wedding',json.dumps(state),server.now()))
  return state
 def test_only_manager_can_inspect_and_delete_before_release(self):
  c=self.config('after','2099-11-21T20:30:00+07:00');self.join(c);item,data=self.upload()
  for path in ['/api/album/admin/items','/api/album/admin/file/'+item]:self.assertEqual(self.request(path)[0],401)
  self.assertEqual(self.request('/api/album/admin/items/'+item,'DELETE')[0],401)
  self.assertEqual(self.request('/api/album/admin/items',admin=True)[0],200)
  self.assertEqual(self.request('/api/album/admin/file/'+item,admin=True)[2],data)
  self.assertEqual(self.request('/api/album/admin/items/'+item,'DELETE',admin=True,headers={'Origin':'https://bad.example'})[0],403)
  a=album.Album(self.db);thumb=b'\xff\xd8\xff'+b'x'*20+b'\xff\xd9';self.request('/api/album/thumbnail/'+item,'PUT',thumb,mime='image/jpeg',headers={'X-Album-Thumbnail-Key':a.thumbnail_key(item)})
  self.assertEqual(self.request('/api/album/admin/items/'+item,'DELETE',admin=True)[0],200)
  self.assertEqual(self.request('/api/album/admin/file/'+item,admin=True)[0],404)
  self.assertFalse(list(a.directory.glob('*.jpg')))
  self.assertEqual(self.request('/api/album/thumbnail/'+item,'PUT',thumb,mime='image/jpeg',headers={'X-Album-Thumbnail-Key':a.thumbnail_key(item)})[0],404)
  self.assertEqual(self.config()['key'],c['key'])
 def test_reset_checks_pin_and_snapshot_preserves_event_and_qr(self):
  state=self.event_with_pin();c=self.config();self.join(c);self.upload();self.upload()
  body={'event':'wedding','pin':'123456','count':2}
  self.assertEqual(self.request('/api/album/admin/items','DELETE',body)[0],401)
  self.assertEqual(self.request('/api/album/admin/items','DELETE',{**body,'pin':'654321'},admin=True)[0],403)
  self.assertEqual(self.request('/api/album/admin/items','DELETE',{**body,'count':1},admin=True)[0],409)
  self.assertEqual(len(json.loads(self.request('/api/album/items')[2])['items']),2)
  status,_,raw=self.request('/api/album/admin/items','DELETE',body,admin=True);self.assertEqual(status,200);self.assertEqual(json.loads(raw)['removed'],2)
  self.assertEqual(json.loads(self.request('/api/album/items')[2])['items'],[])
  self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],0)
  self.assertEqual(album.Album(self.db).config()['key'],c['key'])
  self.assertEqual(list((Path(self.tmp.name)/'album-media').iterdir()),[])
  with self.db.connect() as connection:self.assertEqual(json.loads(connection.execute('SELECT state FROM events WHERE id=?',('wedding',)).fetchone()[0]),state)
  self.upload();self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],1)
if __name__=='__main__':unittest.main()
