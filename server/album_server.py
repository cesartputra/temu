"""Independent album process and volume; no guest state is copied here."""
import argparse,hmac,json,os,sqlite3,threading,time
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit
import http.client
from album import Album
from album_proxy import internal_target
from server import Database,encode

class AlbumDatabase(Database):
    allow_import=True
    def __init__(self,directory,guestbook_url,token,backup_dir=None):
        super().__init__(directory,backup_dir);self.guestbook=internal_target(guestbook_url);self.token=token
    def verify_pin(self,event,pin):
        conn=http.client.HTTPConnection(*self.guestbook,timeout=5)
        try:
            conn.request('POST','/api/admin/verify-pin',body=json.dumps({'event':event,'pin':pin}),headers={'Authorization':'Bearer '+self.token,'X-Temu-Album':'1','Content-Type':'application/json'})
            r=conn.getresponse();return r.status==200 and json.loads(r.read(4096)).get('valid') is True
        except (OSError,ValueError,http.client.HTTPException):return False
        finally:conn.close()

def make_album_handler(database,token,proxy_key):
    album=Album(database)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass
        def safe_host(self):return hmac.compare_digest(self.headers.get('X-Temu-Album-Proxy',''),proxy_key)
        def authorized(self):return self.safe_host() and hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token)
        def reply(self,status,payload,cookie=None):
            data=encode(payload).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            if cookie:self.send_header('Set-Cookie',cookie)
            self.end_headers()
            if self.command!='HEAD':self.wfile.write(data)
        def dispatch(self):
            if urlsplit(self.path).path=='/health' and self.command in ('GET','HEAD'):return self.reply(200,{'ok':True,'service':'album'})
            if not album.handle(self):self.reply(404,{'error':'Tidak ditemukan.'})
        do_GET=do_HEAD=do_POST=do_PUT=do_DELETE=dispatch
    return Handler

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=4180);parser.add_argument('--data-dir',default='album-data');parser.add_argument('--backup-dir');args=parser.parse_args()
    token=os.environ.get('TEMU_SERVER_TOKEN','');proxy=os.environ.get('TEMU_ALBUM_PROXY_KEY','')
    if min(len(token),len(proxy))<32:raise SystemExit('Isi TEMU_SERVER_TOKEN dan TEMU_ALBUM_PROXY_KEY, minimal 32 karakter.')
    os.umask(0o077);db=AlbumDatabase(args.data_dir,os.environ.get('TEMU_GUESTBOOK_URL',''),token,args.backup_dir)
    server=ThreadingHTTPServer((args.host,args.port),make_album_handler(db,token,proxy));stop=threading.Event()
    def backup_loop():
        while not stop.wait(300):db.backup(force=True)
    threading.Thread(target=backup_loop,daemon=True).start();print('Album server ready',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:stop.set();db.backup(force=True);server.server_close()
if __name__=='__main__':main()
