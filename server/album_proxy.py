"""Bounded streaming gateway: keep /album API on the invitation's origin."""
import http.client,json,threading
from urllib.parse import urlsplit

def internal_target(url):
    p=urlsplit(url)
    if p.scheme!='http' or not p.hostname or p.username or p.query or p.fragment or p.path not in ('','/') or not (p.hostname in ('localhost','127.0.0.1') or p.hostname.endswith('.svc.cluster.local')):
        raise ValueError('Album upstream must be an internal cluster HTTP address.')
    return p.hostname,p.port or 8080

class AlbumProxy:
    def __init__(self,url,key,token):
        self.host,self.port=internal_target(url)
        if len(key)<32:raise ValueError('TEMU_ALBUM_PROXY_KEY minimal 32 karakter.')
        self.key=key;self.token=token;self.slots=threading.BoundedSemaphore(4)
    def config(self):
        connection=http.client.HTTPConnection(self.host,self.port,timeout=3)
        try:
            connection.request('GET','/api/album/admin',headers={'Authorization':'Bearer '+self.token,'X-Temu-Album-Proxy':self.key})
            r=connection.getresponse()
            return json.loads(r.read(16384)).get('config') if r.status==200 else None
        except (OSError,ValueError,http.client.HTTPException):return None
        finally:connection.close()
    def handle(self,h):
        if not urlsplit(h.path).path.startswith('/api/album/'):return False
        if urlsplit(h.path).path=='/api/album/admin/migration':h.reply(404,{'error':'Tidak ditemukan.'});return True
        origin=h.headers.get('Origin')
        if not h.safe_host() or h.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and urlsplit(origin).netloc!=h.headers.get('Host')):
            h.close_connection=True;h.reply(403,{'error':'Permintaan tidak diizinkan.'});return True
        if h.command not in ('GET','HEAD','POST','PUT','DELETE'):h.reply(405,{'error':'Metode tidak diizinkan.'});return True
        try:size=int(h.headers.get('Content-Length','0'))
        except ValueError:size=-1
        if not 0<=size<=100*1024*1024 or h.headers.get('Transfer-Encoding'):
            h.close_connection=True;h.reply(413,{'error':'Ukuran unggahan tidak valid.'});return True
        if not self.slots.acquire(blocking=False):
            h.close_connection=True;h.reply(503,{'error':'Album sedang sibuk. Coba lagi sebentar; buku tamu tetap dapat digunakan.'});return True
        connection=http.client.HTTPConnection(self.host,self.port,timeout=90 if h.command=='PUT' else 8);started=False
        try:
            connection.connect();connection.putrequest(h.command,h.path,skip_host=True,skip_accept_encoding=True)
            allowed={'host','origin','cookie','authorization','content-type','content-length','range','sec-fetch-site','x-temu-album','x-album-name','x-album-caption','x-album-filter','x-album-thumbnail-key'}
            for name,value in h.headers.items():
                if name.lower() in allowed:connection.putheader(name,value)
            connection.putheader('X-Temu-Album-Proxy',self.key);connection.endheaders()
            if size:
                h.connection.settimeout(90);remaining=size
                while remaining:
                    chunk=h.rfile.read(min(65536,remaining))
                    if not chunk:raise ConnectionError('Upload interrupted')
                    connection.send(chunk);remaining-=len(chunk)
            r=connection.getresponse();h.send_response(r.status)
            for name,value in r.getheaders():
                if name.lower() in ('content-type','content-length','content-range','content-disposition','set-cookie','accept-ranges','cross-origin-resource-policy'):h.send_header(name,value)
            h.send_header('Cache-Control','private, no-store');h.end_headers();started=True
            if h.command!='HEAD':
                while True:
                    chunk=r.read(65536)
                    if not chunk:break
                    h.wfile.write(chunk)
        except (OSError,TimeoutError,http.client.HTTPException):
            h.close_connection=True
            if not started:h.reply(503,{'error':'Album sementara tidak tersedia. Buku tamu dan undangan tetap dapat digunakan.'})
        finally:connection.close();self.slots.release()
        return True
