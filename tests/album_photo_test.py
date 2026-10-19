import json,os,shutil,struct,tempfile,threading,time,unittest,zlib
from pathlib import Path
from unittest import mock
import album_test,album_storage_test,album,album_photo,album_video,album_storage

PHOTO=album_storage_test.PHOTO
THUMB=b'\xff\xd8\xff'+b'thumbnail'*10+b'\xff\xd9'
def encoded(source,target,preset,stop):Path(target).write_bytes(THUMB)

class PhotoJobsTests(unittest.TestCase):
 def setUp(self):
  self.env=mock.patch.dict(os.environ,album_storage_test.ENV);self.env.start()
  self.temp=tempfile.TemporaryDirectory();self.db=album_test.server.Database(self.temp.name);self.a=album.Album(self.db);self.store=album_storage_test.FakeStore()
  self.patch=mock.patch.object(album_storage,'S3Storage',return_value=self.store);self.patch.start()
 def tearDown(self):self.patch.stop();self.env.stop();self.temp.cleanup()
 def add(self,item='a'*32,data=PHOTO):
  key=self.store.key('media',item,'.jpg');self.store.files[key]=(data,'image/jpeg')
  with self.db.connect() as c:
   c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',(item,'Guest','','film','image/jpeg',len(data),album.stamp()))
   c.execute('INSERT INTO album_objects VALUES(?,?,NULL)',(item,key))
  return item,key
 def test_worker_creates_preview_from_stored_original_without_browser_or_original_reupload(self):
  item,key=self.add()
  self.assertTrue(self.a.list_items(None,admin=True)['items'][0]['thumbnailPending'])
  with mock.patch.object(album_photo,'thumbnail',side_effect=encoded):self.assertTrue(album_photo.process_next(self.a))
  with self.db.connect() as c:thumb=c.execute('SELECT thumbnail_key FROM album_objects WHERE id=?',(item,)).fetchone()[0]
  self.assertEqual(self.store.files[key][0],PHOTO);self.assertEqual(self.store.files[thumb][0],THUMB);self.assertFalse(album_photo.process_next(self.a));self.assertEqual(list(self.a.directory.iterdir()),[])
  self.assertFalse(self.a.list_items(None,admin=True)['items'][0]['thumbnailPending'])
 def test_video_and_photo_share_one_encoder_slot_and_original_requests_keep_working(self):
  self.add();self.a.video_slot.acquire()
  try:self.assertFalse(album_photo.process_next(self.a))
  finally:self.a.video_slot.release()
  entered=threading.Event();release=threading.Event()
  def slow(*args):entered.set();release.wait(3);return encoded(*args)
  with mock.patch.object(album_photo,'thumbnail',side_effect=slow):
   thread=threading.Thread(target=lambda:album_photo.process_next(self.a));thread.start()
   try:self.assertTrue(entered.wait(2));self.assertFalse(album_photo.process_next(album.Album(self.db)));self.assertFalse(album_video.process_next(self.a))
   finally:release.set();thread.join(3)
 def test_failed_decode_retains_original_and_other_photos_can_finish(self):
  first,key=self.add();second,_=self.add('b'*32)
  def fail_one(source,target,preset,stop):
   if self.store.files[key][0]==Path(source).read_bytes() and not getattr(fail_one,'called',False):fail_one.called=True;raise album_video.VideoError('invalid image')
   encoded(source,target,preset,stop)
  with mock.patch.object(album_photo,'thumbnail',side_effect=fail_one):
   self.assertTrue(album_photo.process_next(self.a));self.assertTrue(album_photo.process_next(self.a))
  with self.db.connect() as c:self.assertEqual(c.execute("SELECT count(*) FROM album_photo_jobs WHERE state='done'").fetchone()[0],1)
  self.assertEqual(self.store.files[key][0],PHOTO);self.assertEqual(list(self.a.directory.iterdir()),[])
 def test_delete_during_generation_never_republishes_or_leaves_new_object(self):
  item,key=self.add()
  def removed(*args):self.a.remove(item);encoded(*args)
  with mock.patch.object(album_photo,'thumbnail',side_effect=removed):self.assertTrue(album_photo.process_next(self.a))
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT count(*) FROM album_items').fetchone()[0],0)
  self.assertEqual(self.store.files,{});self.assertEqual(list(self.a.directory.iterdir()),[])
 def test_expired_worker_claim_resumes_and_existing_browser_thumbnail_is_preserved(self):
  item,key=self.add()
  with self.db.connect() as c:c.execute("INSERT INTO album_photo_jobs VALUES(?,'running','old',?,1,NULL)",(item,time.time()+60))
  self.assertFalse(album_photo.process_next(album.Album(self.db)))
  with self.db.connect() as c:c.execute('UPDATE album_photo_jobs SET ready=0')
  with mock.patch.object(album_photo,'thumbnail',side_effect=encoded):self.assertTrue(album_photo.process_next(album.Album(self.db)))
  with self.db.connect() as c:c.execute('DELETE FROM album_photo_jobs');before=c.execute('SELECT thumbnail_key FROM album_objects').fetchone()[0]
  with mock.patch.object(album_photo,'thumbnail',side_effect=AssertionError('must preserve existing thumbnail')):self.assertTrue(album_photo.process_next(self.a))
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT thumbnail_key FROM album_objects').fetchone()[0],before)
 def test_permanently_invalid_photo_stops_after_three_attempts_without_deleting_original(self):
  item,key=self.add()
  with mock.patch.object(album_photo,'thumbnail',side_effect=album_video.VideoError('not decodable')):
   for n in range(3):
    self.assertTrue(album_photo.process_next(self.a))
    with self.db.connect() as c:c.execute('UPDATE album_photo_jobs SET ready=0')
   self.assertFalse(album_photo.process_next(self.a))
  with self.db.connect() as c:self.assertEqual(c.execute('SELECT state,attempts FROM album_photo_jobs').fetchone(),('failed',3))
  self.assertEqual(self.store.files[key][0],PHOTO)
  self.assertFalse(self.a.list_items(None,admin=True)['items'][0]['thumbnailPending'])

@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'ffmpeg and ffprobe unavailable')
class RealPhotoEncoderTests(unittest.TestCase):
 def test_real_png_jpeg_and_webp_keep_dimensions_bounded_and_decode_valid_preview(self):
  import subprocess
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);png=root/'source.png'
   def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data))
   width,height=1200,1600;pixels=(b'\0'+bytes([140,90,40])*width)*height
   png.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(pixels))+chunk(b'IEND',b''))
   sources=[png]
   for ext in ('jpg','webp'):
    source=root/('source.'+ext);subprocess.run(['ffmpeg','-v','error','-y','-i',str(png),str(source)],check=True,capture_output=True);sources.append(source)
   for source in sources:
    original=source.read_bytes();target=root/(source.suffix[1:]+'-thumbnail.jpg');album_photo.thumbnail(source,target,'original',threading.Event())
    data=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_entries','stream=width,height','-of','json',str(target)]))['streams'][0]
    self.assertEqual((data['width'],data['height']),(540,720));self.assertLessEqual(target.stat().st_size,512*1024);self.assertEqual(source.read_bytes(),original)
 def test_oversized_metadata_fails_before_decode(self):
  with mock.patch.object(album_video,'run',return_value=b'{"streams":[{"width":9000,"height":9000}]}') as run:
   with self.assertRaises(album_photo.PhotoError):album_photo.thumbnail(Path('source.jpg'),Path('out.jpg'),'original',threading.Event())
   self.assertEqual(run.call_count,1)
 def test_real_encoder_honours_mirrored_selfie_exif_without_changing_original(self):
  import subprocess
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);ppm=root/'source.ppm';jpeg=root/'source.jpg';target=root/'thumbnail.jpg';width,height=80,40
   ppm.write_bytes(b'P6\n80 40\n255\n'+(bytes([240,10,10])*40+bytes([10,10,240])*40)*height)
   subprocess.run(['ffmpeg','-v','error','-y','-i',str(ppm),'-q:v','2',str(jpeg)],capture_output=True,check=True)
   exif=bytes([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,2,0,0,0,0,0,0,0]);data=jpeg.read_bytes();jpeg.write_bytes(data[:2]+exif+data[2:]);original=jpeg.read_bytes()
   album_photo.thumbnail(jpeg,target,'original',threading.Event());pixels=subprocess.check_output(['ffmpeg','-v','error','-i',str(target),'-f','rawvideo','-pix_fmt','rgb24','-'])
   left=pixels[(20*width+10)*3:(20*width+10)*3+3];right=pixels[(20*width+70)*3:(20*width+70)*3+3]
   self.assertGreater(left[2],left[0]);self.assertGreater(right[0],right[2]);self.assertEqual(jpeg.read_bytes(),original)
