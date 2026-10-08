import concurrent.futures,io,json,os,socket,threading,time,tempfile,unittest
from unittest import mock
import album_storage_test as fixtures
import album,album_jobs
from bounded_http import BoundedHTTPServer
from http.server import BaseHTTPRequestHandler

class AsyncQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.db=fixtures.album_test.server.Database(self.tmp.name);self.a=album.Album(self.db);self.config=self.a.configure({'title':'Test','mode':'live','filter':'original','uploadsOpen':True})
        self.env=mock.patch.dict(os.environ,fixtures.ENV);self.env.start();self.store=fixtures.FakeStore();self.patch=mock.patch.object(album.album_storage,'S3Storage',return_value=self.store);self.patch.start()
    def tearDown(self):self.patch.stop();self.env.stop();self.tmp.cleanup()
    def handler(self,body):
        data=json.dumps(body).encode();return type('Request',(),{'headers':{'Content-Length':str(len(data))},'rfile':io.BytesIO(data)})()
    def begin(self,n=0,mime='image/jpeg',data=fixtures.PHOTO):
        return self.a.begin_upload(self.handler({'requestId':format(n,'032x'),'name':'Guest '+str(n),'mime':mime,'size':len(data),'filter':'original'}),self.config)
    def queue(self,t,data=fixtures.PHOTO,mime='image/jpeg'):
        self.store.files[self.store.key('incoming',t['id'],album.EXTENSIONS[mime])]=(data,mime)
        return self.a.complete_upload(self.handler({'token':t['token']}),t['id'],self.config)
    def test_completion_returns_before_copy_and_metadata_remains_available_during_copy(self):
        t=self.begin();result=self.queue(t);self.assertTrue(result['pending']);self.assertEqual(self.a.public(self.config)['count'],0)
        started=threading.Event();release=threading.Event();copy=self.store.copy
        def slow(*args):started.set();release.wait(3);copy(*args)
        with mock.patch.object(self.store,'copy',side_effect=slow):
            worker=threading.Thread(target=lambda:album_jobs.process_next(self.a));worker.start();self.assertTrue(started.wait(2))
            start=time.monotonic();self.begin(1);self.a.public(self.config);self.a.upload_status(self.handler({'token':t['token']}),t['id']);self.assertLess(time.monotonic()-start,.5)
            release.set();worker.join(3)
        self.assertEqual(self.a.public(self.config)['count'],1)
    def test_lost_ticket_response_is_idempotent_and_upload_slots_are_bounded(self):
        t=self.begin();again=self.begin();self.assertEqual(t['id'],again['id']);self.assertEqual(t['token'],again['token'])
        for n in range(1,12):self.begin(n)
        with self.assertRaises(album.AlbumError) as error:self.begin(12)
        self.assertEqual(error.exception.status,429)
        self.queue(t);self.begin(12)
        with self.db.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM album_uploads').fetchone()[0],13)
    def test_restart_recovers_queued_job_and_cancel_during_worker_never_publishes(self):
        t=self.begin();self.queue(t);restarted=album.Album(self.db);self.assertTrue(album_jobs.process_next(restarted));self.assertEqual(self.a.public(self.config)['count'],1)
        t=self.begin(1);self.queue(t);copy=self.store.copy
        def cancel(*args):copy(*args);self.a.cancel_upload(self.handler({'token':t['token']}),t['id'])
        with mock.patch.object(self.store,'copy',side_effect=cancel):album_jobs.process_next(self.a)
        self.assertEqual(self.a.public(self.config)['count'],1);self.assertNotIn(self.store.key('media',t['id'],'.jpg'),self.store.files)
    def test_retry_is_backed_off_and_storage_headroom_counts_staging_plus_final(self):
        t=self.begin();self.queue(t);self.store.fail=True;album_jobs.process_next(self.a)
        with self.db.connect() as c:state,attempts,ready=c.execute('SELECT state,attempts,ready FROM album_jobs').fetchone()
        self.assertEqual((state,attempts),('queued',1));self.assertGreater(ready,time.time());self.assertFalse(album_jobs.process_next(self.a))
        with mock.patch.object(album_jobs,'STORAGE_BUDGET',len(fixtures.PHOTO)*3):
            with self.assertRaises(album.AlbumError) as error:self.begin(1)
            self.assertEqual(error.exception.status,429)
    def test_restart_reclaims_expired_worker_lease_without_duplicate_publication(self):
        t=self.begin();self.queue(t)
        with self.db.connect() as c:c.execute("UPDATE album_jobs SET state='running',ready=?,attempts=1 WHERE id=?",(time.time()+60,t['id']))
        restarted=album.Album(self.db);self.assertFalse(album_jobs.process_next(restarted))
        with self.db.connect() as c:c.execute('UPDATE album_jobs SET ready=? WHERE id=?',(time.time()-1,t['id']))
        self.assertTrue(album_jobs.process_next(restarted));self.assertFalse(album_jobs.process_next(restarted))
        self.assertEqual(self.a.public(self.config)['count'],1)
    def test_180_concurrent_clients_eventually_publish_with_one_copy_worker_and_bounded_queue(self):
        lock=threading.Lock();peak={'copy':0,'pending':0,'active':0};current=0;original=self.store.copy;done=threading.Event();worker_errors=[]
        def slow(*args):
            nonlocal current
            with lock:current+=1;peak['copy']=max(peak['copy'],current)
            time.sleep(.003);original(*args)
            with lock:current-=1
        def worker():
            try:
                while not done.is_set():
                    if not album_jobs.process_next(self.a):time.sleep(.005)
            except Exception as e:worker_errors.append(e)
        def guest(n):
            mime='video/mp4' if n%2 else 'image/jpeg';data=b'\x00\x00\x00\x18ftypisom'+b'clip'*24 if n%2 else fixtures.PHOTO;deadline=time.monotonic()+30
            while True:
                try:t=self.begin(n,mime,data);break
                except album.AlbumError as e:
                    if e.status!=429 or time.monotonic()>deadline:raise
                    time.sleep(.015+(n%7)*.001)
            with self.db.connect() as c:
                pending=c.execute('SELECT count(*) FROM album_uploads WHERE completed=0').fetchone()[0]
                active=c.execute('SELECT count(*) FROM album_uploads u LEFT JOIN album_jobs j ON u.id=j.id WHERE u.completed=0 AND j.id IS NULL').fetchone()[0]
            with lock:peak['pending']=max(peak['pending'],pending);peak['active']=max(peak['active'],active)
            self.queue(t,data,mime);return t['id']
        with mock.patch.object(self.store,'copy',side_effect=slow):
            runner=threading.Thread(target=worker);runner.start()
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=180) as pool:ids=list(pool.map(guest,range(180)))
                deadline=time.monotonic()+15
                while self.a.public(self.config)['count']<180 and time.monotonic()<deadline:time.sleep(.03)
                self.assertEqual(self.a.public(self.config)['count'],180)
            finally:done.set();runner.join(3)
        self.assertEqual(worker_errors,[]);self.assertEqual(len(set(ids)),180);self.assertEqual(peak['copy'],1);self.assertLessEqual(peak['active'],12);self.assertLessEqual(peak['pending'],24)
        print('180-client simulation:',peak,'; 180 distinct published objects')

class BoundedServerTests(unittest.TestCase):
    def test_excess_http_requests_get_retry_response_without_new_thread(self):
        started=threading.Event();release=threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):started.set();release.wait(2);self.send_response(200);self.end_headers()
        server=BoundedHTTPServer(('127.0.0.1',0),Handler,max_workers=1);thread=threading.Thread(target=server.serve_forever);thread.start();first=socket.create_connection(server.server_address)
        try:
            first.sendall(b'GET / HTTP/1.0\r\n\r\n');self.assertTrue(started.wait(1))
            with socket.create_connection(server.server_address) as extra:extra.sendall(b'GET / HTTP/1.0\r\n\r\n');response=extra.recv(1024)
            self.assertIn(b'503 Service Unavailable',response);self.assertIn(b'Retry-After: 5',response)
        finally:release.set();first.close();server.shutdown();server.server_close();thread.join()
