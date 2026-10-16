"""One durable, low-priority video preview job at a time; originals never change."""
import json, math, os, secrets, shutil, signal, sqlite3, subprocess, tempfile, threading, time
from pathlib import Path
import album_storage

MAX_PREVIEW=100*1024*1024
LEASE=1200

class VideoError(Exception):pass

def initialize(album):
    album.video_slot=threading.Lock();album.video_start_lock=threading.Lock();album.video_thread=None
    with album.db.connect() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS album_video_jobs(
            id TEXT PRIMARY KEY,state TEXT NOT NULL,claim TEXT NOT NULL,ready REAL NOT NULL,
            attempts INTEGER NOT NULL,object_key TEXT,size INTEGER NOT NULL DEFAULT 0)''')

def run(command,timeout,stop):
    process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,start_new_session=True)
    try:
        try:os.setpriority(os.PRIO_PROCESS,process.pid,10)
        except (AttributeError,OSError):pass
        # Bound the child below the pod's memory limit so failed encoding keeps
        # the HTTP process alive, including on the existing 512 MB album pod.
        if hasattr(os,'uname') and os.uname().sysname=='Linux':
            import resource
            limit=768*1024*1024
            for filename in ('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes'):
                try:limit=min(limit,int(Path(filename).read_text())*2//3)
                except (OSError,ValueError):pass
            try:resource.prlimit(process.pid,resource.RLIMIT_AS,(limit,limit))
            except ProcessLookupError:pass
        deadline=time.monotonic()+timeout
        while not stop.is_set() and time.monotonic()<deadline:
            try:
                output,_=process.communicate(timeout=1)
                if process.returncode:raise VideoError('Video preview encoder failed.')
                return output
            except subprocess.TimeoutExpired:pass
        raise VideoError('Video preview cancelled or timed out.')
    finally:
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
        process.wait()

def probe(path,stop):
    data=json.loads(run(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm',
        '-select_streams','v:0','-show_entries','stream=width,height,color_transfer:format=duration','-of','json',str(path)],20,stop))
    video=data['streams'][0];duration=float(data['format']['duration']);width=int(video['width']);height=int(video['height'])
    if not math.isfinite(duration) or not 0<duration<=600 or not 0<width<=4096 or not 0<height<=4096 or width*height>9000000:
        raise VideoError('Video exceeds preview processing limits.')
    return video,duration

def compress(source,target,stop):
    video,duration=probe(source,stop)
    hdr=video.get('color_transfer') in ('smpte2084','arib-std-b67')
    filters="scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1"
    if hdr:
        filters+=',zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv'
    filters+=",format=yuv420p,fps=fps='min(source_fps,30)'"
    color=['-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv',
        '-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709'] if hdr else []
    run(['ffmpeg','-nostdin','-hide_banner','-v','error','-y','-max_alloc','67108864','-threads','1','-filter_threads','1',
        '-protocol_whitelist','file,pipe','-format_whitelist','mov,matroska,webm','-i',str(source),
        '-map','0:v:0','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1','-vf',filters,
        '-c:v','libx264','-preset','veryfast','-crf','22','-maxrate','6M','-bufsize','12M','-threads','1',
        '-c:a','aac','-b:a','128k','-ac','2','-movflags','+faststart','-fs',str(MAX_PREVIEW),*color,str(target)],600,stop)
    _,result_duration=probe(target,stop)
    if abs(duration-result_duration)>max(.25,duration*.01):raise VideoError('Video preview is incomplete.')
    size=target.stat().st_size
    if not 12<=size<=MAX_PREVIEW:raise VideoError('Video preview size is invalid.')
    return size<source.stat().st_size

def process_next(album,stop=None):
    stop=stop or threading.Event()
    if stop.is_set():return False
    if not album.video_slot.acquire(blocking=False):return False
    item=None;target=None;store=None;published=False;claim=secrets.token_hex(16)
    try:
        with album.upload_lock,album.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute("SELECT 1 FROM album_video_jobs WHERE state='running' AND ready>?",(time.time(),)).fetchone():return False
            row=c.execute('''SELECT i.id,i.mime,i.size,o.object_key,coalesce(v.attempts,0),v.object_key
                FROM album_items i LEFT JOIN album_objects o ON o.id=i.id LEFT JOIN album_video_jobs v ON v.id=i.id
                WHERE i.hidden=0 AND i.mime LIKE 'video/%' AND
                (v.id IS NULL OR (v.state IN ('queued','running') AND v.ready<=?))
                ORDER BY i.created,i.id LIMIT 1''',(time.time(),)).fetchone()
            if not row:return False
            item,mime,size,original,attempts,stale=row
            c.execute("INSERT OR REPLACE INTO album_video_jobs(id,state,claim,ready,attempts,object_key) VALUES(?,'running',?,?,?,?)",(item,claim,time.time()+LEASE,attempts+1,stale))
        from album import EXTENSIONS
        if original:store=album.storage()
        if stale:
            if store:store.delete(stale)
            else:(album.directory/stale).unlink(missing_ok=True)
            with album.db.connect() as c:c.execute('UPDATE album_video_jobs SET object_key=NULL WHERE id=? AND claim=?',(item,claim))
        local=album.directory if not original else None
        with album_storage.temporary_space(MAX_PREVIEW+(size if original else 0),local),tempfile.TemporaryDirectory(prefix='.video-',dir=local) as directory:
            folder=Path(directory);source=album.directory/(item+EXTENSIONS[mime]);preview=folder/'preview.mp4'
            if original:
                source=folder/('original'+EXTENSIONS[mime]);actual,content,etag,_=store.inspect(original)
                if actual!=size or content!=mime or not etag:raise VideoError('Original video changed.')
                store.request('GET',original,headers={'If-Match':etag},output=source,expected=size)
            smaller=compress(source,preview,stop)
            if stop.is_set():raise VideoError('Video preview cancelled.')
            if not smaller:
                with album.db.connect() as c:c.execute("UPDATE album_video_jobs SET state='skipped',ready=0 WHERE id=? AND claim=?",(item,claim))
                return True
            preview_size=preview.stat().st_size
            with album.upload_lock,album.db.connect() as c:
                current=c.execute("SELECT 1 FROM album_items i JOIN album_video_jobs v ON i.id=v.id WHERE i.id=? AND i.hidden=0 AND v.state='running' AND v.claim=?",(item,claim)).fetchone()
                if not current:raise VideoError('Video was removed.')
                if original:
                    used=c.execute('SELECT coalesce(sum(size),0) FROM album_items').fetchone()[0]
                    previews=c.execute("SELECT coalesce(sum(size),0) FROM album_video_jobs WHERE state='done'").fetchone()[0]
                    import album_jobs
                    if used+previews+preview_size>album_jobs.STORAGE_BUDGET:raise VideoError('Preview storage budget exhausted.')
                target=store.key('previews',claim,'.mp4') if original else claim+'.preview.mp4'
                # Persist the destination before upload so a restarted job can reap it.
                c.execute('UPDATE album_video_jobs SET object_key=? WHERE id=? AND claim=?',(target,item,claim))
            if store:store.put_file(target,preview,'video/mp4')
            with album.upload_lock,album.db.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                current=c.execute("SELECT 1 FROM album_items i JOIN album_video_jobs v ON i.id=v.id WHERE i.id=? AND i.hidden=0 AND v.state='running' AND v.claim=?",(item,claim)).fetchone()
                if not current:raise VideoError('Video was removed.')
                if not store:os.replace(preview,album.directory/target)
                c.execute("UPDATE album_video_jobs SET state='done',object_key=?,size=?,ready=0 WHERE id=? AND claim=?",(target,preview_size,item,claim))
            published=True
            print('Video preview ready:',item,'original bytes:',size,'preview bytes:',preview_size,flush=True)
        return True
    except (VideoError,album_storage.StorageError,OSError,ValueError,TypeError,KeyError,IndexError) as error:
        if item:
            with album.db.connect() as c:
                retry=stop.is_set() or isinstance(error,(album_storage.StorageError,OSError)) and attempts<2
                c.execute("UPDATE album_video_jobs SET state=?,ready=? WHERE id=? AND claim=? AND state='running'",('queued' if retry else 'failed',time.time()+(0 if stop.is_set() else 30),item,claim))
            print('Video preview deferred; original retained:',item,str(error) if isinstance(error,VideoError) else type(error).__name__,flush=True)
        else:raise
        return True
    finally:
        if target and not published:
            try:
                if store:store.delete(target)
                else:(album.directory/target).unlink(missing_ok=True)
                with album.db.connect() as c:c.execute('UPDATE album_video_jobs SET object_key=NULL WHERE id=? AND claim=? AND state!=?',(item,claim,'done'))
            except (album_storage.StorageError,OSError):pass
        album.video_slot.release()

def start_worker(album,stop):
    with album.video_start_lock:
        if album.video_thread is not None:return album.video_thread
        if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
            print('Video preview worker unavailable: install ffmpeg and ffprobe; originals retained.',flush=True);return None
        for directory in album.directory.glob('.video-*'):
            try:
                if directory.is_dir() and directory.stat().st_mtime<time.time()-LEASE:shutil.rmtree(directory)
            except OSError:pass
        def work():
            while not stop.is_set():
                try:
                    if not process_next(album,stop):stop.wait(3)
                except (sqlite3.Error,OSError):
                    # A temporary database fault must not stop future previews.
                    print('Video preview worker paused; originals retained.',flush=True);stop.wait(10)
        album.video_thread=threading.Thread(target=work,name='temu-album-video',daemon=True);album.video_thread.start()
        print('Video preview worker ready; concurrency: 1; originals retained.',flush=True)
        return album.video_thread
