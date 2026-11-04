import concurrent.futures, tempfile, unittest
from unittest import mock
from server import Database
from album import Album, AlbumError

class SharedClientTests(unittest.TestCase):
    def test_concurrent_jobs_initialize_one_client_and_local_mode_still_rejects_s3(self):
        with tempfile.TemporaryDirectory() as folder:
            album=Album(Database(folder))
            with mock.patch('album.album_storage.enabled',return_value=True),mock.patch('album.album_storage.S3Storage',side_effect=lambda:object()) as factory:
                with concurrent.futures.ThreadPoolExecutor(max_workers=16) as workers:
                    clients=list(workers.map(lambda _:album.storage(),range(64)))
                self.assertTrue(all(client is clients[0] for client in clients));self.assertEqual(factory.call_count,1)
            with mock.patch('album.album_storage.enabled',return_value=False),self.assertRaises(AlbumError) as error:album.storage()
            self.assertEqual(error.exception.status,409)
