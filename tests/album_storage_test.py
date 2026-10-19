import hashlib,http.client,json,os,tempfile,unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit,parse_qs
import album_test,album_split_test
import album,album_storage,migrate_album_s3,album_jobs

ENV={'TEMU_ALBUM_STORAGE':'s3','TEMU_S3_ENDPOINT':'https://kencana.basic.box.cloudeka.id','TEMU_S3_REGION':'kencana','TEMU_S3_BUCKET':'test-wedding','TEMU_S3_ACCESS_KEY':'test-access','TEMU_S3_SECRET_KEY':'private-test-secret'}
PHOTO=b'\xff\xd8\xff'+b'photo'*20
class FakeStore:
    def __init__(self):self.files={};self.deleted=[];self.fail=False;self.prefix='temu-album/';self.multipart={};self.next_upload=0
    key=album_storage.S3Storage.key
    def presign(self,method,key,**options):return 'https://kencana.basic.box.cloudeka.id/test-wedding/'+key+'?signed='+method
    def inspect(self,key):
        if self.fail or key not in self.files:raise album_storage.StorageError('File belum tersedia.')
        data,mime=self.files[key];return len(data),mime,'"'+hashlib.md5(data).hexdigest()+'"',data[:32]
    def copy(self,source,target,etag,size,mime):self.files[target]=self.files[source]
    def delete(self,key):self.deleted.append(key);self.files.pop(key,None)
    def put_file(self,key,path,mime):self.files[key]=(Path(path).read_bytes(),mime)
    def start_multipart(self,key,mime):
        self.next_upload+=1;identifier=str(self.next_upload);self.multipart[identifier]=[key,mime,None];return identifier
    def request(self,method,key,body=b'',headers=None,query=()):
        if self.fail:raise album_storage.StorageError('Temporary storage failure')
        values=dict(query);session=self.multipart[values['uploadId']]
        assert method=='PUT' and session[0]==key and values['partNumber']=='1' and headers['Content-Type']==session[1]
        session[2]=Path(body).read_bytes();return {},b''
    def finish_multipart(self,key,identifier,size):
        if identifier not in self.multipart:return
        target,mime,data=self.multipart[identifier]
        if data is None or len(data)!=size:raise album_storage.StorageError('Incomplete upload')
        self.files[key]=(data,mime);del self.multipart[identifier]
    def abort_multipart(self,key,identifier):self.multipart.pop(identifier,None)
    def clean_multipart(self,key):
        for identifier in list(self.multipart):
            if self.multipart[identifier][0]==key:self.abort_multipart(key,identifier)

class UploadCases:
    def setUp(self):
        self.env=mock.patch.dict(os.environ,ENV);self.env.start();self.store=FakeStore();self.patch=mock.patch.object(album_storage,'S3Storage',return_value=self.store);self.patch.start();self.fixture.setUp(self)
    def tearDown(self):self.fixture.tearDown(self);self.patch.stop();self.env.stop()
    def raw(self,path,method='GET'):
        p=urlsplit(self.origin);conn=http.client.HTTPConnection(p.hostname,p.port)
        try:
            conn.request(method,path,headers={'Cookie':self.cookie,'Origin':self.origin});r=conn.getresponse();return r.status,dict(r.getheaders()),r.read()
        finally:conn.close()
    def ticket(self,body=None):
        return self.request('/api/album/uploads','POST',body or {'name':'Reva','caption':'Happy wedding','mime':'image/jpeg','size':len(PHOTO),'filter':'original'})
    def start(self):
        self.join(self.config());status,_,raw=self.ticket();self.assertEqual(status,200);return json.loads(raw)
    def stage(self,ticket,data=PHOTO,mime='image/jpeg'):
        self.store.files[self.store.key('incoming',ticket['id'],'.jpg')]=(data,mime)
    def finish_ticket(self,ticket):
        result=self.request('/api/album/uploads/'+ticket['id']+'/complete','POST',{'token':ticket['token']})
        if result[0]==202:
            processor=album.Album(self.db_for_media);album_jobs.process_next(processor)
            result=self.request('/api/album/uploads/'+ticket['id']+'/status','POST',{'token':ticket['token']})
            if result[0]==200 and not json.loads(result[2]).get('pending'):return 201,result[1],result[2]
        return result
    def test_staging_is_private_completion_is_idempotent_and_final_bytes_cannot_be_overwritten(self):
        t=self.start();self.assertNotIn('private-test-secret',json.dumps(t));self.stage(t)
        self.assertEqual(json.loads(self.request('/api/album/items')[2])['items'],[])
        self.assertEqual(self.finish_ticket(t)[0],201);self.assertEqual(self.finish_ticket(t)[0],201)
        self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],1)
        with self.db_for_media.connect() as c:final=c.execute('SELECT object_key FROM album_objects WHERE id=?',(t['id'],)).fetchone()[0]
        self.stage(t,b'changed after completion')
        self.assertEqual(self.store.files[final][0],PHOTO)
        status,headers,_=self.raw('/api/album/file/'+t['id']);self.assertEqual(status,307);self.assertIn('/media/',headers['Location'])
        self.assertEqual(self.request('/api/album/upload','PUT',PHOTO,mime='image/jpeg')[0],409)
    def test_lightroom_style_survives_presigned_upload_and_video_style_is_rejected(self):
        self.join(self.config());body={'name':'Guest','caption':'','mime':'image/jpeg','size':len(PHOTO),'filter':'lr-fuji1'}
        status,_,raw=self.ticket(body);self.assertEqual(status,200);ticket=json.loads(raw);self.stage(ticket)
        self.assertEqual(self.finish_ticket(ticket)[0],201);self.assertEqual(json.loads(self.request('/api/album/items')[2])['items'][0]['filter'],'lr-fuji1')
        with self.db_for_media.connect() as c:key=c.execute('SELECT object_key FROM album_objects WHERE id=?',(ticket['id'],)).fetchone()[0]
        self.assertEqual(self.store.files[key][0],PHOTO)
        self.assertEqual(self.ticket({**body,'mime':'video/mp4'})[0],415)
        self.assertEqual(self.ticket({**body,'filter':'lr-unknown'})[0],415)
    def test_relay_preserves_original_and_ticket_and_cannot_overwrite_published_media(self):
        self.join(self.config());status,_,raw=self.ticket({'requestId':'d'*32,'name':'Guest','caption':'','mime':'image/jpeg','size':len(PHOTO),'filter':'film','multipart':True});self.assertEqual(status,200);ticket=json.loads(raw)
        path='/api/album/uploads/'+ticket['id']+'/part';headers={'X-Album-Upload-Token':ticket['token']}
        self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],200)
        self.assertEqual(self.finish_ticket(ticket)[0],201)
        key=self.store.key('media',ticket['id'],'.jpg');self.assertEqual(self.store.files[key][0],PHOTO)
        self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],409)
        self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],1)
        self.assertEqual(list((self.db_for_media.directory/'album-media').glob('.relay-*')),[])
    def test_relay_validates_token_size_type_and_magic_and_releases_capacity_after_storage_error(self):
        self.join(self.config());_,_,raw=self.ticket({'name':'Guest','mime':'image/jpeg','size':len(PHOTO),'multipart':True});ticket=json.loads(raw)
        path='/api/album/uploads/'+ticket['id']+'/part';headers={'X-Album-Upload-Token':ticket['token']}
        self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers={'X-Album-Upload-Token':'wrong'})[0],403)
        self.assertEqual(self.request(path,'PUT',PHOTO+b'changed',mime='image/jpeg',headers=headers)[0],400)
        self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/png',headers=headers)[0],400)
        self.assertEqual(self.request(path,'PUT',b'x'*len(PHOTO),mime='image/jpeg',headers=headers)[0],415)
        target=self.http.RequestHandlerClass.album if self.fixture is album_test.AlbumTests else self.albumhttp.RequestHandlerClass.album
        self.assertTrue(all(target.relay_slots.acquire(False) for _ in range(2)))
        try:self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],429)
        finally:
            for _ in range(2):target.relay_slots.release()
        self.store.fail=True;self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],503)
        self.assertEqual(list((self.db_for_media.directory/'album-media').glob('.relay-*')),[])
        self.store.fail=False;self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],200)
        self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],0)
        self.request('/api/album/uploads/'+ticket['id']+'/cancel','POST',{'token':ticket['token']})
        self.assertEqual(self.request(path,'PUT',PHOTO,mime='image/jpeg',headers=headers)[0],410)
    def test_wrong_size_magic_token_or_unfinished_object_never_enters_gallery(self):
        t=self.start();self.assertEqual(self.finish_ticket(t)[0],200)
        self.assertEqual(self.request('/api/album/uploads/'+t['id']+'/complete','POST',{'token':'wrong'})[0],403)
        self.stage(t,b'<script>'+b'x'*(len(PHOTO)-8))
        with self.db_for_media.connect() as c:c.execute('UPDATE album_jobs SET ready=0')
        self.assertEqual(self.finish_ticket(t)[0],410)
        self.assertEqual(json.loads(self.request('/api/album/info')[2])['count'],0)
        self.assertEqual(json.loads(self.request('/api/album/items')[2])['items'],[])
    def test_pending_quota_expiry_cancellation_and_reset_do_not_allow_stale_completion(self):
        t=self.start()
        with mock.patch.object(album,'MAX_ALBUM',len(PHOTO)):self.assertEqual(self.ticket()[0],413)
        self.stage(t);self.assertEqual(self.request('/api/album/uploads/'+t['id']+'/cancel','POST',{'token':t['token']})[0],200)
        self.stage(t);self.assertEqual(self.finish_ticket(t)[0],410)
        with self.db_for_media.connect() as c:c.execute('UPDATE album_uploads SET expires=0')
        album.Album(self.db_for_media).clean_uploads(self.store)
        self.assertEqual(self.ticket()[0],200);self.assertNotIn(self.store.key('incoming',t['id'],'.jpg'),self.store.files)
    def test_timed_reveal_closed_upload_and_single_delete_still_apply_to_s3(self):
        t=self.start();self.stage(t);self.finish_ticket(t)
        self.config('after','2099-11-21T20:30:00+07:00');self.assertEqual(self.raw('/api/album/file/'+t['id'])[0],403)
        self.config(uploads=False);self.assertEqual(self.ticket()[0],403)
        with self.db_for_media.connect() as c:final=c.execute('SELECT object_key FROM album_objects WHERE id=?',(t['id'],)).fetchone()[0]
        self.assertEqual(self.request('/api/album/admin/items/'+t['id'],'DELETE',admin=True)[0],200)
        self.assertNotIn(final,self.store.files);self.assertEqual(self.raw('/api/album/file/'+t['id'])[0],404)

class LocalS3Tests(UploadCases,unittest.TestCase):
    fixture=album_test.AlbumTests;request=fixture.request;config=fixture.config;join=fixture.join
    @property
    def db_for_media(self):return self.db
class SplitS3Tests(UploadCases,unittest.TestCase):
    fixture=album_split_test.SplitAlbumTests;request=fixture.request;config=fixture.config;join=fixture.join
    @property
    def db_for_media(self):return self.albumdb

class StorageContractTests(unittest.TestCase):
    def test_presigned_part_binds_upload_session_and_part_number(self):
        with mock.patch.dict(os.environ,ENV):
            url=album_storage.S3Storage().presign('PUT','media/test.jpg',mime='image/jpeg',size=300,query=[('uploadId','id/with+symbols'),('partNumber','1')])
            query=parse_qs(urlsplit(url).query);self.assertEqual(query['uploadId'],['id/with+symbols']);self.assertEqual(query['partNumber'],['1'])
    def test_multipart_completion_uses_only_metadata_and_requires_one_full_part(self):
        with mock.patch.dict(os.environ,ENV):
            store=album_storage.S3Storage()
            part=b'<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Part><PartNumber>1</PartNumber><Size>123</Size><ETag>"'+b'a'*32+b'"</ETag></Part></ListPartsResult>'
            with mock.patch.object(store,'request',side_effect=[({},part),({},b'<CompleteMultipartUploadResult/>')]) as request:
                store.finish_multipart('media/test','session',123)
                self.assertEqual([call.args[0] for call in request.call_args_list],['GET','POST']);self.assertLess(len(request.call_args_list[1].kwargs['body']),200)
            with mock.patch.object(store,'request',return_value=({},part)),self.assertRaises(album_storage.StorageError):store.finish_multipart('media/test','session',124)
            with mock.patch.object(store,'request',side_effect=album_storage.StorageError('Object Storage (NoSuchUpload).')):store.finish_multipart('media/test','session',123)
    def test_signed_upload_binds_length_and_mime_without_including_secret(self):
        with mock.patch.dict(os.environ,ENV):
            store=album_storage.S3Storage();url=store.presign('PUT',store.key('incoming','a'*32,'.jpg'),size=300,mime='image/jpeg');query=parse_qs(urlsplit(url).query)
            self.assertEqual(query['X-Amz-SignedHeaders'],['content-length;content-type;host']);self.assertEqual(query['X-Amz-Expires'],['300']);self.assertNotIn(ENV['TEMU_S3_SECRET_KEY'],url)
            self.assertEqual(query['X-Amz-Credential'][0].split('/')[2:4],['kencana','s3'])
    def test_invalid_endpoint_fails_instead_of_silently_storing_on_local_volume(self):
        with mock.patch.dict(os.environ,{**ENV,'TEMU_S3_ENDPOINT':'http://other.example'}),self.assertRaises(album_storage.StorageError):album_storage.S3Storage()
    def test_migration_retains_source_id_and_bytes_and_can_resume(self):
        with tempfile.TemporaryDirectory() as directory,mock.patch.dict(os.environ,ENV):
            db=album_test.server.Database(directory);a=album.Album(db);item='b'*32;path=a.directory/(item+'.jpg');path.write_bytes(PHOTO)
            with db.connect() as c:c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',(item,'Reva','','original','image/jpeg',len(PHOTO),album.stamp()))
            store=FakeStore()
            with mock.patch.object(album_storage,'S3Storage',return_value=store),mock.patch.object(migrate_album_s3,'S3Storage',return_value=store):
                self.assertEqual(migrate_album_s3.migrate(directory)['copied'],1);self.assertEqual(migrate_album_s3.migrate(directory)['copied'],0)
            self.assertEqual(path.read_bytes(),PHOTO);self.assertEqual(store.files[store.key('media',item,'.jpg')][0],PHOTO)

class CopyFallbackTests(unittest.TestCase):
    def test_provider_copy_fallback_checks_exact_bytes_and_removes_temporary_file(self):
        for changed in (False,True):
            with self.subTest(changed=changed),mock.patch.dict(os.environ,ENV):
                store=album_storage.S3Storage();paths=[];saved=[]
                def request(method,key,**options):
                    if method=='PUT':raise album_storage.StorageError('Object Storage belum dapat diakses (RegionNotAvailable).')
                    self.assertEqual(options['headers']['If-Match'],etag);self.assertEqual(options['expected'],len(PHOTO))
                    path=Path(options['output']);path.write_bytes(PHOTO if not changed else b'changed');paths.append(path);return {},b''
                def put(key,path,mime):saved.append(Path(path).read_bytes())
                etag='"'+hashlib.md5(PHOTO).hexdigest()+'"'
                with mock.patch.object(store,'request',side_effect=request),mock.patch.object(store,'put_file',side_effect=put):
                    if changed:
                        with self.assertRaises(album_storage.StorageError):store.copy('incoming','final',etag,len(PHOTO),'image/jpeg')
                    else:store.copy('incoming','final',etag,len(PHOTO),'image/jpeg')
                self.assertEqual(saved,[] if changed else [PHOTO]);self.assertTrue(paths);self.assertFalse(paths[0].exists())

class TemporarySpaceTests(unittest.TestCase):
    def test_parallel_workers_reserve_space_before_downloading_and_release_on_failure(self):
        size=100*1024*1024
        free=128*1024*1024+size+size//2
        with mock.patch.object(album_storage.shutil,'disk_usage',return_value=type('Disk',(),{'free':free})()):
            with self.assertRaisesRegex(RuntimeError,'test failure'):
                with album_storage.temporary_space(size):
                    with self.assertRaises(album_storage.StorageError):
                        with album_storage.temporary_space(size):self.fail('overcommitted disk')
                    raise RuntimeError('test failure')
            self.assertEqual(album_storage._temporary_reserved,0)
            with album_storage.temporary_space(size):self.assertEqual(album_storage._temporary_reserved,size)
        self.assertEqual(album_storage._temporary_reserved,0)
