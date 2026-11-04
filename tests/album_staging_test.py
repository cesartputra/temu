import tempfile, unittest
from pathlib import Path
from unittest import mock
import album_staging

class StagingTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.ram=mock.patch.object(album_staging,'RAM_ROOT',self.root/'ram');self.ram.start()
        self.memory=mock.patch.object(album_staging,'memory_available',return_value=1024**3);self.memory.start()
    def tearDown(self):
        self.memory.stop();self.ram.stop();self.temp.cleanup()
        self.assertEqual(album_staging._ram_reserved,0)
    def test_small_staging_is_reserved_and_cleaned_on_failure(self):
        with self.assertRaisesRegex(RuntimeError,'upload failed'):
            with album_staging.directory(1024,prefix='.relay-') as folder:
                path=Path(folder);self.assertEqual(path.parent,self.root/'ram')
                self.assertEqual(album_staging._ram_reserved,1024)
                (path/'photo').write_bytes(b'original');raise RuntimeError('upload failed')
        self.assertFalse(path.exists())
    def test_low_memory_and_large_video_use_disk(self):
        for size,memory in ((1024,0),(100*1024**2,1024**3)):
            with self.subTest(size=size),mock.patch.object(album_staging,'memory_available',return_value=memory):
                with album_staging.directory(size,prefix='.video-') as folder:
                    self.assertNotEqual(Path(folder).parent,self.root/'ram')
                    self.assertEqual(album_staging._ram_reserved,0)
                self.assertFalse(Path(folder).exists())
    def test_ram_budget_is_shared_and_released_before_reuse(self):
        with mock.patch.object(album_staging,'RAM_BUDGET',8*1024**2):
            with album_staging.directory(4*1024**2,prefix='.photo-') as first:
                with album_staging.directory(5*1024**2,prefix='.photo-') as second:
                    self.assertEqual(Path(first).parent,self.root/'ram')
                    self.assertNotEqual(Path(second).parent,self.root/'ram')
            with album_staging.directory(5*1024**2,prefix='.photo-') as third:
                self.assertEqual(Path(third).parent,self.root/'ram')
    def test_unwritten_reservations_cannot_overcommit_tmpfs_free_space(self):
        usage=album_staging.shutil.disk_usage
        def available(path):
            result=usage(path)
            return result._replace(free=24*1024**2) if Path(path)==self.root/'ram' else result
        with mock.patch.object(album_staging.shutil,'disk_usage',side_effect=available):
            with album_staging.directory(16*1024**2,prefix='.photo-') as first:
                with album_staging.directory(16*1024**2,prefix='.photo-') as second:
                    self.assertEqual(Path(first).parent,self.root/'ram')
                    self.assertNotEqual(Path(second).parent,self.root/'ram')
    def test_local_outputs_keep_same_filesystem_and_symlinked_ram_is_ignored(self):
        local=self.root/'local';local.mkdir()
        with album_staging.directory(1024,prefix='.photo-',fallback=local) as folder:
            self.assertEqual(Path(folder).parent,local)
        target=self.root/'other';target.mkdir();(self.root/'ram').symlink_to(target,target_is_directory=True)
        with album_staging.directory(1024,prefix='.relay-') as folder:
            self.assertNotEqual(Path(folder).parent,self.root/'ram')
