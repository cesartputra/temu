"""Copy existing album media to private S3 without deleting the local backup."""
import argparse, hashlib
from album import Album, EXTENSIONS, valid_media
from album_storage import S3Storage, StorageError
from server import Database

def migrate(directory):
    db=Database(directory);album=Album(db);store=S3Storage();moved=0;thumbnails=0
    with db.connect() as c:rows=c.execute('SELECT id,mime,size FROM album_items WHERE hidden=0').fetchall()
    for item,mime,size in rows:
        with album.upload_lock:
            with db.connect() as c:obj=c.execute('SELECT object_key,thumbnail_key FROM album_objects WHERE id=?',(item,)).fetchone()
            if not obj:
                path=album.directory/(item+EXTENSIONS[mime]);key=store.key('media',item,EXTENSIONS[mime])
                if not path.is_file() or path.stat().st_size!=size:raise StorageError('File lokal tidak sesuai. Migrasi dihentikan tanpa menghapus sumber.')
                store.put_file(key,path,mime)
                actual,content,etag,head=store.inspect(key)
                if actual!=size or content!=mime or not valid_media(mime,head):raise StorageError('Verifikasi salinan gagal. Sumber tetap disimpan.')
                digest=hashlib.md5()
                with path.open('rb') as f:
                    for chunk in iter(lambda:f.read(65536),b''):digest.update(chunk)
                if etag.strip('"').lower()!=digest.hexdigest():raise StorageError('Verifikasi byte salinan gagal. Sumber tetap disimpan.')
                with db.connect() as c:
                    added=c.execute('INSERT OR IGNORE INTO album_objects SELECT id,?,NULL FROM album_items WHERE id=? AND hidden=0',(key,item)).rowcount
                if not added:continue
                moved+=1;obj=(key,None)
            thumbnail=album.directory/(item+'.thumb.jpg')
            if thumbnail.is_file() and not obj[1]:
                key=store.key('thumbnails',item,'.jpg');store.put_file(key,thumbnail,'image/jpeg')
                actual,content,etag,head=store.inspect(key)
                if actual!=thumbnail.stat().st_size or not valid_media('image/jpeg',head):raise StorageError('Verifikasi pratinjau gagal. Sumber tetap disimpan.')
                with db.connect() as c:c.execute('UPDATE album_objects SET thumbnail_key=? WHERE id=?',(key,item))
                thumbnails+=1
    db.backup(force=True)
    return {'copied':moved,'thumbnails':thumbnails,'total':len(rows)}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--data-dir',required=True);args=parser.parse_args()
    try:
        result=migrate(args.data_dir)
        print('Migrasi selesai:',result['copied'],'file,',result['thumbnails'],'pratinjau; total',result['total'],'momen. Cadangan lokal dipertahankan.')
    except (StorageError,OSError) as error:raise SystemExit(str(error))
