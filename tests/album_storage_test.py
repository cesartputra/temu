import concurrent.futures,hashlib,http.client,json,os,socket,tempfile,threading,time,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
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
    def request(self,method,key,body=b'',headers=None,query=(),output=None,expected=None):
        if self.fail:raise album_storage.StorageError('Temporary storage failure')
        if method=='GET' and output is not None:
            data,mime=self.files[key];assert len(data)==expected;Path(output).write_bytes(data);return {},b''
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
    def test_s3_head_returns_selected_object_metadata_without_redirect_or_body(self):
        ticket=self.start();self.stage(ticket);self.finish_ticket(ticket)
        with mock.patch.object(self.store,'inspect',side_effect=AssertionError('published original metadata is already in SQLite')):
            status,headers,body=self.raw('/api/album/file/'+ticket['id'],'HEAD')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Type'],'image/jpeg');self.assertEqual(headers['Content-Length'],str(len(PHOTO)));self.assertNotIn('Location',headers);self.assertEqual(body,b'')
        thumb=self.store.key('thumbnails',ticket['id'],'.jpg');self.store.files[thumb]=(PHOTO[:20],'image/jpeg')
        with self.db_for_media.connect() as c:c.execute('UPDATE album_objects SET thumbnail_key=? WHERE id=?',(thumb,ticket['id']))
        status,headers,body=self.raw('/api/album/file/'+ticket['id']+'?thumb=1','HEAD')
        self.assertEqual(status,200);self.assertEqual(headers['Content-Length'],'20');self.assertEqual(body,b'');self.assertNotIn('Location',headers)
        status,headers,body=self.raw('/api/album/file/'+ticket['id']+'?download=1','HEAD')
        self.assertEqual(status,200);self.assertIn('attachment;',headers['Content-Disposition']);self.assertEqual(headers['Content-Length'],str(len(PHOTO)))
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
    def test_inspect_uses_one_bounded_range_get_with_full_object_size(self):
        for size,headers in ((1000,{'content-range':'bytes 0-31/1000','content-length':'32'}),(16,{'content-range':'bytes 0-15/16','content-length':'16'}),(1000,{'content-length':'1000'})):
            with self.subTest(size=size,headers=headers),mock.patch.dict(os.environ,ENV):
                store=album_storage.S3Storage();head=b'x'*min(32,size)
                with mock.patch.object(store,'request',return_value=({**headers,'content-type':'image/jpeg; charset=binary','etag':'test-etag'},head)) as request:
                    self.assertEqual(store.inspect('media/test.jpg'),(size,'image/jpeg','test-etag',head))
                    request.assert_called_once_with('GET','media/test.jpg',headers={'Range':'bytes=0-31'},limit=32)
    def test_inspect_rejects_malformed_or_inconsistent_range_metadata(self):
        for headers in ({'content-range':'invalid','content-length':'32'},{'content-range':'bytes 1-32/1000'},{'content-range':'bytes 0-15/1000'},{'content-range':'bytes 0-31/12'},{'content-length':'invalid'},{}):
            with self.subTest(headers=headers),mock.patch.dict(os.environ,ENV):
                store=album_storage.S3Storage()
                with mock.patch.object(store,'request',return_value=(headers,b'x'*32)),self.assertRaises(album_storage.StorageError):store.inspect('media/test.jpg')
    def test_domainesia_presigned_upload_keeps_path_style_signature_and_multipart_parameters(self):
        with mock.patch.dict(os.environ,{**ENV,'TEMU_S3_ENDPOINT':'https://s3.nevaobjects.id','TEMU_S3_REGION':'us-east-1'}):
            store=album_storage.S3Storage();key=store.key('media','d'*32,'.jpg')
            url=store.presign('PUT',key,mime='image/jpeg',size=300,query=[('uploadId','test-session'),('partNumber','1')])
            parsed=urlsplit(url);query=parse_qs(parsed.query)
            self.assertEqual(parsed.netloc,'s3.nevaobjects.id');self.assertEqual(parsed.path,'/test-wedding/'+key)
            self.assertEqual(query['X-Amz-Algorithm'],['AWS4-HMAC-SHA256'])
            self.assertEqual(query['X-Amz-Credential'][0].split('/')[2:4],['us-east-1','s3'])
            self.assertEqual(query['X-Amz-SignedHeaders'],['content-length;content-type;host'])
            self.assertEqual(query['uploadId'],['test-session']);self.assertEqual(query['partNumber'],['1'])
            self.assertNotIn(ENV['TEMU_S3_SECRET_KEY'],url)
    def test_domainesia_endpoint_rejects_http_credentials_ports_paths_and_lookalike_hosts(self):
        for endpoint in ('http://s3.nevaobjects.id','https://s3.nevaobjects.id:8443','https://user:pass@s3.nevaobjects.id','https://s3.nevaobjects.id/bucket','https://s3.nevaobjects.id.evil.example','https://s3.nevaobjects.id?target=other','https://s3.nevaobjects.id#other'):
            with self.subTest(endpoint=endpoint),mock.patch.dict(os.environ,{**ENV,'TEMU_S3_ENDPOINT':endpoint}),self.assertRaises(album_storage.StorageError):album_storage.S3Storage()
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

def clear_connection_pools():
    for pool in getattr(album_storage,'_connection_pools',{}).values():
        for connection,_ in pool._idle:connection.close()
    getattr(album_storage,'_connection_pools',{}).clear()

class StorageTransportTests(unittest.TestCase):
    def setUp(self):
        clear_connection_pools();self.addCleanup(clear_connection_pools)
        self.jitter=mock.patch('random.uniform',return_value=0);self.jitter.start();self.addCleanup(self.jitter.stop)
    def test_range_is_sent_but_not_signed_so_gateways_can_normalize_it(self):
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory:
            connection=factory.return_value;connection.sock=None;response=connection.getresponse.return_value
            response.status=206;response.getheaders.return_value=[('Content-Range','bytes 0-31/1000')];response.read1=response.read;response.read.side_effect=[b'x'*32,b'']
            album_storage.S3Storage().request('GET','media/test.jpg',headers={'Range':'bytes=0-31'},limit=32)
            headers={call.args[0]:call.args[1] for call in connection.putheader.call_args_list}
            self.assertEqual(headers['range'],'bytes=0-31');self.assertNotIn(';range',headers['authorization']);self.assertIn('SignedHeaders=host;x-amz-content-sha256;x-amz-date',headers['authorization'])
    def test_empty_multipart_create_omits_content_length_but_signs_empty_payload_and_mime(self):
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory:
            connection=factory.return_value;connection.sock=None;response=connection.getresponse.return_value
            response.status=200;response.getheaders.return_value=[];response.read1=response.read;response.read.side_effect=[b'<InitiateMultipartUploadResult><UploadId>test-upload</UploadId></InitiateMultipartUploadResult>',b'']
            self.assertEqual(album_storage.S3Storage().start_multipart('media/test.jpg','image/jpeg'),'test-upload')
            headers={call.args[0]:call.args[1] for call in connection.putheader.call_args_list}
            self.assertNotIn('content-length',headers);self.assertNotIn('content-length',headers['authorization'])
            self.assertIn('SignedHeaders=cache-control;content-type;host;x-amz-content-sha256;x-amz-date',headers['authorization'])
            self.assertEqual(headers['x-amz-content-sha256'],hashlib.sha256(b'').hexdigest());self.assertEqual(headers['content-type'],'image/jpeg');connection.send.assert_not_called()
    def test_nonempty_backend_upload_retains_signed_length_hash_and_exact_bytes(self):
        for method in ('PUT','POST'):
            with self.subTest(method=method),mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory:
                connection=factory.return_value;connection.sock=None;response=connection.getresponse.return_value
                response.status=200;response.getheaders.return_value=[];response.read1=response.read;response.read.side_effect=[b'ok',b'']
                album_storage.S3Storage().request(method,'media/test.jpg',PHOTO,{'Content-Type':'image/jpeg'})
                headers={call.args[0]:call.args[1] for call in connection.putheader.call_args_list}
                self.assertEqual(headers['content-length'],str(len(PHOTO)));self.assertIn('SignedHeaders=content-length;',headers['authorization'])
                self.assertEqual(headers['x-amz-content-sha256'],hashlib.sha256(PHOTO).hexdigest());connection.send.assert_called_once_with(PHOTO)
    def test_three_originals_retry_second_reset_with_fresh_connections_and_identical_bytes(self):
        attempts={};saved={};connections=[];delays=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_PUT(self):
                data=self.rfile.read(int(self.headers['Content-Length']));attempts[self.path]=attempts.get(self.path,0)+1
                if self.path.endswith('second.jpg') and attempts[self.path]==1:
                    self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
                saved[self.path]=data;self.send_response(200);self.send_header('Content-Length','0');self.end_headers()
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);thread=threading.Thread(target=server.serve_forever);thread.start()
        def connect(host,timeout,context):
            connection=http.client.HTTPConnection(*server.server_address,timeout=timeout);connections.append(connection);return connection
        try:
            with tempfile.TemporaryDirectory() as directory,mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection',side_effect=connect),mock.patch.object(album_storage.time,'sleep',side_effect=delays.append):
                store=album_storage.S3Storage()
                for name in ('first','second','third'):
                    path=Path(directory)/(name+'.jpg');path.write_bytes(PHOTO+name.encode());store.put_file('media/'+name+'.jpg',path,'image/jpeg')
                self.assertEqual(len(saved),3);self.assertEqual(list(attempts.values()),[1,2,1])
                for name in ('first','second','third'):self.assertEqual(saved['/test-wedding/media/'+name+'.jpg'],PHOTO+name.encode())
            self.assertEqual(delays,[.5]);self.assertEqual(len(connections),4);self.assertTrue(all(c.sock is None for c in connections))
        finally:server.shutdown();server.server_close();thread.join()
    def test_transient_transport_failures_are_bounded_and_every_response_is_closed(self):
        for failure in (ConnectionResetError,BrokenPipeError,TimeoutError,http.client.IncompleteRead):
            with self.subTest(failure=failure.__name__),mock.patch.dict(os.environ,ENV):
                response=mock.Mock(status=200);response.getheaders.return_value=[];response.read1=response.read;response.read.side_effect=[b'ok',b'']
                connections=[mock.Mock(),mock.Mock(),mock.Mock()]
                for connection in connections:connection.sock=None;connection.getresponse.return_value=response
                error=failure(b'partial') if failure is http.client.IncompleteRead else failure('transient')
                connections[0].getresponse.side_effect=error;connections[1].getresponse.side_effect=error
                with mock.patch.object(album_storage.http.client,'HTTPSConnection',side_effect=connections),mock.patch.object(album_storage.time,'sleep') as sleep:
                    self.assertEqual(album_storage.S3Storage().request('GET','media/test')[1],b'ok')
                self.assertEqual([call.args[0] for call in sleep.call_args_list],[.5,1.0]);self.assertTrue(all(c.close.call_count==1 for c in connections));response.close.assert_called_once()
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory,mock.patch.object(album_storage.time,'sleep') as sleep:
            factory.return_value.getresponse.side_effect=ConnectionResetError('persistent')
            with self.assertRaises(album_storage.StorageError):album_storage.S3Storage().request('PUT','media/test',b'original')
            self.assertEqual(factory.call_count,3);self.assertEqual(factory.return_value.close.call_count,3);self.assertEqual(sleep.call_count,2)
    def test_permission_errors_and_ambiguous_multipart_creation_are_not_blindly_retried(self):
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory,mock.patch.object(album_storage.time,'sleep') as sleep:
            connection=factory.return_value;connection.sock=None;response=connection.getresponse.return_value;response.status=403;response.getheaders.return_value=[];response.read1=response.read;response.read.side_effect=[b'<Error><Code>AccessDenied</Code></Error>',b'']
            with self.assertRaisesRegex(album_storage.StorageError,'AccessDenied'):album_storage.S3Storage().request('PUT','media/test',b'original')
            self.assertEqual(factory.call_count,1);response.close.assert_called_once();sleep.assert_not_called()
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory,mock.patch.object(album_storage.time,'sleep') as sleep:
            factory.return_value.getresponse.side_effect=ConnectionResetError('response lost')
            with self.assertRaises(album_storage.StorageError):album_storage.S3Storage().start_multipart('media/test','image/jpeg')
            self.assertEqual(factory.call_count,1);factory.return_value.close.assert_called_once();sleep.assert_not_called()
    def test_interrupted_download_is_restarted_without_appending_partial_bytes(self):
        responses=[mock.Mock(status=200),mock.Mock(status=200)];connections=[mock.Mock(),mock.Mock()]
        for connection,response in zip(connections,responses):
            connection.sock=None;connection.getresponse.return_value=response;response.getheaders.return_value=[('Content-Length',str(len(PHOTO)))];response.read1=response.read;response.read.side_effect=[PHOTO,b'']
        responses[0].read.side_effect=[PHOTO[:10],b'']
        with tempfile.TemporaryDirectory() as directory,mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection',side_effect=connections),mock.patch.object(album_storage.time,'sleep') as sleep:
            target=Path(directory)/'original.jpg';album_storage.S3Storage().request('GET','media/test',output=target,expected=len(PHOTO))
            self.assertEqual(target.read_bytes(),PHOTO);sleep.assert_called_once_with(.5)
        self.assertTrue(all(r.close.call_count==1 for r in responses));self.assertTrue(all(c.close.call_count==1 for c in connections))
    def test_retries_do_not_extend_the_overall_storage_budget(self):
        elapsed=[0]
        def reset():elapsed[0]=119.75;raise ConnectionResetError('response lost')
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory,mock.patch.object(album_storage.time,'sleep') as sleep,mock.patch.object(album_storage.time,'monotonic',side_effect=lambda:elapsed[0]):
            factory.return_value.getresponse.side_effect=reset
            with self.assertRaises(album_storage.StorageError):album_storage.S3Storage().request('HEAD','media/test')
            self.assertEqual(factory.call_count,1);sleep.assert_not_called()
    def test_response_read_cannot_finish_after_the_overall_deadline(self):
        elapsed=[0]
        def read(amount):elapsed[0]=121;return b'ok'
        with mock.patch.dict(os.environ,ENV),mock.patch.object(album_storage.http.client,'HTTPSConnection') as factory,mock.patch.object(album_storage.time,'monotonic',side_effect=lambda:elapsed[0]):
            connection=factory.return_value;connection.sock=None;response=connection.getresponse.return_value
            response.status=200;response.getheaders.return_value=[];response.read1.side_effect=read;response.read.side_effect=read
            with self.assertRaises(album_storage.StorageError):album_storage.S3Storage().request('GET','media/test',limit=2)
            connection.close.assert_called_once()

class StoragePoolTests(unittest.TestCase):
    def setUp(self):
        clear_connection_pools();self.connections=[];self.requests=[];self.lock=threading.Lock()
        self.behavior=lambda handler,method,body:self.reply(handler,b'ok')
        owner=self
        class Handler(BaseHTTPRequestHandler):
            protocol_version='HTTP/1.1'
            def log_message(self,*args):pass
            def handle(self):
                try:super().handle()
                except (BrokenPipeError,ConnectionResetError):pass
            def run_request(self):
                body=self.rfile.read(int(self.headers.get('Content-Length','0')))
                with owner.lock:owner.requests.append((self.command,self.path,body,self.client_address))
                owner.behavior(self,self.command,body)
            do_GET=do_HEAD=do_PUT=do_POST=do_DELETE=run_request
        class Server(ThreadingHTTPServer):request_queue_size=128
        self.server=Server(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.01));self.thread.start()
        def connect(host,timeout,context):
            self.assertTrue(context.check_hostname);self.assertEqual(context.verify_mode,album_storage.ssl.CERT_REQUIRED)
            self.assertGreater(timeout,0);self.assertLessEqual(timeout,10)
            connection=http.client.HTTPConnection(*self.server.server_address,timeout=timeout)
            self.connections.append(connection);return connection
        self.env=mock.patch.dict(os.environ,ENV);self.env.start()
        self.factory=mock.patch.object(album_storage.http.client,'HTTPSConnection',side_effect=connect);self.factory.start()
        self.jitter=mock.patch('random.uniform',return_value=0);self.jitter.start()
    def tearDown(self):
        clear_connection_pools();self.jitter.stop();self.factory.stop();self.env.stop()
        self.server.shutdown();self.server.server_close();self.thread.join()
    def reply(self,handler,body=b'',status=200,headers=()):
        handler.send_response(status);handler.send_header('Content-Length',str(len(body)))
        for key,value in headers:handler.send_header(key,value)
        handler.end_headers()
        if handler.command!='HEAD':
            try:handler.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass
    def test_separate_clients_reuse_one_verified_keepalive_connection(self):
        first=album_storage.S3Storage();second=album_storage.S3Storage()
        for store in (first,second,first):self.assertEqual(store.request('GET','media/test')[1],b'ok')
        self.assertEqual(len(self.connections),1);self.assertEqual(len(set(r[3] for r in self.requests)),1)
        self.assertTrue(self.connections[0].sock.getsockopt(socket.SOL_SOCKET,socket.SO_KEEPALIVE))
        self.assertEqual(self.connections[0].sock.gettimeout(),60)
    def test_idle_pool_cleanup_closes_sockets_and_allows_subsequent_requests(self):
        store=album_storage.S3Storage();store.request('GET','media/first')
        connection=self.connections[0];album_storage._close_idle_connections()
        self.assertIsNone(connection.sock)
        self.assertEqual(store.request('GET','media/second')[1],b'ok');self.assertEqual(len(self.connections),2)
    def test_unread_prefix_is_discarded_before_the_next_request(self):
        self.behavior=lambda handler,method,body:self.reply(handler,b'x'*1000 if handler.path.endswith('large') else b'ok')
        store=album_storage.S3Storage()
        self.assertEqual(store.request('GET','media/large',limit=32)[1],b'x'*32)
        self.assertEqual(store.request('GET','media/small')[1],b'ok')
        self.assertEqual(len(self.connections),2);self.assertIsNone(self.connections[0].sock)
    def test_retryable_http_statuses_retry_but_multipart_post_is_never_replayed(self):
        statuses=iter((429,503,200))
        def respond(handler,method,body):
            status=next(statuses);self.reply(handler,b'ok' if status==200 else b'<Error><Code>SlowDown</Code></Error>',status)
        self.behavior=respond
        with mock.patch.object(album_storage.time,'sleep') as sleep:
            self.assertEqual(album_storage.S3Storage().request('PUT','media/test',PHOTO)[1],b'ok')
        self.assertEqual([r[2] for r in self.requests],[PHOTO,PHOTO,PHOTO]);self.assertEqual(sleep.call_count,2)
        self.behavior=lambda handler,method,body:self.reply(handler,b'<Error><Code>SlowDown</Code></Error>',503)
        with mock.patch.object(album_storage.time,'sleep') as sleep,self.assertRaises(album_storage.StorageError):
            album_storage.S3Storage().request('POST','media/test',query=[('uploads','')])
        self.assertEqual(len(self.requests),4);sleep.assert_not_called()
    def test_idle_socket_age_eviction_and_server_close_recover_without_leaking_a_lease(self):
        store=album_storage.S3Storage();self.assertEqual(store.request('GET','media/first')[1],b'ok')
        pool=next(iter(album_storage._connection_pools.values()))
        connection,_=pool._idle[-1];pool._idle[-1]=(connection,time.monotonic()-60)
        self.assertEqual(store.request('GET','media/second')[1],b'ok');self.assertIsNone(connection.sock)
        connection=self.connections[-1];connection.sock.shutdown(socket.SHUT_RDWR)
        with mock.patch.object(album_storage.time,'sleep'):
            self.assertEqual(store.request('GET','media/third')[1],b'ok')
        self.assertEqual(len(self.connections),3)
    def test_parallel_requests_share_at_most_32_exclusive_connections(self):
        release=threading.Event();full=threading.Event();active=0;peak=0
        def respond(handler,method,body):
            nonlocal active,peak
            with self.lock:
                active+=1;peak=max(peak,active)
                if active>=32:full.set()
            release.wait(5)
            self.reply(handler,handler.path.rsplit('/',1)[-1].encode())
            with self.lock:active-=1
        self.behavior=respond
        start=threading.Barrier(41)
        def get(index):
            start.wait(5);return album_storage.S3Storage().request('GET','media/'+str(index))[1]
        with concurrent.futures.ThreadPoolExecutor(max_workers=40) as executor:
            futures=[executor.submit(get,index) for index in range(40)]
            try:
                start.wait(5);self.assertTrue(full.wait(5));time.sleep(.1)
                self.assertEqual(peak,32)
            finally:release.set()
            self.assertEqual([future.result(5) for future in futures],[str(i).encode() for i in range(40)])
        self.assertEqual(len(self.connections),32)
    def test_pool_wait_respects_deadline_and_constructor_errors_release_slots(self):
        store=album_storage.S3Storage();pool=store._pool
        for _ in range(32):pool._slots.acquire()
        try:
            started=time.monotonic()
            with self.assertRaises(album_storage.StorageError):pool.acquire(started+.03)
            self.assertLess(time.monotonic()-started,1)
        finally:
            for _ in range(32):pool._slots.release()
        factory=album_storage.http.client.HTTPSConnection;connect=factory.side_effect
        factory.side_effect=ConnectionResetError('connection unavailable')
        try:
            for _ in range(33):
                with self.assertRaises(album_storage.StorageError):store.request('POST','media/test')
        finally:factory.side_effect=connect
        self.assertEqual(store.request('GET','media/test')[1],b'ok')
    def test_stream_truncation_retries_into_a_clean_file(self):
        attempts=0
        def respond(handler,method,body):
            nonlocal attempts
            attempts+=1
            if attempts==1:
                handler.send_response(200);handler.send_header('Content-Length',str(len(PHOTO)));handler.end_headers()
                handler.wfile.write(PHOTO[:10]);handler.wfile.flush();handler.close_connection=True
                handler.connection.shutdown(socket.SHUT_RDWR);handler.connection.close()
            else:self.reply(handler,PHOTO)
        self.behavior=respond
        with tempfile.TemporaryDirectory() as directory,mock.patch.object(album_storage.time,'sleep'):
            path=Path(directory)/'original';path.write_bytes(b'old bytes'*50)
            album_storage.S3Storage().request('GET','media/test',output=path,expected=len(PHOTO))
            self.assertEqual(path.read_bytes(),PHOTO)
        self.assertEqual(attempts,2);self.assertEqual(len(self.connections),2);self.assertIsNone(self.connections[0].sock)
    def test_server_failures_use_bounded_jitter_retries_and_a_final_attempt(self):
        for status in (500,502,504):
            with self.subTest(status=status):
                self.behavior=lambda handler,method,body:self.reply(handler,b'<Error><Code>Unavailable</Code></Error>',status)
                count=len(self.requests)
                with mock.patch('random.uniform',side_effect=[.1,.2]),mock.patch.object(album_storage.time,'sleep') as sleep:
                    with self.assertRaises(album_storage.StorageError):album_storage.S3Storage().request('HEAD','media/test')
                self.assertEqual(len(self.requests)-count,3)
                self.assertEqual([call.args[0] for call in sleep.call_args_list],[.6,1.2])

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
