"""Copy album-only data to an empty separate service. Source stays intact."""
import argparse,http.client,json,os,sqlite3,tarfile,tempfile
from pathlib import Path
from album_proxy import internal_target

def main():
 parser=argparse.ArgumentParser();parser.add_argument('--data-dir',default='/data');args=parser.parse_args();root=Path(args.data_dir)
 conn=sqlite3.connect(root/'temu.sqlite3');conn.row_factory=sqlite3.Row
 row=conn.execute('SELECT config FROM album_settings WHERE id=1').fetchone()
 if not row:raise SystemExit('Source album is not configured; configure the new album normally.')
 config=json.loads(row[0]);items=[dict(r) for r in conn.execute('SELECT id,name,caption,filter,mime,size,created FROM album_items WHERE hidden=0')];conn.close()
 extensions={'image/jpeg':'.jpg','image/png':'.png','image/webp':'.webp','video/mp4':'.mp4','video/quicktime':'.mov','video/webm':'.webm'}
 with tempfile.TemporaryDirectory(dir=root,prefix='.album-transfer-') as folder:
  folder=Path(folder);manifest=folder/'manifest.json';manifest.write_text(json.dumps({'config':config,'items':items}));archive=folder/'album.tar'
  with tarfile.open(archive,'w:') as out:
   out.add(manifest,arcname='manifest.json')
   for item in items:
    name=item['id']+extensions[item['mime']];out.add(root/'album-media'/name,arcname=name)
    thumbnail=root/'album-media'/(item['id']+'.thumb.jpg')
    if thumbnail.exists():out.add(thumbnail,arcname=thumbnail.name)
  size=archive.stat().st_size
  if size>256*1024*1024:raise SystemExit('Migration bundle exceeds 256 MB; use a streamed maintenance migration.')
  host,port=internal_target(os.environ['TEMU_ALBUM_UPSTREAM_URL']);http=http.client.HTTPConnection(host,port,timeout=90)
  try:
   http.putrequest('POST','/api/album/admin/migration');http.putheader('Authorization','Bearer '+os.environ['TEMU_SERVER_TOKEN']);http.putheader('X-Temu-Album-Proxy',os.environ['TEMU_ALBUM_PROXY_KEY']);http.putheader('X-Temu-Album','1');http.putheader('Content-Type','application/x-tar');http.putheader('Content-Length',str(size));http.endheaders()
   with archive.open('rb') as f:
    while chunk:=f.read(65536):http.send(chunk)
   response=http.getresponse();data=json.loads(response.read(8192))
   if response.status!=200:raise SystemExit('Migration failed: '+data.get('error','server unavailable'))
   print('Album migrated:',data['imported'],'items. Original QR, metadata and source files preserved.')
  finally:http.close()
if __name__=='__main__':main()
