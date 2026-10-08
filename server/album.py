"""Shared guest album: original files, bounded streaming uploads, timed reveal."""
import hmac, json, os, re, secrets, tempfile, threading, tarfile, shutil, time
import album_storage, album_jobs
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, parse_qs
from http.cookies import SimpleCookie

FILTERS={'original','film','warm','mono','dazz'}
EXTENSIONS={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}
MAX_FILE=100*1024*1024
MAX_ALBUM=int(float(os.environ.get('TEMU_ALBUM_MAX_GB','2'))*1024*1024*1024)

class AlbumError(Exception):
    def __init__(self,message,status=400):self.status=status;super().__init__(message)

def stamp():return datetime.now(timezone.utc).isoformat()
def valid_media(mime,head):
    return (mime=='image/jpeg' and head.startswith(b'\xff\xd8\xff') or
            mime=='image/png' and head.startswith(b'\x89PNG\r\n\x1a\n') or
            mime=='image/webp' and head.startswith(b'RIFF') and head[8:12]==b'WEBP' or
            mime in ('video/mp4','video/quicktime') and head[4:8]==b'ftyp' or
            mime=='video/webm' and head.startswith(b'\x1aE\xdf\xa3'))

class Album:
    def import_archive(self,h):
        if not getattr(self.db,'allow_import',False):raise AlbumError('Tidak ditemukan.',404)
        size=int(h.headers.get('Content-Length','0'))
        if not 0<size<=256*1024*1024:raise AlbumError('Paket migrasi maksimal 256 MB.',413)
        with self.upload_lock,tempfile.TemporaryDirectory(dir=self.directory,prefix='.migration-') as directory:
            stage=Path(directory);archive=stage/'archive.tar';remaining=size
            h.connection.settimeout(90)
            with archive.open('wb') as f:
                while remaining:
                    chunk=h.rfile.read(min(65536,remaining))
                    if not chunk:raise AlbumError('Migrasi terputus.')
                    f.write(chunk);remaining-=len(chunk)
            with tarfile.open(archive,'r:') as package:
                members=package.getmembers()
                if len(members)>2000 or any(not m.isfile() or '/' in m.name or '\\' in m.name for m in members) or len({m.name for m in members})!=len(members):raise AlbumError('Paket migrasi tidak valid.')
                manifest=package.getmember('manifest.json')
                if manifest.size>1024*1024:raise AlbumError('Manifest terlalu besar.')
                data=json.load(package.extractfile(manifest));config=data['config'];rows=data['items']
                if not isinstance(config,dict) or not isinstance(rows,list) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',config.get('key','')):raise AlbumError('Manifest tidak valid.')
                if config.get('mode') not in ('live','after') or config.get('filter') not in FILTERS or type(config.get('uploadsOpen')) is not bool or not isinstance(config.get('title'),str) or not 1<=len(config['title'])<=120:raise AlbumError('Pengaturan migrasi tidak valid.')
                if config['mode']=='after' and datetime.fromisoformat(config['releaseAt']).tzinfo is None:raise AlbumError('Waktu migrasi tidak valid.')
                config={k:config[k] for k in ('key','mode','filter','uploadsOpen','title','releaseAt')}
                extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}
                files=[];seen=set();used=0
                for row in rows:
                    identifier=row['id'];mime=row['mime'];length=row['size']
                    if not re.fullmatch(r'[a-f0-9]{32}',identifier) or identifier in seen or mime not in extensions or type(length) is not int or not 12<=length<=MAX_FILE or row.get('filter') not in FILTERS:raise AlbumError('Momen migrasi tidak valid.')
                    if not isinstance(row.get('name'),str) or not 1<=len(row['name'])<=80 or not isinstance(row.get('caption'),str) or len(row['caption'])>300 or datetime.fromisoformat(row['created']).tzinfo is None:raise AlbumError('Metadata migrasi tidak valid.')
                    seen.add(identifier);used+=length;filename=identifier+extensions[mime];member=package.getmember(filename)
                    if member.size!=length:raise AlbumError('Ukuran file migrasi tidak sesuai.')
                    src=package.extractfile(member);head=src.read(32)
                    if not valid_media(mime,head):raise AlbumError('Format file migrasi tidak sesuai.')
                    with (stage/filename).open('wb') as f:f.write(head);shutil.copyfileobj(src,f,65536)
                    files.append(filename)
                    thumbnail=identifier+'.thumb.jpg'
                    if thumbnail in {m.name for m in members}:
                        member=package.getmember(thumbnail)
                        if member.size>512*1024:raise AlbumError('Pratinjau migrasi terlalu besar.')
                        with package.extractfile(member) as src,(stage/thumbnail).open('wb') as dst:shutil.copyfileobj(src,dst,65536)
                        files.append(thumbnail)
                if used>MAX_ALBUM or {m.name for m in members}!={'manifest.json',*files}:raise AlbumError('Paket migrasi tidak sesuai.')
            moved=[]
            try:
                with self.db.connect() as c:
                    c.execute('BEGIN IMMEDIATE')
                    if c.execute('SELECT 1 FROM album_settings').fetchone() or c.execute('SELECT 1 FROM album_items').fetchone():raise AlbumError('Album tujuan sudah berisi data. Migrasi dibatalkan.',409)
                    for filename in files:os.replace(stage/filename,self.directory/filename);moved.append(filename)
                    c.execute('INSERT INTO album_settings VALUES(1,?)',(json.dumps(config),))
                    for row in rows:c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',tuple(row[k] for k in ('id','name','caption','filter','mime','size','created')))
            except Exception:
                for filename in moved:(self.directory/filename).unlink(missing_ok=True)
                raise
        self.db.backup(force=True);return {'ok':True,'imported':len(rows)}
    def __init__(self,db):
        self.db=db;self.upload_lock=threading.Lock();self.thumbnail_slots=threading.BoundedSemaphore(2);self.directory=db.directory/'album-media';self.directory.mkdir(mode=0o700,exist_ok=True)
        with db.connect() as c:
            c.executescript('''CREATE TABLE IF NOT EXISTS album_settings(id INTEGER PRIMARY KEY CHECK(id=1),config TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS album_items(id TEXT PRIMARY KEY,name TEXT NOT NULL,caption TEXT NOT NULL,filter TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,created TEXT NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS album_objects(id TEXT PRIMARY KEY,object_key TEXT NOT NULL,thumbnail_key TEXT);
            CREATE TABLE IF NOT EXISTS album_uploads(id TEXT PRIMARY KEY,token TEXT NOT NULL,name TEXT NOT NULL,caption TEXT NOT NULL,filter TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,expires INTEGER NOT NULL,completed INTEGER NOT NULL DEFAULT 0);''')
            c.execute('INSERT OR IGNORE INTO app_secrets(name,value) VALUES(?,?)',('album-thumbnails',secrets.token_urlsafe(48)))
            self.thumbnail_secret=c.execute('SELECT value FROM app_secrets WHERE name=?',('album-thumbnails',)).fetchone()[0]
        album_jobs.initialize(self)
    def config(self):
        with self.db.connect() as c:row=c.execute('SELECT config FROM album_settings WHERE id=1').fetchone()
        return json.loads(row[0]) if row else None
    def configure(self,body):
        old=self.config();title=body.get('title','Reva & Cesar');mode=body.get('mode','after');release=body.get('releaseAt','');preset=body.get('filter','film')
        if not isinstance(title,str) or not 1<=len(title.strip())<=120 or mode not in ('live','after') or preset not in FILTERS:raise AlbumError('Pengaturan album tidak valid.')
        if mode=='after':
            try:
                dt=datetime.fromisoformat(release.replace('Z','+00:00'))
                if dt.tzinfo is None:raise ValueError()
                release=dt.astimezone(timezone.utc).isoformat()
            except (ValueError,AttributeError):raise AlbumError('Isi tanggal dan jam pembukaan galeri.')
        else:release=''
        if type(body.get('uploadsOpen',True)) is not bool:raise AlbumError('Pengaturan unggahan tidak valid.')
        config={'title':title.strip(),'mode':mode,'releaseAt':release,'filter':preset,'uploadsOpen':body.get('uploadsOpen',True),'key':old['key'] if old else secrets.token_urlsafe(32)}
        with self.db.connect() as c:c.execute('INSERT OR REPLACE INTO album_settings VALUES(1,?)',(json.dumps(config),))
        self.db.backup(force=True);return config
    def opened(self,config):return config['mode']=='live' or datetime.now(timezone.utc)>=datetime.fromisoformat(config['releaseAt'])
    def public(self,config):
        with self.db.connect() as c:count=c.execute('SELECT count(*) FROM album_items WHERE hidden=0').fetchone()[0]
        return {**{k:v for k,v in config.items() if k!='key'},'revealed':self.opened(config),'count':count,'maxFileMB':MAX_FILE//1024//1024,'storage':'s3' if album_storage.enabled() else 'local'}
    def session(self,handler):
        config=self.config()
        try:
            jar=SimpleCookie();jar.load(handler.headers.get('Cookie',''));key=jar['temu_album'].value
        except (KeyError,ValueError):key=''
        if not config or not hmac.compare_digest(config['key'],key):raise AlbumError('Buka album melalui QR atau tautan dari pengantin.',403)
        return config
    def list_items(self,config,offset=0,admin=False):
        if not admin and not self.opened(config):raise AlbumError('Galeri belum dibuka. Momenmu tetap tersimpan dengan aman.',403)
        with self.db.connect() as c:
            rows=c.execute('SELECT i.id,i.name,i.caption,i.filter,i.mime,i.size,i.created,o.thumbnail_key FROM album_items i LEFT JOIN album_objects o ON i.id=o.id WHERE hidden=0 ORDER BY created DESC,i.id DESC LIMIT 25 OFFSET ?',(offset,)).fetchall()
        keys=('id','name','caption','filter','mime','size','created')
        return {'items':[{**dict(zip(keys,row[:7])),'thumbnail':bool(row[7]) or (self.directory/(row[0]+'.thumb.jpg')).is_file()} for row in rows[:24]],'next':offset+24 if len(rows)>24 else None}
    def read_body(self,h):
        size=int(h.headers.get('Content-Length','0'))
        if not 0<size<=4096:raise AlbumError('Permintaan unggahan tidak valid.')
        body=json.loads(h.rfile.read(size))
        if not isinstance(body,dict):raise AlbumError('Permintaan unggahan tidak valid.')
        return body
    def storage(self):
        if not album_storage.enabled():raise AlbumError('Unggahan langsung belum diaktifkan.',409)
        return album_storage.S3Storage()
    def clean_uploads(self,store):
        if not self.cleanup_lock.acquire(blocking=False):return
        try:
            with self.db.connect() as c:rows=c.execute("SELECT u.id,u.mime FROM album_uploads u LEFT JOIN album_jobs j ON u.id=j.id WHERE u.expires<? AND coalesce(j.state,'')!='running' LIMIT 4",(int(time.time()),)).fetchall()
            for item,mime in rows:
                store.delete(store.key('incoming',item,EXTENSIONS[mime]))
                with self.upload_lock,self.db.connect() as c:
                    c.execute('DELETE FROM album_requests WHERE item=?',(item,));c.execute('DELETE FROM album_jobs WHERE id=?',(item,));c.execute('DELETE FROM album_uploads WHERE id=? AND expires<?',(item,int(time.time())))
        finally:self.cleanup_lock.release()
    def begin_upload(self,h,config):
        if not config['uploadsOpen']:raise AlbumError('Unggahan album sudah ditutup.',403)
        body=self.read_body(h);size=body.get('size');mime=body.get('mime');preset=body.get('filter','original')
        name=body.get('name','');caption=body.get('caption','');request_id=body.get('requestId',secrets.token_hex(16))
        if not isinstance(request_id,str) or not re.fullmatch(r'[a-f0-9]{32}',request_id):raise AlbumError('Tiket unggahan tidak valid.')
        if type(size) is not int or not 12<=size<=MAX_FILE:raise AlbumError('Batas setiap file adalah 100 MB.',413)
        if mime not in EXTENSIONS or preset not in FILTERS:raise AlbumError('Format atau filter tidak valid.',415)
        if not isinstance(name,str) or not 1<=len(name.strip())<=80 or not isinstance(caption,str) or len(caption)>300:raise AlbumError('Nama atau cerita tidak valid.')
        store=self.storage()
        with self.upload_lock,self.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            old=c.execute('SELECT u.id,u.token,u.name,u.caption,u.filter,u.mime,u.size,u.expires,u.completed FROM album_requests r JOIN album_uploads u ON r.item=u.id WHERE r.request_id=?',(request_id,)).fetchone()
            if old:
                if tuple(old[2:7])!=(name.strip(),caption.strip(),preset,mime,size):raise AlbumError('Permintaan unggahan berubah.',409)
                if old[7]<int(time.time()) or old[8]!=0:raise AlbumError('Tiket sudah selesai atau kedaluwarsa. Bagikan ulang.',410)
                if c.execute('SELECT 1 FROM album_jobs WHERE id=?',(old[0],)).fetchone():raise AlbumError('Momen sedang diproses. Periksa status unggahan.',409)
                item,token=old[:2];remaining=min(600,old[7]-int(time.time())-300)
                if remaining<=0:raise AlbumError('Tiket kedaluwarsa. Bagikan ulang.',410)
            else:
                used,count=c.execute('SELECT coalesce(sum(size),0),count(*) FROM album_items').fetchone()
                reserved=c.execute('SELECT coalesce(sum(size),0) FROM album_uploads WHERE completed<=0').fetchone()[0]
                # An expired/deleted ticket stays reserved until staging cleanup
                # succeeds. Already completed URLs can still be reused until TTL.
                replay=c.execute('SELECT coalesce(sum(size),0) FROM album_uploads WHERE completed=1').fetchone()[0]
                if used+reserved+size>MAX_ALBUM:raise AlbumError('Album sudah penuh. Hubungi pengantin.',413)
                if used+2*(reserved+size)+replay+(count+album_jobs.PENDING_UPLOADS)*512*1024>album_jobs.STORAGE_BUDGET:raise AlbumError('Ruang penyimpanan sedang dicadangkan. Coba lagi sebentar.',429)
                pending=c.execute('SELECT count(*) FROM album_uploads WHERE completed=0').fetchone()[0]
                active=c.execute("SELECT count(*) FROM album_uploads u LEFT JOIN album_jobs j ON u.id=j.id WHERE u.completed=0 AND j.id IS NULL").fetchone()[0]
                if pending>=album_jobs.PENDING_UPLOADS or active>=album_jobs.ACTIVE_UPLOADS:raise AlbumError('Menunggu giliran unggah. Foto atau videomu tetap siap.',429)
                item=secrets.token_hex(16);token=secrets.token_urlsafe(32);remaining=600
                c.execute('INSERT INTO album_uploads VALUES(?,?,?,?,?,?,?,?,0)',(item,token,name.strip(),caption.strip(),preset,mime,size,int(time.time())+900))
                c.execute('INSERT INTO album_requests VALUES(?,?)',(request_id,item))
            url=store.presign('PUT',store.key('incoming',item,EXTENSIONS[mime]),expires=remaining,mime=mime,size=size)
        return {'id':item,'token':token,'url':url,'headers':{'Content-Type':mime},'expiresIn':remaining}
    def upload_record(self,item,body):
        with self.db.connect() as c:row=c.execute('SELECT token,name,caption,filter,mime,size,expires,completed FROM album_uploads WHERE id=?',(item,)).fetchone()
        if not row or not isinstance(body.get('token'),str) or not hmac.compare_digest(row[0],body['token']):raise AlbumError('Tiket unggahan tidak sesuai.',403)
        if row[6]<int(time.time()):raise AlbumError('Waktu unggahan habis. Silakan bagikan ulang.',410)
        if row[7]<0:raise AlbumError('Unggahan sudah dibatalkan. Silakan bagikan ulang.',410)
        return row
    def complete_upload(self,h,item,config):
        return album_jobs.enqueue(self,item,self.read_body(h),config)
    def upload_status(self,h,item):
        body=self.read_body(h)
        with self.upload_lock:self.upload_record(item,body)
        return album_jobs.response(self,item)
    def cancel_upload(self,h,item):
        body=self.read_body(h)
        with self.upload_lock,self.db.connect() as c:
            row=self.upload_record(item,body)
            if row[7]==1:raise AlbumError('Momen sudah tersimpan.',409)
            c.execute('UPDATE album_uploads SET completed=-1 WHERE id=?',(item,))
            c.execute("UPDATE album_jobs SET state='failed',error='Unggahan sudah dibatalkan.' WHERE id=?",(item,))
        # No synchronous S3 I/O; the expiry cleanup safely reaps staging.
        return {'ok':True}
    def upload(self,handler,config):
        if album_storage.enabled():raise AlbumError('Gunakan tiket unggahan langsung ke Object Storage.',409)
        if not config['uploadsOpen']:raise AlbumError('Unggahan album sudah ditutup.',403)
        try:size=int(handler.headers.get('Content-Length','0'))
        except ValueError:raise AlbumError('Ukuran file tidak valid.')
        if not 12<=size<=MAX_FILE:raise AlbumError('Batas setiap file adalah 100 MB.',413)
        mime=handler.headers.get('Content-Type','').split(';')[0]
        exts={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}
        if mime not in exts:raise AlbumError('Gunakan foto JPG, PNG, WebP atau video MP4, MOV, WebM.',415)
        # Serialized streaming keeps memory bounded and prevents concurrent quota overshoot.
        with self.upload_lock:
            with self.db.connect() as c:used=c.execute('SELECT coalesce(sum(size),0) FROM album_items').fetchone()[0]
            if used+size>MAX_ALBUM:raise AlbumError('Album sudah penuh. Hubungi pengantin.',413)
            handler.connection.settimeout(90);head=handler.rfile.read(min(32,size))
            if not valid_media(mime,head):raise AlbumError('Isi file tidak sesuai format foto atau video.',415)
            item=secrets.token_hex(16);tmp=None;target=self.directory/(item+exts[mime])
            try:
                with tempfile.NamedTemporaryFile(dir=self.directory,prefix='.upload-',delete=False) as f:
                    tmp=Path(f.name);os.chmod(tmp,0o600);f.write(head);remaining=size-len(head)
                    while remaining:
                        chunk=handler.rfile.read(min(65536,remaining))
                        if not chunk:raise AlbumError('Unggahan terputus. Silakan ulangi.')
                        f.write(chunk);remaining-=len(chunk)
                    f.flush();os.fsync(f.fileno())
                # Bound name/filter metadata; never use client filenames on disk.
                from urllib.parse import unquote
                name=unquote(handler.headers.get('X-Album-Name','Tamu'))[:80].strip() or 'Tamu'
                caption=unquote(handler.headers.get('X-Album-Caption',''))[:300].strip()
                preset=handler.headers.get('X-Album-Filter',config['filter'])
                if preset not in FILTERS:raise AlbumError('Filter tidak valid.')
                os.replace(tmp,target)
                with self.db.connect() as c:c.execute('INSERT INTO album_items VALUES(?,?,?,?,?,?,?,0)',(item,name,caption,preset,mime,size,stamp()))
            except Exception:
                target.unlink(missing_ok=True);raise
            finally:
                if tmp:tmp.unlink(missing_ok=True)
        return {'ok':True,'id':item,'thumbnailKey':self.thumbnail_key(item),'message':'Momen tersimpan. Terima kasih!'}
    def thumbnail_key(self,item):
        return hmac.new(self.thumbnail_secret.encode(),item.encode(),'sha256').hexdigest()
    def save_thumbnail(self,h,item):
        key=h.headers.get('X-Album-Thumbnail-Key','')
        if not hmac.compare_digest(key,self.thumbnail_key(item)):raise AlbumError('Akses pratinjau tidak sesuai.',403)
        with self.db.connect() as c:row=c.execute('SELECT mime FROM album_items WHERE id=?',(item,)).fetchone()
        if not row or not row[0].startswith('image/'):raise AlbumError('Foto tidak ditemukan.',404)
        size=int(h.headers.get('Content-Length','0'))
        if not 12<=size<=512*1024:raise AlbumError('Pratinjau terlalu besar.',413)
        h.connection.settimeout(20);data=h.rfile.read(size)
        if len(data)!=size or not data.startswith(b'\xff\xd8\xff') or not data.endswith(b'\xff\xd9'):raise AlbumError('Pratinjau tidak valid.',415)
        with tempfile.NamedTemporaryFile(dir=self.directory,prefix='.thumb-',delete=False) as f:
            temp=Path(f.name);f.write(data);f.flush();os.fsync(f.fileno())
        try:
            if not self.thumbnail_slots.acquire(blocking=False):raise AlbumError('Pratinjau sedang sibuk. Coba lagi sebentar.',429)
            try:
                with self.upload_lock,self.db.connect() as c:
                    exists=c.execute('SELECT 1 FROM album_items WHERE id=? AND hidden=0',(item,)).fetchone()
                    obj=c.execute('SELECT object_key FROM album_objects WHERE id=?',(item,)).fetchone()
                if not exists:raise AlbumError('Foto tidak ditemukan.',404)
                if obj:
                    store=self.storage();key=store.key('thumbnails',item,'.jpg');store.put_file(key,temp,'image/jpeg')
                    with self.upload_lock,self.db.connect() as c:
                        exists=c.execute('SELECT 1 FROM album_items WHERE id=? AND hidden=0',(item,)).fetchone()
                        if exists:c.execute('UPDATE album_objects SET thumbnail_key=? WHERE id=?',(key,item))
                    if not exists:store.delete(key)
                else:
                    with self.upload_lock:
                        with self.db.connect() as c:exists=c.execute('SELECT 1 FROM album_items WHERE id=? AND hidden=0',(item,)).fetchone()
                        if exists:os.replace(temp,self.directory/(item+'.thumb.jpg'))
            finally:self.thumbnail_slots.release()
        finally:temp.unlink(missing_ok=True)
        return {'ok':True}
    def remove(self,item=None,body=None):
        # Serialize against uploads so reset cannot remove an unfinished file.
        with self.upload_lock,self.db.lock,self.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if item is None:
                body=body or {};event=body.get('event');pin=body.get('pin')
                if not isinstance(event,str) or not isinstance(pin,str) or not re.fullmatch(r'\d{4,12}',pin):raise AlbumError('Masukkan kembali PIN pengelola.',400)
                if not self.db.verify_pin(event,pin):raise AlbumError('PIN tidak sesuai atau acara belum terhubung.',403)
                count=c.execute('SELECT count(*) FROM album_items WHERE hidden=0').fetchone()[0]
                if type(body.get('count')) is not int or body['count']!=count:raise AlbumError('Isi album berubah. Perbarui album sebelum menghapus semuanya.',409)
            rows=c.execute('SELECT id,mime FROM album_items'+(' WHERE id=?' if item else ''),(item,) if item else ()).fetchall()
            if item and not rows:raise AlbumError('Momen tidak ditemukan.',404)
            extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}
            # Hide first: partial disk errors never leave deleted media publicly visible.
            for identifier,_ in rows:c.execute('UPDATE album_items SET hidden=1 WHERE id=?',(identifier,))
            c.commit()
            # Reset invalidates pending completions; staging keys remain queued
            # for deletion after their PUT URL can no longer be reused.
            if item is None:
                c.execute('UPDATE album_uploads SET completed=-1 WHERE completed=0')
                c.execute("UPDATE album_jobs SET state='failed',error='Album telah direset.' WHERE state IN ('queued','running')");c.commit()
            for identifier,mime in rows:
                obj=c.execute('SELECT object_key,thumbnail_key FROM album_objects WHERE id=?',(identifier,)).fetchone()
                if obj:
                    store=self.storage()
                    for key in obj:
                        if key:store.delete(key)
                    c.execute('DELETE FROM album_objects WHERE id=?',(identifier,))
                c.execute('UPDATE album_uploads SET completed=-1 WHERE id=?',(identifier,))
                (self.directory/(identifier+extensions[mime])).unlink(missing_ok=True)
                (self.directory/(identifier+'.thumb.jpg')).unlink(missing_ok=True)
                c.execute('DELETE FROM album_items WHERE id=?',(identifier,))
            c.commit()
        self.db.backup(force=True)
        return {'ok':True,'removed':len(rows)}
    def serve_file(self,h,item,config,admin=False):
        if not admin and not self.opened(config):raise AlbumError('Galeri belum dibuka.',403)
        with self.db.connect() as c:row=c.execute('SELECT mime,size FROM album_items WHERE id=? AND hidden=0',(item,)).fetchone()
        if not row:raise AlbumError('Momen tidak ditemukan.',404)
        mime,size=row;ext={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}[mime]
        with self.db.connect() as c:obj=c.execute('SELECT object_key,thumbnail_key FROM album_objects WHERE id=?',(item,)).fetchone()
        if obj:
            query=parse_qs(urlsplit(h.path).query);key=obj[1] if query.get('thumb')==['1'] and obj[1] else obj[0]
            download='momen-'+item[:8]+ext if query.get('download')==['1'] else None
            url=self.storage().presign('HEAD' if h.command=='HEAD' else 'GET',key,expires=300,download=download)
            h.send_response(307);h.send_header('Location',url);h.send_header('Cache-Control','private, no-store');h.send_header('Content-Length','0');h.end_headers();return
        file=self.directory/(item+ext)
        if not file.is_file():raise AlbumError('File belum tersedia.',404)
        if parse_qs(urlsplit(h.path).query).get('thumb')==['1']:
            thumbnail=self.directory/(item+'.thumb.jpg')
            if thumbnail.is_file():file=thumbnail;mime='image/jpeg';size=file.stat().st_size
        start=0;end=size-1;status=200
        value=h.headers.get('Range')
        if value:
            m=re.fullmatch(r'bytes=(\d*)-(\d*)',value)
            if not m or not any(m.groups()):raise AlbumError('Rentang tidak valid.',416)
            if not m[1]:start=max(0,size-int(m[2]))
            else:start=int(m[1]);end=min(end,int(m[2])) if m[2] else end
            if start>end or start>=size:raise AlbumError('Rentang tidak valid.',416)
            status=206
        h.send_response(status);h.send_header('Content-Type',mime);h.send_header('Cache-Control','private, no-store');h.send_header('Accept-Ranges','bytes');h.send_header('Content-Length',str(end-start+1));h.send_header('Cross-Origin-Resource-Policy','same-origin')
        if status==206:h.send_header('Content-Range',f'bytes {start}-{end}/{size}')
        if parse_qs(urlsplit(h.path).query).get('download')==['1']:h.send_header('Content-Disposition',f'attachment; filename="momen-{item[:8]}{ext}"')
        h.end_headers()
        if h.command=='HEAD':return
        with file.open('rb') as f:
            f.seek(start);remaining=end-start+1
            while remaining:
                chunk=f.read(min(65536,remaining))
                if not chunk:break
                h.wfile.write(chunk);remaining-=len(chunk)
    def handle(self,h):
        path=urlsplit(h.path).path
        if not path.startswith('/api/album/'):return False
        try:
            if not h.safe_host():raise AlbumError('Host tidak diizinkan.',403)
            if h.command in ('POST','PUT','DELETE'):
                origin=h.headers.get('Origin')
                if h.headers.get('X-Temu-Album')!='1' or h.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and urlsplit(origin).netloc!=h.headers.get('Host')):raise AlbumError('Permintaan tidak diizinkan.',403)
            if path.startswith('/api/album/admin/'):
                if not h.authorized():raise AlbumError('Akses pengelola diperlukan.',401)
                config=self.config()
                if path=='/api/album/admin/migration' and h.command=='POST':h.reply(200,self.import_archive(h))
                elif path=='/api/album/admin/items' and h.command in ('GET','HEAD'):
                    offset=int(parse_qs(urlsplit(h.path).query).get('offset',['0'])[0])
                    if not 0<=offset<=100000:raise AlbumError('Halaman tidak valid.')
                    h.reply(200,{**self.list_items(config,offset,admin=True),'count':self.public(config)['count'] if config else 0})
                elif re.fullmatch(r'/api/album/admin/file/[a-f0-9]{32}',path) and h.command in ('GET','HEAD'):self.serve_file(h,path.rsplit('/',1)[1],config,admin=True)
                elif re.fullmatch(r'/api/album/admin/items/[a-f0-9]{32}',path) and h.command=='DELETE':h.reply(200,self.remove(path.rsplit('/',1)[1]))
                elif path=='/api/album/admin/items' and h.command=='DELETE':
                    size=int(h.headers.get('Content-Length','0'))
                    if not 0<size<=1024:raise AlbumError('Permintaan tidak valid.')
                    h.reply(200,self.remove(body=json.loads(h.rfile.read(size))))
                else:raise AlbumError('Tidak ditemukan.',404)
            elif path=='/api/album/admin':
                if not h.authorized():raise AlbumError('Hubungkan server sebagai pengelola terlebih dahulu.',401)
                if h.command in ('GET','HEAD'):h.reply(200,{'config':self.config()})
                elif h.command=='POST':
                    size=int(h.headers.get('Content-Length','0'))
                    if not 0<size<=4096:raise AlbumError('Pengaturan tidak valid.')
                    h.reply(200,{'config':self.configure(json.loads(h.rfile.read(size)))})
                else:raise AlbumError('Metode tidak diizinkan.',405)
            elif path=='/api/album/join' and h.command=='POST':
                size=int(h.headers.get('Content-Length','0'))
                if not 0<size<=1024:raise AlbumError('Tautan tidak valid.')
                body=json.loads(h.rfile.read(size));config=self.config()
                if not config or not isinstance(body.get('key'),str) or not hmac.compare_digest(config['key'],body['key']):raise AlbumError('QR album belum tersedia atau tautan tidak sesuai.',403)
                local=h.headers.get('Host','').split(':')[0] in ('localhost','127.0.0.1')
                cookie=f"temu_album={config['key']}; Path=/api/album; HttpOnly; SameSite=Lax; Max-Age=2592000"+('' if local else '; Secure')
                h.reply(200,self.public(config),cookie)
            else:
                config=self.session(h)
                if path=='/api/album/info' and h.command in ('GET','HEAD'):h.reply(200,self.public(config))
                elif path=='/api/album/uploads' and h.command=='POST':h.reply(200,self.begin_upload(h,config))
                elif re.fullmatch(r'/api/album/uploads/[a-f0-9]{32}/complete',path) and h.command=='POST':
                    result=self.complete_upload(h,path.split('/')[-2],config);h.reply(202 if result.get('pending') else 201,result)
                elif re.fullmatch(r'/api/album/uploads/[a-f0-9]{32}/status',path) and h.command=='POST':h.reply(200,self.upload_status(h,path.split('/')[-2]))
                elif re.fullmatch(r'/api/album/uploads/[a-f0-9]{32}/cancel',path) and h.command=='POST':h.reply(200,self.cancel_upload(h,path.split('/')[-2]))
                elif path=='/api/album/items' and h.command in ('GET','HEAD'):
                    offset=int(parse_qs(urlsplit(h.path).query).get('offset',['0'])[0])
                    if not 0<=offset<=100000:raise AlbumError('Halaman tidak valid.')
                    h.reply(200,self.list_items(config,offset))
                elif path=='/api/album/upload' and h.command=='PUT':h.reply(201,self.upload(h,config))
                elif re.fullmatch(r'/api/album/thumbnail/[a-f0-9]{32}',path) and h.command=='PUT':h.reply(200,self.save_thumbnail(h,path.rsplit('/',1)[1]))
                elif re.fullmatch(r'/api/album/file/[a-f0-9]{32}',path) and h.command in ('GET','HEAD'):self.serve_file(h,path.rsplit('/',1)[1],config)
                else:raise AlbumError('Tidak ditemukan.',404)
        except AlbumError as e:
            # Avoid reusing a connection containing unread rejected upload bytes.
            h.close_connection=True;h.reply(e.status,{'error':str(e),**({'retryAfter':6} if e.status==429 else {})})
        except album_storage.StorageError as e:h.close_connection=True;h.reply(503,{'error':str(e)})
        except (ValueError,TypeError,KeyError,tarfile.TarError):h.close_connection=True;h.reply(400,{'error':'Permintaan album tidak valid.'})
        except (BrokenPipeError,ConnectionResetError):pass
        except (OSError,TimeoutError):h.close_connection=True;h.reply(503,{'error':'Album belum dapat diakses. Silakan coba lagi.'})
        return True
