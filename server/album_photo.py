"""Durable photo thumbnails; shares the single encoder slot with video previews."""
import json,os,re,secrets,sqlite3,tempfile,threading,time
from pathlib import Path
import album_storage,album_video

LEASE=600
PRESETS=Path(__file__).resolve().parents[1]/'dist/album-presets'
CATALOG={p['id']:p for p in json.loads((PRESETS/'catalog.json').read_text())['presets']}

class PhotoError(Exception):pass

def initialize(album):
    with album.db.connect() as c:
        c.execute('''CREATE TABLE IF NOT EXISTS album_photo_jobs(
            id TEXT PRIMARY KEY,state TEXT NOT NULL,claim TEXT NOT NULL,ready REAL NOT NULL,
            attempts INTEGER NOT NULL,object_key TEXT)''')

def apply_preset(data,width,height,preset):
    record=CATALOG.get(preset)
    if not record:return data
    lut=(PRESETS/record['lut']).read_bytes()
    if len(lut)!=17**3*3:raise PhotoError('Photo preset is incomplete.')
    grain=max(0,min(100,record['grain']))*.3;vignette=max(-100,min(100,record['vignette']))/100
    output=bytearray(len(data));seed=20261121
    # Match the browser's tetrahedral LUT, deterministic grain and vignette.
    for i in range(0,len(data),3):
        positions=[value*16/255 for value in data[i:i+3]];base=[min(15,int(value)) for value in positions]
        fr,fg,fb=[value-low for value,low in zip(positions,base)];p=(base[0]+base[1]*17+base[2]*289)*3
        if fr>=fg:
            if fg>=fb:first,second,high,middle,low=3,51,fr,fg,fb
            elif fr>=fb:first,second,high,middle,low=3,867,fr,fb,fg
            else:first,second,high,middle,low=867,3,fb,fr,fg
        elif fr>=fb:first,second,high,middle,low=51,3,fg,fr,fb
        elif fg>=fb:first,second,high,middle,low=51,867,fg,fb,fr
        else:first,second,high,middle,low=867,51,fb,fg,fr
        noise=0;shade=1
        if grain:seed=(seed*1664525+1013904223)&0xffffffff;noise=((seed>>24)/255-.5)*grain
        if vignette:
            pixel=i//3;x=pixel%width;y=pixel//width;edge=min(1,((x/width-.5)**2+(y/height-.5)**2)*2);shade=1+vignette*edge*.55
        for channel in range(3):output[i+channel]=max(0,min(255,round((lut[p+channel]*(1-high)+lut[p+first+channel]*(high-middle)+lut[p+first+second+channel]*(middle-low)+lut[p+921+channel]*low+noise)*shade)))
    return output

def thumbnail(source,target,preset,stop):
    formats='jpeg_pipe,png_pipe,webp_pipe'
    image_format={'.jpg':'jpeg_pipe','.jpeg':'jpeg_pipe','.png':'png_pipe','.webp':'webp_pipe'}.get(source.suffix.lower())
    if not image_format:raise PhotoError('Photo format is unsupported.')
    metadata=json.loads(album_video.run(['ffprobe','-v','error','-protocol_whitelist','file,pipe','-format_whitelist',formats,
        '-f',image_format,'-select_streams','v:0','-show_entries','stream=width,height','-of','json',str(source)],15,stop))
    stream=metadata['streams'][0];w=int(stream['width']);h=int(stream['height'])
    if not 0<w<=8192 or not 0<h<=8192 or w*h>40000000:raise PhotoError('Photo exceeds thumbnail processing limits; original retained.')
    pixels=target.with_suffix('.ppm')
    album_video.run(['ffmpeg','-nostdin','-v','error','-y','-max_alloc','67108864','-threads','1','-filter_threads','1',
        '-protocol_whitelist','file,pipe','-format_whitelist',formats,'-f',image_format,'-i',str(source),'-frames:v','1',
        '-vf',"scale=w='min(iw,720)':h='min(ih,720)':force_original_aspect_ratio=decrease",'-pix_fmt','rgb24','-c:v','ppm','-threads','1',str(pixels)],30,stop)
    if pixels.stat().st_size>720*720*3+128:raise PhotoError('Thumbnail exceeds processing limits.')
    raw=pixels.read_bytes();header=re.match(br'P6\s+(\d+)\s+(\d+)\s+255\s',raw)
    if not header:raise PhotoError('Thumbnail decoder returned an invalid image.')
    width,height=map(int,header.groups());data=raw[header.end():]
    if not 0<width<=720 or not 0<height<=720 or len(data)!=width*height*3:raise PhotoError('Thumbnail pixels are incomplete.')
    if preset.startswith('lr-'):pixels.write_bytes(raw[:header.end()]+apply_preset(data,width,height,preset))
    album_video.run(['ffmpeg','-nostdin','-v','error','-y','-max_alloc','67108864','-threads','1','-filter_threads','1',
        '-protocol_whitelist','file,pipe','-format_whitelist','ppm_pipe','-i',str(pixels),'-frames:v','1','-c:v','mjpeg','-q:v','5','-threads','1',str(target)],15,stop)
    if not 12<=target.stat().st_size<=512*1024:raise PhotoError('Thumbnail output is too large.')

def process_next(album,stop=None):
    from album import AlbumError,EXTENSIONS
    stop=stop or threading.Event()
    if stop.is_set() or not album.video_slot.acquire(blocking=False):return False
    item=None;target=None;store=None;published=False;claim=secrets.token_hex(16)
    try:
        with album.upload_lock,album.db.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if c.execute("SELECT 1 FROM album_photo_jobs WHERE state='running' AND ready>?",(time.time(),)).fetchone():return False
            row=c.execute('''SELECT i.id,i.mime,i.size,i.filter,o.object_key,coalesce(j.attempts,0),j.object_key,o.thumbnail_key
                FROM album_items i LEFT JOIN album_objects o ON o.id=i.id LEFT JOIN album_photo_jobs j ON j.id=i.id
                WHERE i.hidden=0 AND i.mime LIKE 'image/%' AND (j.id IS NULL OR (j.state IN ('queued','running') AND j.ready<=?))
                ORDER BY i.created DESC,i.id LIMIT 1''',(time.time(),)).fetchone()
            if not row:return False
            item,mime,size,preset,original,attempts,stale,existing=row
            c.execute("INSERT OR REPLACE INTO album_photo_jobs VALUES(?,'running',?,?,?,?)",(item,claim,time.time()+LEASE,attempts+1,stale))
        if original:store=album.storage()
        if stale and store and stale!=existing:store.delete(stale)
        if existing or not original and (album.directory/(item+'.thumb.jpg')).is_file():
            with album.db.connect() as c:c.execute("UPDATE album_photo_jobs SET state='done',ready=0,object_key=NULL WHERE id=? AND claim=?",(item,claim))
            return True
        with album_storage.temporary_space(size+3*1024*1024,album.directory),tempfile.TemporaryDirectory(dir=album.directory,prefix='.photo-') as directory:
            folder=Path(directory);source=album.directory/(item+EXTENSIONS[mime]);preview=folder/'thumbnail.jpg'
            if original:
                source=folder/('original'+EXTENSIONS[mime]);store.request('GET',original,output=source,expected=size)
            thumbnail(source,preview,preset,stop)
            if stop.is_set():raise PhotoError('Thumbnail processing stopped.')
            target=store.key('thumbnails',claim,'.jpg') if store else None
            with album.upload_lock,album.db.connect() as c:
                current=c.execute("SELECT 1 FROM album_items i JOIN album_photo_jobs j ON i.id=j.id WHERE i.id=? AND i.hidden=0 AND j.claim=? AND j.state='running'",(item,claim)).fetchone()
                if not current:raise PhotoError('Photo was removed.')
                c.execute('UPDATE album_photo_jobs SET object_key=? WHERE id=? AND claim=?',(target,item,claim))
            if store:store.put_file(target,preview,'image/jpeg')
            with album.upload_lock,album.db.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                current=c.execute("SELECT 1 FROM album_items i JOIN album_photo_jobs j ON i.id=j.id WHERE i.id=? AND i.hidden=0 AND j.claim=? AND j.state='running'",(item,claim)).fetchone()
                if not current:raise PhotoError('Photo was removed.')
                if store:published=bool(c.execute('UPDATE album_objects SET thumbnail_key=? WHERE id=? AND thumbnail_key IS NULL',(target,item)).rowcount)
                else:
                    local=album.directory/(item+'.thumb.jpg')
                    if not local.exists():os.replace(preview,local)
                    published=True
                c.execute("UPDATE album_photo_jobs SET state='done',ready=0,object_key=NULL WHERE id=? AND claim=?",(item,claim))
        return True
    except (AlbumError,PhotoError,album_video.VideoError,album_storage.StorageError,OSError,ValueError,KeyError,IndexError,sqlite3.Error) as error:
        if item:
            with album.db.connect() as c:c.execute("UPDATE album_photo_jobs SET state=?,ready=? WHERE id=? AND claim=?",('queued' if attempts<2 or stop.is_set() else 'failed',time.time()+(0 if stop.is_set() else 30),item,claim))
        if item is None:raise
        print('Photo thumbnail deferred; original retained:',item,str(error) if isinstance(error,(PhotoError,album_video.VideoError)) else type(error).__name__,flush=True)
        return True
    finally:
        if target and not published:
            try:store.delete(target)
            except (album_storage.StorageError,OSError):pass
        album.video_slot.release()
