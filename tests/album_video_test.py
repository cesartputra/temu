import json,os,shutil,subprocess,tempfile,threading,time,unittest
from pathlib import Path
from unittest import mock
import album_test,album_storage_test
import album,album_video,album_storage

VIDEO=b'\x00\x00\x00\x18ftypmp42'+b'original-video'*100
PREVIEW=b'\x00\x00\x00\x18ftypisom'+b'preview'*10

def encoded(source,target,stop):
    Path(target).write_bytes(PREVIEW);return True

class VideoTests(unittest.TestCase):
    setUp=album_test.AlbumTests.setUp
    tearDown=album_test.AlbumTests.tearDown
    request=album_test.AlbumTests.request
    config=album_test.AlbumTests.config
    join=album_test.AlbumTests.join
    def upload_video(self):
        self.join(self.config())
        status,_,raw=self.request('/api/album/upload','PUT',VIDEO,mime='video/mp4')
        self.assertEqual(status,201);return json.loads(raw)['id']
    def processor(self):return self.http.RequestHandlerClass.album
    def test_preview_is_smaller_original_download_is_unchanged_and_range_works(self):
        item=self.upload_video();a=self.processor()
        self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[2],VIDEO)
        with mock.patch.object(album_video,'compress',side_effect=encoded):self.assertTrue(album_video.process_next(a))
        status,headers,content=self.request('/api/album/file/'+item+'?preview=1',headers={'Range':'bytes=8-20'})
        self.assertEqual((status,content),(206,PREVIEW[8:21]));self.assertEqual(headers['Content-Type'],'video/mp4')
        for query in ('','?download=1','?preview=1&download=1'):
            self.assertEqual(self.request('/api/album/file/'+item+query)[2],VIDEO)
        self.config('after','2099-11-21T20:30:00+07:00')
        self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[0],403)
        self.assertFalse(album_video.process_next(a))
    def test_larger_or_failed_preview_keeps_original_and_never_retries_forever(self):
        for result in (False,album_video.VideoError('bad codec')):
            with self.subTest(result=result):
                item=self.upload_video()
                with mock.patch.object(album_video,'compress',side_effect=result if isinstance(result,Exception) else None,return_value=result):
                    self.assertTrue(album_video.process_next(self.processor()))
                self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[2],VIDEO)
                self.assertFalse(album_video.process_next(self.processor()))
    def test_only_one_encoder_runs_and_delete_during_encoding_cannot_republish(self):
        item=self.upload_video();a=self.processor();entered=threading.Event();release=threading.Event()
        def slow(*args):entered.set();release.wait(3);return encoded(*args)
        with mock.patch.object(album_video,'compress',side_effect=slow):
            worker=threading.Thread(target=lambda:album_video.process_next(a));worker.start()
            try:
                self.assertTrue(entered.wait(2));self.assertFalse(album_video.process_next(album.Album(self.db)))
                self.assertEqual(self.request('/api/album/items')[0],200)
                self.assertEqual(self.request('/api/album/admin/items/'+item,'DELETE',admin=True)[0],200)
            finally:release.set();worker.join(3)
        self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[0],404)
        self.assertEqual(list(a.directory.iterdir()),[])
        with self.db.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM album_video_jobs').fetchone()[0],0)
    def test_expired_jobs_resume_after_restart_and_reset_removes_both_files(self):
        item=self.upload_video();a=self.processor()
        with self.db.connect() as c:c.execute("INSERT INTO album_video_jobs(id,state,claim,ready,attempts) VALUES(?,'running','old',?,1)",(item,time.time()+1))
        restarted=album.Album(self.db);self.assertFalse(album_video.process_next(restarted))
        with self.db.connect() as c:c.execute('UPDATE album_video_jobs SET ready=0')
        with mock.patch.object(album_video,'compress',side_effect=encoded):self.assertTrue(album_video.process_next(restarted))
        self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[2],PREVIEW)
        self.assertEqual(self.request('/api/album/admin/items/'+item,'DELETE',admin=True)[0],200)
        self.assertEqual(list(a.directory.iterdir()),[])
    def test_storage_errors_back_off_without_blocking_original_or_other_requests(self):
        item=self.upload_video();a=self.processor()
        with mock.patch.object(album_video,'compress',side_effect=OSError('temporary disk error')):album_video.process_next(a)
        with self.db.connect() as c:state,ready=c.execute('SELECT state,ready FROM album_video_jobs WHERE id=?',(item,)).fetchone()
        self.assertEqual(state,'queued');self.assertGreater(ready,time.time());self.assertFalse(album_video.process_next(a))
        self.assertEqual(self.request('/api/album/file/'+item+'?download=1')[2],VIDEO)
    def test_graceful_shutdown_requeues_preview_for_restart(self):
        item=self.upload_video();a=self.processor();stop=threading.Event()
        def interrupted(*unused):stop.set();raise album_video.VideoError('shutdown')
        with mock.patch.object(album_video,'compress',side_effect=interrupted):album_video.process_next(a,stop)
        with self.db.connect() as c:self.assertEqual(c.execute('SELECT state FROM album_video_jobs WHERE id=?',(item,)).fetchone()[0],'queued')
        with mock.patch.object(album_video,'compress',side_effect=encoded):self.assertTrue(album_video.process_next(album.Album(self.db)))
        self.assertEqual(self.request('/api/album/file/'+item+'?preview=1')[2],PREVIEW)
    def test_restart_reaps_uncommitted_preview_without_changing_original(self):
        item=self.upload_video();a=self.processor();stale='a'*32+'.preview.mp4';(a.directory/stale).write_bytes(PREVIEW)
        with self.db.connect() as c:c.execute("INSERT INTO album_video_jobs(id,state,claim,ready,attempts,object_key) VALUES(?,'running','old',0,1,?)",(item,stale))
        with mock.patch.object(album_video,'compress',side_effect=encoded):self.assertTrue(album_video.process_next(album.Album(self.db)))
        self.assertFalse((a.directory/stale).exists());self.assertEqual(self.request('/api/album/file/'+item+'?download=1')[2],VIDEO)

class S3VideoTests(unittest.TestCase):
    def test_private_preview_redirect_download_and_removal_keep_original_separate(self):
        with tempfile.TemporaryDirectory() as directory,mock.patch.dict(os.environ,album_storage_test.ENV):
            db=album_test.server.Database(directory);a=album.Album(db);store=album_storage_test.FakeStore();item='c'*32;original=store.key('media',item,'.mp4')
            store.files[original]=(VIDEO,'video/mp4')
            with db.connect() as c:
                c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',(item,'Guest','','original','video/mp4',len(VIDEO),album.stamp()))
                c.execute('INSERT INTO album_objects VALUES(?,?,NULL)',(item,original))
            def download(method,key,**options):
                self.assertEqual(method,'GET');self.assertEqual(options['expected'],len(VIDEO));Path(options['output']).write_bytes(store.files[key][0])
            with mock.patch.object(a,'storage',return_value=store),mock.patch.object(store,'request',side_effect=download,create=True),mock.patch.object(album_video,'compress',side_effect=encoded):
                self.assertTrue(album_video.process_next(a))
                with db.connect() as c:preview=c.execute('SELECT object_key FROM album_video_jobs WHERE id=?',(item,)).fetchone()[0]
                self.assertIn('/previews/',preview);self.assertEqual(store.files[original][0],VIDEO);self.assertEqual(store.files[preview],(PREVIEW,'video/mp4'))
                h=mock.Mock();h.path='/api/album/file/'+item+'?preview=1';h.command='GET'
                a.serve_file(h,item,{'mode':'live'});self.assertIn(preview,h.send_header.call_args_list[0].args[1])
                h=mock.Mock();h.path='/api/album/file/'+item+'?preview=1&download=1';h.command='HEAD'
                a.serve_file(h,item,{'mode':'live'});self.assertIn(original,h.send_header.call_args_list[0].args[1])
                a.remove(item);self.assertNotIn(original,store.files);self.assertNotIn(preview,store.files)
    def test_new_upload_reserves_room_for_video_preview_as_well_as_staging_and_original(self):
        with tempfile.TemporaryDirectory() as directory,mock.patch.dict(os.environ,album_storage_test.ENV):
            a=album.Album(album_test.server.Database(directory));body=json.dumps({'name':'Guest','mime':'video/mp4','size':1024*1024}).encode()
            import io,album_jobs
            h=type('Request',(),{'headers':{'Content-Length':str(len(body))},'rfile':io.BytesIO(body)})()
            with mock.patch.object(album_jobs,'STORAGE_BUDGET',2*1024*1024+24*512*1024),self.assertRaises(album.AlbumError) as error:
                a.begin_upload(h,{'uploadsOpen':True})
            self.assertEqual(error.exception.status,429)

class EncoderTests(unittest.TestCase):
    def test_encoder_has_bounded_diagnostics_and_limits_allocator_arenas(self):
        def failure(*args,**kwargs):
            self.assertEqual(kwargs['env']['MALLOC_ARENA_MAX'],'2');self.assertEqual(kwargs['env']['OMP_NUM_THREADS'],'1')
            kwargs['stderr'].write(b'x'*5000+b' pthread_create failed');kwargs['stderr'].flush()
            process=mock.Mock();process.pid=123456;process.communicate.return_value=(b'',None);process.returncode=245;process.poll.return_value=245;return process
        with mock.patch.object(album_video.subprocess,'Popen',side_effect=failure),mock.patch.object(album_video.os,'setpriority'),self.assertRaises(album_video.VideoError) as error:
            album_video.run(['ffmpeg'],1,threading.Event())
        self.assertIn('exit 245',str(error.exception));self.assertIn('pthread_create failed',str(error.exception));self.assertLess(len(str(error.exception)),2200)
    def test_linux_virtual_memory_allows_thread_reservations(self):
        import resource
        process=mock.Mock();process.pid=123456;process.communicate.return_value=(b'{}',None);process.returncode=0;process.poll.return_value=0
        with mock.patch.object(album_video.subprocess,'Popen',return_value=process),mock.patch.object(album_video.os,'setpriority'),mock.patch.object(album_video.os,'uname',return_value=type('System',(),{'sysname':'Linux'})()),mock.patch.object(Path,'read_text',return_value=str(512*1024*1024)),mock.patch.object(resource,'prlimit',create=True) as limit:
            self.assertEqual(album_video.run(['ffprobe'],1,threading.Event()),b'{}')
        expected=768*1024*1024;limit.assert_called_once_with(123456,resource.RLIMIT_AS,(expected,expected))
    def test_encoder_is_killed_when_resident_memory_exceeds_its_share_of_pod_ram(self):
        import resource
        process=mock.Mock();process.pid=123456;process.communicate.side_effect=subprocess.TimeoutExpired('ffmpeg',.2);process.poll.return_value=None
        def contents(path):return 'VmRSS: 400000 kB' if str(path).endswith('/status') else str(512*1024*1024)
        with mock.patch.object(album_video.subprocess,'Popen',return_value=process),mock.patch.object(album_video.os,'setpriority'),mock.patch.object(album_video.os,'uname',return_value=type('System',(),{'sysname':'Linux'})()),mock.patch.object(Path,'read_text',contents),mock.patch.object(resource,'prlimit',create=True),mock.patch.object(album_video.os,'killpg') as kill,self.assertRaisesRegex(album_video.VideoError,'memory budget'):
            album_video.run(['ffmpeg'],1,threading.Event())
        kill.assert_called_once_with(123456,album_video.signal.SIGKILL);process.wait.assert_called_once()
    def test_encoder_restricts_protocols_threads_output_size_and_handles_hdr(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'input.mov';target=Path(directory)/'preview.mp4';source.write_bytes(VIDEO);target.write_bytes(PREVIEW)
            probe=json.dumps({'streams':[{'width':3840,'height':2160,'color_transfer':'smpte2084'}],'format':{'duration':'10'}}).encode();calls=[]
            def command(args,*unused):calls.append(args);return probe
            with mock.patch.object(album_video,'run',side_effect=command):self.assertTrue(album_video.compress(source,target,threading.Event()))
            args=calls[1];self.assertEqual(args[args.index('-threads')+1],'1');self.assertEqual(args[args.index('-protocol_whitelist')+1],'file,pipe')
            self.assertIn('tonemap=hable',args[args.index('-vf')+1]);self.assertIn('+faststart',args);self.assertIn(str(album_video.MAX_PREVIEW),args)
    def test_truncated_or_oversized_metadata_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'in.mp4';target=Path(directory)/'out.mp4';source.write_bytes(VIDEO);target.write_bytes(PREVIEW)
            with mock.patch.object(album_video,'probe',side_effect=[({},10),({},5)]),mock.patch.object(album_video,'run'),self.assertRaises(album_video.VideoError):
                album_video.compress(source,target,threading.Event())
            for width,height,duration in ((8000,8000,1),(100,100,601),(100,100,'nan')):
                data=json.dumps({'streams':[{'width':width,'height':height}],'format':{'duration':duration}}).encode()
                with mock.patch.object(album_video,'run',return_value=data),self.assertRaises(album_video.VideoError):album_video.probe(source,threading.Event())
    def test_timeout_and_shutdown_terminate_encoder_child(self):
        process=mock.Mock();process.pid=123456;process.poll.return_value=None
        with mock.patch.object(album_video.subprocess,'Popen',return_value=process),mock.patch.object(album_video.os,'setpriority'),mock.patch.object(album_video.os,'killpg') as kill,self.assertRaises(album_video.VideoError):
            album_video.run(['ffmpeg'],0,threading.Event())
        kill.assert_called_once();process.wait.assert_called_once()

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'ffmpeg/ffprobe are needed for real codec tests')
class RealEncoderTests(unittest.TestCase):
    def test_real_landscape_portrait_audio_and_hdr_previews_keep_original_bytes(self):
        for shape,hdr in (('2560x1440',False),('720x1280',False),('640x360',True)):
            with self.subTest(shape=shape,hdr=hdr),tempfile.TemporaryDirectory() as directory:
                source=Path(directory)/'source.mp4';target=Path(directory)/'preview.mp4'
                command=['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size='+shape+':rate=12','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
                    '-t','2','-c:v','libx264','-crf','5','-preset','ultrafast','-threads','1','-c:a','aac','-pix_fmt','yuv420p']
                if hdr:command+=['-x264-params','colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc']
                subprocess.run(command+[str(source)],check=True,timeout=60,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                original=source.read_bytes();self.assertTrue(album_video.compress(source,target,threading.Event()));self.assertEqual(source.read_bytes(),original)
                metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(target)]))
                video=next(s for s in metadata['streams'] if s['codec_type']=='video');self.assertEqual(video['codec_name'],'h264');self.assertEqual(video['pix_fmt'],'yuv420p')
                self.assertLessEqual(min(video['width'],video['height']),1080);self.assertLessEqual(max(video['width'],video['height']),1920)
                self.assertTrue(any(s['codec_type']=='audio' and s['codec_name']=='aac' for s in metadata['streams']))
                self.assertLess(target.stat().st_size,len(original));self.assertAlmostEqual(float(metadata['format']['duration']),2,delta=.25)
                subprocess.run(['ffmpeg','-v','error','-i',str(target),'-f','null','-'],check=True,timeout=30,stderr=subprocess.PIPE)
                if hdr:self.assertEqual(video.get('color_transfer'),'bt709')
                print('Real video codec:',shape,'HDR' if hdr else 'SDR',len(original),'->',target.stat().st_size,'bytes;',str(video['width'])+'x'+str(video['height']))
    def test_native_rotation_and_silent_video_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source.mp4';rotated=Path(directory)/'rotated.mov';target=Path(directory)/'preview.mp4'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=12','-t','2','-c:v','libx264','-crf','5','-preset','ultrafast','-threads','1',str(source)],check=True,timeout=30,stderr=subprocess.PIPE)
            subprocess.run(['ffmpeg','-v','error','-display_rotation','90','-i',str(source),'-c','copy',str(rotated)],check=True,timeout=30,stderr=subprocess.PIPE)
            self.assertTrue(album_video.compress(rotated,target,threading.Event()))
            metadata=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(target)]));video=metadata['streams'][0]
            self.assertEqual((video['width'],video['height']),(360,640));self.assertEqual(len(metadata['streams']),1)

if __name__=='__main__':unittest.main()
