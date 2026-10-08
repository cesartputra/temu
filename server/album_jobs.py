"""Durable, bounded finalization queue; no media is held in the job database."""
import os, secrets, sqlite3, threading, time
import album_storage

ACTIVE_UPLOADS=12
PENDING_UPLOADS=24
STORAGE_BUDGET=int(float(os.environ.get('TEMU_ALBUM_STORAGE_BUDGET_GB','9'))*1024**3)
JOB_LEASE=600

def worker_count():
    value=os.environ.get('TEMU_ALBUM_WORKERS','2')
    if value not in ('1','2','3','4'):raise ValueError('TEMU_ALBUM_WORKERS harus berupa angka 1 sampai 4.')
    return int(value)

def initialize(album):
    album.worker_count=worker_count();album.worker_slots=threading.BoundedSemaphore(album.worker_count)
    album.worker_start_lock=threading.Lock();album.worker_threads=None;album.cleanup_lock=threading.Lock()
    with album.db.connect() as c:
        c.executescript('''CREATE TABLE IF NOT EXISTS album_jobs(id TEXT PRIMARY KEY,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,ready REAL NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',claim TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS album_requests(request_id TEXT PRIMARY KEY,item TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS album_jobs_ready ON album_jobs(state,ready);
        CREATE INDEX IF NOT EXISTS album_uploads_expiry ON album_uploads(expires);
        CREATE INDEX IF NOT EXISTS album_items_visible_created ON album_items(hidden,created DESC);''')
        if 'claim' not in {row[1] for row in c.execute('PRAGMA table_info(album_jobs)')}:
            c.execute("ALTER TABLE album_jobs ADD COLUMN claim TEXT NOT NULL DEFAULT ''")

def response(album,item):
    with album.db.connect() as c:
        row=c.execute('SELECT state,error FROM album_jobs WHERE id=?',(item,)).fetchone()
        exists=c.execute('SELECT 1 FROM album_items WHERE id=? AND hidden=0',(item,)).fetchone()
    if exists:return {'ok':True,'id':item,'thumbnailKey':album.thumbnail_key(item)}
    if row and row[0]=='failed':
        from album import AlbumError
        raise AlbumError(row[1] or 'Momen belum tersimpan. Silakan bagikan ulang.',422)
    return {'id':item,'pending':True,'state':row[0] if row else 'uploading','retryAfter':6}

def enqueue(album,item,body,config):
    from album import AlbumError
    with album.upload_lock,album.db.connect() as c:
        row=album.upload_record(item,body)
        if row[7]==1:return response(album,item)
        if not config['uploadsOpen']:raise AlbumError('Unggahan album sudah ditutup.',403)
        # A retry of this same ticket cannot create a second job or extend it.
        added=c.execute("INSERT OR IGNORE INTO album_jobs(id,state) VALUES(?,'queued')",(item,)).rowcount
        if added:c.execute('UPDATE album_uploads SET expires=? WHERE id=?',(int(time.time())+21600,item))
    return response(album,item)

def process_next(album):
    """Claim one job atomically; slow storage I/O runs outside metadata locks."""
    from album import AlbumError, EXTENSIONS, valid_media, stamp
    if not album.worker_slots.acquire(blocking=False):return False
    item=None;published=False;target=None;claim=secrets.token_hex(16)
    try:
        with album.upload_lock,album.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute("UPDATE album_jobs SET state='queued' WHERE state='running' AND ready<?",(time.time(),))
            job=c.execute("SELECT j.id FROM album_jobs j JOIN album_uploads u ON j.id=u.id WHERE j.state='queued' AND j.ready<=? AND u.completed=0 AND u.expires>? ORDER BY j.rowid LIMIT 1",(time.time(),int(time.time()))).fetchone()
            if not job:return False
            item=job[0];c.execute("UPDATE album_jobs SET state='running',attempts=attempts+1,ready=?,claim=? WHERE id=?",(time.time()+JOB_LEASE,claim,item))
            row=c.execute('SELECT name,caption,filter,mime,size FROM album_uploads WHERE id=?',(item,)).fetchone()
        # Separate targets keep an expired worker from overwriting/deleting a
        # replacement worker's result. Public item IDs remain unchanged.
        name,caption,preset,mime,size=row;store=album.storage();source=store.key('incoming',item,EXTENSIONS[mime]);target=store.key('media',claim,EXTENSIONS[mime])
        actual,content,etag,head=store.inspect(source)
        if actual!=size or content!=mime or not etag or not valid_media(mime,head):raise AlbumError('Unggahan tidak sesuai format atau ukuran. Silakan ambil ulang.',415)
        # Crucially: never hold the metadata lock during S3/disk I/O.
        store.copy(source,target,etag,size,mime)
        with album.upload_lock,album.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            current=c.execute('SELECT completed FROM album_uploads WHERE id=?',(item,)).fetchone()
            state=c.execute('SELECT state,claim FROM album_jobs WHERE id=?',(item,)).fetchone()
            if not current or current[0]!=0 or state!=('running',claim):raise AlbumError('Unggahan sudah dibatalkan.',410)
            c.execute('INSERT OR IGNORE INTO album_items VALUES(?,?,?,?,?,?,?,0)',(item,name,caption,preset,mime,size,stamp()))
            c.execute('INSERT OR IGNORE INTO album_objects VALUES(?,?,NULL)',(item,target))
            c.execute('UPDATE album_uploads SET completed=1,expires=? WHERE id=?',(int(time.time())+900,item))
            c.execute("UPDATE album_jobs SET state='done' WHERE id=?",(item,))
            published=True
        try:store.delete(source)
        except album_storage.StorageError:pass
        return True
    except (AlbumError,album_storage.StorageError,OSError,sqlite3.Error,ValueError) as error:
        if item:
            with album.upload_lock,album.db.connect() as c:
                job=c.execute('SELECT attempts,state,claim FROM album_jobs WHERE id=?',(item,)).fetchone()
                if job and job[1:] == ('running',claim):
                    retry=not isinstance(error,AlbumError) and job[0]<3
                    c.execute('UPDATE album_jobs SET state=?,ready=?,error=? WHERE id=?',('queued' if retry else 'failed',time.time()+min(60,10*2**job[0]),str(error)[:300] if isinstance(error,(AlbumError,album_storage.StorageError)) else 'Momen belum berhasil diproses. Silakan coba lagi.',item))
                    if not retry:c.execute('UPDATE album_uploads SET completed=-1,expires=? WHERE id=?',(int(time.time())+900,item))
            if target and not published:
                try:album.storage().delete(target)
                except (album_storage.StorageError,OSError):pass
        if item is None:raise
        return True
    finally:album.worker_slots.release()

def start_workers(album,stop):
    def finalize():
        while not stop.is_set():
            try:
                if not album_storage.enabled() or not process_next(album):stop.wait(1)
            except (album_storage.StorageError,OSError,sqlite3.Error,ValueError):
                # A temporary DB/disk failure must not kill or spin the worker.
                stop.wait(5)
    def cleanup():
        while not stop.wait(15):
            if album_storage.enabled():
                try:album.clean_uploads(album.storage())
                except (album_storage.StorageError,OSError,sqlite3.Error):pass
    with album.worker_start_lock:
        if album.worker_threads is not None:return album.worker_threads
        workers=[threading.Thread(target=finalize,name='temu-album-finalize-'+str(n+1),daemon=True) for n in range(album.worker_count)]
        workers.append(threading.Thread(target=cleanup,name='temu-album-cleanup',daemon=True))
        album.worker_threads=tuple(workers)
        for worker in workers:worker.start()
        return album.worker_threads
