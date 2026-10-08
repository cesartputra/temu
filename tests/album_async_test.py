import concurrent.futures,io,json,os,socket,threading,time,tempfile,unittest
from unittest import mock
import album_storage_test as fixtures
import album,album_jobs
from bounded_http import BoundedHTTPServer
from http.server import BaseHTTPRequestHandler

class AsyncQueueTests(unittest.TestCase):
    def setUp(self):
        self.workers_env=mock.patch.dict(os.environ,{'TEMU_ALBUM_WORKERS':'2'});self.workers_env.start()
        self.tmp=tempfile.TemporaryDirectory();self.db=fixtures.album_test.server.Database(self.tmp.name);self.a=album.Album(self.db);self.config=self.a.configure({'title':'Test','mode':'live','filter':'original','uploadsOpen':True})
        self.env=mock.patch.dict(os.environ,fixtures.ENV);self.env.start();self.store=fixtures.FakeStore();self.patch=mock.patch.object(album.album_storage,'S3Storage',return_value=self.store);self.patch.start()
    def tearDown(self):self.patch.stop();self.env.stop();self.tmp.cleanup();self.workers_env.stop()
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
        self.assertEqual(self.a.public(self.config)['count'],1);self.assertEqual(sum('/media/' in key for key in self.store.files),1)
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
    def test_worker_count_is_configurable_and_rejects_unbounded_values(self):
        with mock.patch.dict(os.environ,{},clear=True):self.assertEqual(album_jobs.worker_count(),2)
        for value in ('1','2','3','4'):
            with mock.patch.dict(os.environ,{'TEMU_ALBUM_WORKERS':value}):self.assertEqual(album_jobs.worker_count(),int(value))
        for value in ('0','5','-1','100','2.0','', 'two'):
            with mock.patch.dict(os.environ,{'TEMU_ALBUM_WORKERS':value}),self.assertRaisesRegex(ValueError,'TEMU_ALBUM_WORKERS'):album_jobs.worker_count()
    def test_two_jobs_overlap_with_bounded_slots_and_metadata_stays_responsive(self):
        tickets=[self.begin(n) for n in range(3)]
        for ticket in tickets:self.queue(ticket)
        started=threading.Barrier(3);release=threading.Event();copy=self.store.copy;copied=[]
        def slow(source,*args):
            copied.append(source);started.wait(3);release.wait(3);copy(source,*args)
        with mock.patch.object(self.store,'copy',side_effect=slow):
            workers=[threading.Thread(target=album_jobs.process_next,args=(self.a,)) for _ in range(2)]
            for worker in workers:worker.start()
            try:
                started.wait(3);start=time.monotonic()
                self.assertFalse(album_jobs.process_next(self.a));self.begin(3);self.a.public(self.config)
                self.assertLess(time.monotonic()-start,.5)
                self.a.cancel_upload(self.handler({'token':tickets[0]['token']}),tickets[0]['id'])
            finally:
                release.set()
                for worker in workers:worker.join(3)
        self.assertEqual(len(set(copied)),2);self.assertEqual(self.a.public(self.config)['count'],1)
        self.assertTrue(album_jobs.process_next(self.a));self.assertEqual(self.a.public(self.config)['count'],2)
        self.assertEqual(sum('/media/' in key for key in self.store.files),2)
    def test_stale_worker_cannot_publish_or_delete_replacement_result(self):
        ticket=self.begin();self.queue(ticket);entered=threading.Event();release=threading.Event();copy=self.store.copy;targets=[]
        def delayed(source,target,*args):
            targets.append(target);copy(source,target,*args)
            if len(targets)==1:entered.set();release.wait(3)
        with mock.patch.object(self.store,'copy',side_effect=delayed),concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            old=pool.submit(album_jobs.process_next,self.a)
            try:
                self.assertTrue(entered.wait(2))
                with self.db.connect() as c:c.execute('UPDATE album_jobs SET ready=0 WHERE id=?',(ticket['id'],))
                self.assertTrue(album_jobs.process_next(self.a))
            finally:release.set();self.assertTrue(old.result(timeout=3))
        self.assertEqual(len(set(targets)),2);self.assertNotIn(targets[0],self.store.files);self.assertIn(targets[1],self.store.files)
        with self.db.connect() as c:
            self.assertEqual(c.execute('SELECT object_key FROM album_objects WHERE id=?',(ticket['id'],)).fetchone()[0],targets[1])
            self.assertEqual(c.execute('SELECT state FROM album_jobs').fetchone()[0],'done')
        self.assertEqual(self.a.public(self.config)['count'],1)
    def test_existing_queue_schema_migrates_without_losing_pending_jobs(self):
        ticket=self.begin();self.queue(ticket)
        with self.db.connect() as c:
            c.execute('ALTER TABLE album_jobs DROP COLUMN claim')
        restarted=album.Album(self.db)
        self.assertTrue(album_jobs.process_next(restarted));self.assertEqual(self.a.public(self.config)['count'],1)
    def test_start_workers_creates_configured_pool_once_and_stops_cleanly(self):
        for count in (1,2,4):
            with self.subTest(count=count),mock.patch.dict(os.environ,{'TEMU_ALBUM_WORKERS':str(count)}):
                a=album.Album(self.db);stop=threading.Event()
                workers=album_jobs.start_workers(a,stop)
                try:
                    self.assertIs(album_jobs.start_workers(a,stop),workers)
                    self.assertEqual(len(workers),count+1)
                    self.assertEqual(sum(t.name.startswith('temu-album-finalize-') for t in workers),count)
                    self.assertTrue(all(t.is_alive() for t in workers))
                finally:
                    stop.set()
                    for worker in workers:worker.join(3)
                self.assertTrue(all(not t.is_alive() for t in workers))
    def test_180_concurrent_clients_eventually_publish_with_two_workers_and_bounded_queue(self):
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
            runners=[threading.Thread(target=worker) for _ in range(2)]
            for runner in runners:runner.start()
            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=180) as pool:ids=list(pool.map(guest,range(180)))
                deadline=time.monotonic()+15
                while self.a.public(self.config)['count']<180 and time.monotonic()<deadline:time.sleep(.03)
                self.assertEqual(self.a.public(self.config)['count'],180)
            finally:
                done.set()
                for runner in runners:runner.join(3)
        self.assertEqual(worker_errors,[]);self.assertEqual(len(set(ids)),180);self.assertEqual(peak['copy'],2);self.assertLessEqual(peak['active'],12);self.assertLessEqual(peak['pending'],24)
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
