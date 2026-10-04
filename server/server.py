"""Temu local / self-hosted sync server. Python 3.10+, standard library only."""
import argparse, base64, copy, hashlib, hmac, json, os, re, secrets, sqlite3, tempfile, threading, time
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit, parse_qs, urlencode
from http.cookies import SimpleCookie
import sys
sys.path.insert(0,str(Path(__file__).resolve().parent))
from guest_access import GuestAccess, Denied

ROOT = Path(__file__).resolve().parents[1]
MAX_BODY = 20 * 1024 * 1024

def now(): return datetime.now(timezone.utc).isoformat()
def encode(x): return json.dumps(x, ensure_ascii=False, separators=(',', ':'))
def validate(s):
    if not isinstance(s,dict) or s.get('version') != 1: raise ValueError('Format data tidak sesuai.')
    e=s.get('event',{})
    for k in ('id','name','date'):
        if not isinstance(e.get(k),str) or len(e[k])>200: raise ValueError('Acara tidak valid.')
    if 'invitationText' in e and (not isinstance(e['invitationText'],str) or len(e['invitationText'])>2000):raise ValueError('Teks undangan tidak valid.')
    if 'wedding' in e:
        if not isinstance(e['wedding'],dict):raise ValueError('Detail pernikahan tidak valid.')
        for key,value in e['wedding'].items():
            if key not in ('firstName','secondName','ceremonyTime','receptionTime','venue','address','mapsURL','publicOrigin','giftBank','giftAccount','giftName') or not isinstance(value,str) or len(value)>500:raise ValueError('Detail pernikahan tidak valid.')
        for key in ('mapsURL','publicOrigin'):
            value=e['wedding'].get(key,'')
            if value and (urlsplit(value).scheme!='https' or not urlsplit(value).netloc or urlsplit(value).username):raise ValueError('Tautan harus HTTPS.')
    if not e['id'] or not isinstance(s.get('guests'),list) or len(s['guests'])>20000 or not isinstance(s.get('logs'),list): raise ValueError('Data tidak valid.')
    if type(s.get('guestEpoch',0)) is not int or s.get('guestEpoch',0)<0:raise ValueError('Versi daftar tamu tidak valid.')
    if s.get('pin') is not None and (not isinstance(s['pin'],str) or len(s['pin'])>128): raise ValueError('PIN tidak valid.')
    ids=set();codes=set()
    for g in s['guests']:
        for k in ('id','code','name','group'):
            if not isinstance(g.get(k),str) or len(g[k])>500: raise ValueError('Tamu tidak valid.')
        if not g['id'] or not g['code'] or not g['name'].strip() or type(g.get('active')) is not bool: raise ValueError('Tamu tidak valid.')
        if type(g.get('quota')) is not int or not 1<=g['quota']<=1000 or type(g.get('arrived')) is not int or not 0<=g['arrived']<=g['quota']: raise ValueError('Kuota tidak valid.')
        if g['id'] in ids or g['code'] in codes: raise ValueError('Kode / ID tamu duplikat.')
        if 'vip' in g and g['vip'] not in ('y','n'):raise ValueError('Pilihan VIP harus y atau n.')
        if 'akad' in g and g['akad'] not in ('y','n'):raise ValueError('Pilihan akad harus y atau n.')
        if 'phone' in g and (not isinstance(g['phone'],str) or (g['phone'] and not re.fullmatch(r'[1-9]\d{7,14}',g['phone']))):raise ValueError('Nomor WhatsApp tidak valid.')
        if 'deleted' in g and (type(g['deleted']) is not bool or (g['deleted'] and (g['active'] or g['name']!='Tamu dihapus' or g.get('phone') or g['group']))):raise ValueError('Tamu yang dihapus tidak valid.')
        ids.add(g['id']);codes.add(g['code'])
    logids=set()
    for l in s['logs']:
        if not isinstance(l,dict) or not isinstance(l.get('id'),str) or l['id'] in logids or l.get('guest') not in ids or type(l.get('count')) is not int or not isinstance(l.get('at'),str): raise ValueError('Riwayat tidak valid.')
        datetime.fromisoformat(l['at'].replace('Z','+00:00'));logids.add(l['id'])
    return s

def apply(state,op,event):
    if not isinstance(op,dict) or not isinstance(op.get('id'),str) or not 1<=len(op['id'])<=100 or op.get('event')!=event: raise ValueError('Operasi tidak valid.')
    if op.get('kind')=='bootstrap':
        if state is not None: raise ValueError('Acara sudah ada. Pilih salinan server atau tinjau cadangan lokal.')
        result=validate(copy.deepcopy(op.get('state')))
        if result['event']['id']!=event: raise ValueError('Acara tidak cocok.')
        return result
    if op.get('kind')!='change' or state is None: raise ValueError('Acara belum tersedia di server.')
    if op.get('guestEpoch',0)!=state.get('guestEpoch',0):raise ValueError('Daftar tamu telah dibersihkan di perangkat lain. Muat ulang data sebelum mengubahnya.')
    result=copy.deepcopy(state)
    meta=op.get('meta')
    if meta:
        if {'event':state['event'],'pin':state['pin']}!=meta.get('before'): raise ValueError('Pengaturan berubah di perangkat lain.')
        result.update(meta['after'])
    changes=op.get('changes');logs=op.get('logs')
    if not isinstance(changes,list) or not isinstance(logs,list): raise ValueError('Perubahan tidak valid.')
    for c in changes:
        current=next((g for g in result['guests'] if g['id']==c.get('id')),None)
        if current!=c.get('before'): raise ValueError('Undangan berubah di perangkat lain; periksa kedatangan sebelum mengulang.')
        result['guests']=[g for g in result['guests'] if g['id']!=c['id']]
        if c.get('after') is not None:
            if c['after'].get('id')!=c['id']: raise ValueError('ID tamu berubah.')
            result['guests'].append(c['after'])
    result['logs'].extend(logs)
    if result['event']['id']!=event: raise ValueError('ID acara tidak boleh berubah.')
    return validate(result)

class ClosingConnection(sqlite3.Connection):
    def __exit__(self,*args):
        try:return super().__exit__(*args)
        finally:self.close()

class Database:
    def __init__(self,directory,backup_dir=None):
        self.directory=Path(directory);self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.directory/'temu.sqlite3';self.backup_dir=Path(backup_dir) if backup_dir else self.directory/'backups'
        self.backup_dir.mkdir(parents=True,exist_ok=True,mode=0o700);self.lock=threading.RLock();self.last_backup=0;self.backup_error=None
        with self.connect() as c:
            c.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,state TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,updated TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS operations(event TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(event,id));
            CREATE TABLE IF NOT EXISTS deleted_events(id TEXT PRIMARY KEY,deleted TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS app_secrets(name TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS rsvps(event TEXT NOT NULL,guest TEXT NOT NULL,status TEXT NOT NULL,count INTEGER NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(event,guest));
            CREATE TABLE IF NOT EXISTS invitation_devices(event TEXT NOT NULL,guest TEXT NOT NULL,device_hash TEXT NOT NULL,PRIMARY KEY(event,guest));
            CREATE TABLE IF NOT EXISTS invitation_link_versions(event TEXT NOT NULL,guest TEXT NOT NULL,nonce TEXT NOT NULL,PRIMARY KEY(event,guest));
            CREATE TABLE IF NOT EXISTS wishes(event TEXT NOT NULL,guest TEXT NOT NULL,message TEXT NOT NULL,updated TEXT NOT NULL,PRIMARY KEY(event,guest));
            ''')
            c.execute('INSERT OR IGNORE INTO app_secrets(name,value) VALUES(?,?)',('invite-signing',secrets.token_urlsafe(48)))
        os.chmod(self.path,0o600)
    def connect(self):
        c=sqlite3.connect(self.path,timeout=20,factory=ClosingConnection);c.execute('PRAGMA synchronous=FULL');return c
    def backup(self,force=False):
        with self.lock:
            if not force and time.time()-self.last_backup<60:return
            target=self.backup_dir/('temu-'+str(time.time_ns())+'.sqlite3');temp=target.with_suffix('.tmp')
            try:
                with self.connect() as source,sqlite3.connect(temp,factory=ClosingConnection) as destination:source.backup(destination)
                os.chmod(temp,0o600);os.replace(temp,target)
                for old in sorted(self.backup_dir.glob('temu-*.sqlite3'))[:-48]:old.unlink()
                self.last_backup=time.time();self.backup_error=None
            except Exception as e:
                self.backup_error='Cadangan server gagal: '+type(e).__name__
                if temp.exists():temp.unlink()
    def clear_guests(self,event,expected_revision,pin):
        if type(expected_revision) is not int or expected_revision<0 or not isinstance(pin,str) or not re.fullmatch(r'\d{4,12}',pin):raise ValueError('PIN atau versi data tidak valid.')
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute('SELECT state,revision FROM events WHERE id=?',(event,)).fetchone()
            if not row:raise ValueError('Acara tidak ditemukan.')
            state=validate(json.loads(row[0]));revision=row[1]
            if not state.get('pin'):raise ValueError('Atur PIN pengelola sebelum menghapus seluruh tamu.')
            digest=hashlib.sha256((event+':'+pin).encode()).hexdigest()
            if not hmac.compare_digest(digest,state['pin']):raise ValueError('PIN tidak sesuai.')
            if revision!=expected_revision:raise ValueError('Daftar berubah. Sinkronkan lalu ulangi penghapusan.')
            state['guests']=[];state['logs']=[];state['guestEpoch']=state.get('guestEpoch',0)+1
            validate(state);revision+=1
            c.execute('UPDATE events SET state=?,revision=?,updated=? WHERE id=?',(encode(state),revision,now(),event))
            c.execute('DELETE FROM operations WHERE event=?',(event,))
            c.execute('DELETE FROM rsvps WHERE event=?',(event,))
            c.execute('DELETE FROM wishes WHERE event=?',(event,))
            c.execute('DELETE FROM invitation_devices WHERE event=?',(event,))
            c.execute('DELETE FROM invitation_link_versions WHERE event=?',(event,))
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invitation_access'").fetchone():
                links=[row[0] for row in c.execute('SELECT link_hash FROM invitation_access WHERE event=?',(event,))]
                for link in links:c.execute('DELETE FROM invitation_sessions WHERE link_hash=?',(link,))
                c.execute('DELETE FROM invitation_access WHERE event=?',(event,))
            c.commit()
            cleanup_error=None
            try:
                for old in self.backup_dir.glob('temu-*.sqlite3'):old.unlink()
            except OSError:cleanup_error='Cadangan lama belum seluruhnya terhapus; periksa folder cadangan server.'
            self.backup(force=True)
            return {'ok':True,'state':state,'revision':revision,'backupAt':datetime.fromtimestamp(self.last_backup,timezone.utc).isoformat() if self.last_backup else None,'backupError':cleanup_error or self.backup_error}
    def reset_attendance(self,event,expected_revision,pin):
        if type(expected_revision) is not int or expected_revision<0 or not isinstance(pin,str) or not re.fullmatch(r'\d{4,12}',pin):raise ValueError('PIN atau versi data tidak valid.')
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            row=c.execute('SELECT state,revision FROM events WHERE id=?',(event,)).fetchone()
            if not row:raise ValueError('Acara tidak ditemukan.')
            state=validate(json.loads(row[0]));revision=row[1]
            if not state.get('pin'):raise ValueError('Atur PIN pengelola sebelum mereset kehadiran.')
            digest=hashlib.sha256((event+':'+pin).encode()).hexdigest()
            if not hmac.compare_digest(digest,state['pin']):raise ValueError('PIN tidak sesuai.')
            if revision!=expected_revision:raise ValueError('Data berubah. Sinkronkan lalu ulangi reset.')
            for guest in state['guests']:guest['arrived']=0
            state['logs']=[];state['guestEpoch']=state.get('guestEpoch',0)+1
            validate(state);revision+=1
            c.execute('UPDATE events SET state=?,revision=?,updated=? WHERE id=?',(encode(state),revision,now(),event))
            c.execute('DELETE FROM operations WHERE event=?',(event,))
            c.commit()
            self.backup(force=True)
            return {'ok':True,'state':state,'revision':revision,'backupAt':datetime.fromtimestamp(self.last_backup,timezone.utc).isoformat() if self.last_backup else None,'backupError':self.backup_error}
    def sync(self,body):
        event=body.get('event');ops=body.get('operations',[])
        if not isinstance(event,str) or not 1<=len(event)<=200 or not isinstance(ops,list) or len(ops)>100:raise ValueError('Permintaan tidak valid.')
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE');row=c.execute('SELECT state,revision FROM events WHERE id=?',(event,)).fetchone()
            state=json.loads(row[0]) if row else None;revision=row[1] if row else 0;results=[];changed=False
            for op in ops:
                if not isinstance(op,dict) or not isinstance(op.get('id'),str):raise ValueError('ID operasi tidak valid.')
                fingerprint=hashlib.sha256(encode(op).encode()).hexdigest()
                previous=c.execute('SELECT fingerprint,result FROM operations WHERE event=? AND id=?',(event,op['id'])).fetchone()
                if previous:
                    if previous[0]!=fingerprint:raise ValueError('ID operasi sudah dipakai dengan isi berbeda.')
                    results.append(json.loads(previous[1]));continue
                try:
                    if op.get('kind')=='bootstrap' and state is None:
                        if c.execute('SELECT 1 FROM deleted_events WHERE id=?',(event,)).fetchone():raise ValueError('Acara sudah dihapus dan tidak dapat dibuat ulang.')
                        if c.execute('SELECT 1 FROM events WHERE id<>? LIMIT 1',(event,)).fetchone():raise ValueError('Server ini hanya untuk satu acara.')
                    state=apply(state,op,event);revision+=1;changed=True;result={'id':op['id'],'ok':True}
                    if op.get('kind')=='change' and c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invitation_access'").fetchone():
                        for change in op.get('changes',[]):
                            if change.get('after') is None or change['after'].get('deleted'):
                                links=[row[0] for row in c.execute('SELECT link_hash FROM invitation_access WHERE event=? AND guest=?',(event,change['id']))]
                                for link in links:c.execute('DELETE FROM invitation_sessions WHERE link_hash=?',(link,))
                                c.execute('DELETE FROM invitation_access WHERE event=? AND guest=?',(event,change['id']))
                    if op.get('kind')=='change':
                        for change in op.get('changes',[]):
                            if change.get('after') is None or change['after'].get('deleted'):
                                c.execute('DELETE FROM rsvps WHERE event=? AND guest=?',(event,change['id']))
                                c.execute('DELETE FROM wishes WHERE event=? AND guest=?',(event,change['id']))
                                c.execute('DELETE FROM invitation_devices WHERE event=? AND guest=?',(event,change['id']))
                                c.execute('DELETE FROM invitation_link_versions WHERE event=? AND guest=?',(event,change['id']))
                            elif change['after']['active']:
                                c.execute("UPDATE rsvps SET count=MIN(count,?),updated=? WHERE event=? AND guest=? AND status='attending' AND count>?",(change['after']['quota'],now(),event,change['id'],change['after']['quota']))
                except (ValueError,KeyError,TypeError,AttributeError) as e:result={'id':op['id'],'ok':False,'reason':str(e)}
                c.execute('INSERT INTO operations VALUES(?,?,?,?)',(event,op['id'],fingerprint,encode(result)));results.append(result)
            if state is not None:
                c.execute('INSERT INTO events VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated=excluded.updated',(event,encode(state),revision,now()))
            c.commit()
            if changed:self.backup()
            return {'state':state,'revision':revision,'results':results,'backupAt':datetime.fromtimestamp(self.last_backup,timezone.utc).isoformat() if self.last_backup else None,'backupError':self.backup_error}
    def events(self):
        with self.connect() as c:return [{'id':r[0],'name':json.loads(r[1])['event']['name'],'updated':r[2]} for r in c.execute('SELECT id,state,updated FROM events ORDER BY updated DESC')]
    def public_event(self,device=None,guest=None):
        with self.connect() as c:rows=c.execute('SELECT state FROM events LIMIT 2').fetchall()
        if len(rows)!=1:return None
        state=json.loads(rows[0][0]);event=copy.deepcopy(state['event'])
        hashed=hashlib.sha256((device or '').encode()).hexdigest()
        with self.connect() as c:bound=[row[0] for row in c.execute('SELECT guest FROM invitation_devices WHERE device_hash=?',(hashed,))]
        allowed=any(g['id'] in bound and (guest is None or g['id']==guest) and g.get('akad')=='y' and g['active'] and not g.get('deleted') for g in state['guests'])
        if not allowed:event.setdefault('wedding',{})['ceremonyTime']='Family Only'
        return {key:event.get(key,{} if key=='wedding' else '') for key in ('name','date','wedding')}
    def invite_signature(self,c,event,guest):
        secret=c.execute('SELECT value FROM app_secrets WHERE name=?',('invite-signing',)).fetchone()[0]
        version=c.execute('SELECT nonce FROM invitation_link_versions WHERE event=? AND guest=?',(event,guest)).fetchone()
        suffix=':'+version[0] if version else ''
        digest=hmac.new(secret.encode(),('temu-invite-v1:'+event+':'+guest+suffix).encode(),hashlib.sha256).digest()
        return base64.urlsafe_b64encode(digest).decode().rstrip('=')
    def calendar_signature(self,c,event,guest):
        secret=c.execute('SELECT value FROM app_secrets WHERE name=?',('invite-signing',)).fetchone()[0]
        value=hmac.new(secret.encode(),('calendar-v1:'+event+':'+guest['id']+':'+guest['code']).encode(),hashlib.sha256).digest()
        return base64.urlsafe_b64encode(value).decode().rstrip('=')
    def guest_calendar(self,guest,signature):
        from calendar_feed import calendar_feed
        with self.connect() as c:
            for event,raw in c.execute('SELECT id,state FROM events LIMIT 2'):
                state=json.loads(raw);g=next((g for g in state['guests'] if g['id']==guest and g['active'] and not g.get('deleted')),None)
                if g and hmac.compare_digest(self.calendar_signature(c,event,g),signature):return calendar_feed(state['event'],g.get('akad')=='y')
        raise Denied('Kalender tidak tersedia.')
    def invite_guest(self,guest,key):
        if not isinstance(guest,str) or not 1<=len(guest)<=200 or not isinstance(key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',key):raise ValueError('Tautan tamu tidak valid.')
        with self.connect() as c:
            rows=c.execute('SELECT id,state FROM events LIMIT 2').fetchall()
            if len(rows)!=1:raise ValueError('Acara tidak tersedia.')
            event,state=rows[0][0],json.loads(rows[0][1])
            if not hmac.compare_digest(key,self.invite_signature(c,event,guest)):raise ValueError('Tautan tamu tidak valid.')
            found=next((g for g in state['guests'] if g['id']==guest and g['active'] and not g.get('deleted')),None)
            if not found:raise ValueError('Undangan tamu tidak aktif.')
            rsvp=c.execute('SELECT status,count,updated FROM rsvps WHERE event=? AND guest=?',(event,guest)).fetchone()
            wish=c.execute('SELECT message,updated FROM wishes WHERE event=? AND guest=?',(event,guest)).fetchone()
            return {'event':event,'guest':{'name':found['name'],'quota':found['quota'],'akad':found.get('akad','n'),'qr':encode({'v':1,'event':event,'code':found['code']}),'calendarPath':'/api/invite/calendar.ics?'+urlencode({'g':guest,'c':self.calendar_signature(c,event,found)})},'rsvp':{'status':rsvp[0],'count':rsvp[1],'updated':rsvp[2]} if rsvp else None,'wish':{'message':wish[0],'updated':wish[1]} if wish else None}
    def bind_invitation_device(self,guest,key,device):
        # Validate before claiming; serialize first-open races across processes too.
        with self.lock:
            info=self.invite_guest(guest,key)
            device=device or secrets.token_urlsafe(32)
            hashed=hashlib.sha256(device.encode()).hexdigest()
            with self.connect() as c:
                c.execute('BEGIN IMMEDIATE')
                if not hmac.compare_digest(key,self.invite_signature(c,info['event'],guest)):raise Denied('Tautan undangan sudah diganti. Gunakan tautan terbaru dari pengelola.')
                row=c.execute('SELECT device_hash FROM invitation_devices WHERE event=? AND guest=?',(info['event'],guest)).fetchone()
                if row and not hmac.compare_digest(row[0],hashed):raise Denied('Undangan ini sudah dibuka di perangkat lain. Hubungi pengelola jika Anda berganti perangkat.')
                c.execute('INSERT OR IGNORE INTO invitation_devices VALUES(?,?,?)',(info['event'],guest,hashed))
            if not row:self.backup(force=True)
            return info,device
    def require_invitation_device(self,device,guest=None,key=None):
        if not device:raise Denied('Buka undangan melalui tautan unik yang dikirimkan kepada Anda.')
        hashed=hashlib.sha256(device.encode()).hexdigest()
        with self.connect() as c:
            rows=c.execute('SELECT event,guest FROM invitation_devices WHERE device_hash=?',(hashed,)).fetchall()
            for event,bound_guest in rows:
                if guest is not None and guest!=bound_guest:continue
                row=c.execute('SELECT state FROM events WHERE id=?',(event,)).fetchone()
                if not row:continue
                if not any(g['id']==bound_guest and g['active'] and not g.get('deleted') for g in json.loads(row[0])['guests']):continue
                if key is not None and (not isinstance(key,str) or not hmac.compare_digest(key,self.invite_signature(c,event,bound_guest))):continue
                return
        raise Denied('Undangan ini sudah dibuka di perangkat lain atau aksesnya tidak lagi aktif.')
    def reset_invitation_device(self,event,guest,pin):
        with self.lock,self.connect() as c:
            row=c.execute('SELECT state FROM events WHERE id=?',(event,)).fetchone()
            if not row:raise ValueError('Acara tidak ditemukan.')
            state=json.loads(row[0])
            if not isinstance(pin,str) or not re.fullmatch(r'\d{4,12}',pin) or not state.get('pin') or not hmac.compare_digest(hashlib.sha256((event+':'+pin).encode()).hexdigest(),state['pin']):raise Denied('PIN tidak sesuai. Atur PIN pengelola sebelum memulihkan akses.')
            if not any(g['id']==guest and g['active'] and not g.get('deleted') for g in state['guests']):raise ValueError('Tamu tidak aktif.')
            c.execute('INSERT OR REPLACE INTO invitation_link_versions VALUES(?,?,?)',(event,guest,secrets.token_urlsafe(32)))
            c.execute('DELETE FROM invitation_devices WHERE event=? AND guest=?',(event,guest))
        self.backup(force=True)
        return self.guest_link(event,guest)
    def guest_link(self,event,guest):
        with self.connect() as c:
            row=c.execute('SELECT state FROM events WHERE id=?',(event,)).fetchone()
            if not row:raise ValueError('Acara tidak ditemukan.')
            found=next((g for g in json.loads(row[0])['guests'] if g['id']==guest and g['active'] and not g.get('deleted')),None)
            if not found:raise ValueError('Tamu tidak aktif atau tidak ditemukan.')
            return {'guest':guest,'key':self.invite_signature(c,event,guest)}
    def save_rsvp(self,guest,key,status,count):
        with self.lock:
            info=self.invite_guest(guest,key)
            if status not in ('attending','declined') or type(count) is not int or (status=='attending' and not 1<=count<=info['guest']['quota']) or (status=='declined' and count!=0):raise ValueError('Konfirmasi kehadiran tidak valid.')
            with self.connect() as c:c.execute('INSERT INTO rsvps VALUES(?,?,?,?,?) ON CONFLICT(event,guest) DO UPDATE SET status=excluded.status,count=excluded.count,updated=excluded.updated',(info['event'],guest,status,count,now()))
            self.backup()
            return self.invite_guest(guest,key)
    def save_wish(self,guest,key,message):
        with self.lock:
            info=self.invite_guest(guest,key)
            if not isinstance(message,str) or not 1<=len(message.strip())<=500:raise ValueError('Doa harus berisi 1–500 karakter.')
            clean=message.strip()
            with self.connect() as c:c.execute('INSERT INTO wishes VALUES(?,?,?,?) ON CONFLICT(event,guest) DO UPDATE SET message=excluded.message,updated=excluded.updated',(info['event'],guest,clean,now()))
            self.backup()
            return self.invite_guest(guest,key)
    def public_wishes(self):
        with self.connect() as c:
            rows=c.execute('SELECT id,state FROM events LIMIT 2').fetchall()
            if len(rows)!=1:return []
            event,state=rows[0][0],json.loads(rows[0][1]);guests={g['id']:g for g in state['guests'] if g['active'] and not g.get('deleted')}
            statuses={g:status for g,status in c.execute('SELECT guest,status FROM rsvps WHERE event=?',(event,))}
            return [{'name':guests[g]['name']+(' & Pasangan' if guests[g]['quota']==2 else ' & Keluarga' if guests[g]['quota']>2 else ''),'status':statuses.get(g,'pending'),'message':message,'updated':updated} for g,message,updated in c.execute('SELECT guest,message,updated FROM wishes WHERE event=? ORDER BY updated DESC',(event,)) if g in guests]
    def rsvp_overview(self,event):
        with self.connect() as c:
            row=c.execute('SELECT state FROM events WHERE id=?',(event,)).fetchone()
            if not row:raise ValueError('Acara tidak ditemukan.')
            records={g:(status,count,updated) for g,status,count,updated in c.execute('SELECT guest,status,count,updated FROM rsvps WHERE event=?',(event,))}
            guests=[{'id':g['id'],'name':g['name'],'quota':g['quota'],'status':records[g['id']][0] if g['id'] in records else 'pending','count':records[g['id']][1] if g['id'] in records else 0,'updated':records[g['id']][2] if g['id'] in records else None} for g in json.loads(row[0])['guests'] if g['active'] and not g.get('deleted')]
            return {'guests':guests,'summary':{'attending':sum(g['status']=='attending' for g in guests),'declined':sum(g['status']=='declined' for g in guests),'pending':sum(g['status']=='pending' for g in guests),'persons':sum(g['count'] for g in guests)}}
    def delete_event(self,event):
        with self.lock,self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            if not c.execute('SELECT 1 FROM events WHERE id=?',(event,)).fetchone():return False
            if c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invitation_access'").fetchone():
                links=[row[0] for row in c.execute('SELECT link_hash FROM invitation_access WHERE event=?',(event,))]
                for link in links:c.execute('DELETE FROM invitation_sessions WHERE link_hash=?',(link,))
                c.execute('DELETE FROM invitation_access WHERE event=?',(event,))
            c.execute('DELETE FROM operations WHERE event=?',(event,))
            c.execute('DELETE FROM rsvps WHERE event=?',(event,))
            c.execute('DELETE FROM wishes WHERE event=?',(event,))
            c.execute('DELETE FROM invitation_devices WHERE event=?',(event,))
            c.execute('DELETE FROM invitation_link_versions WHERE event=?',(event,))
            c.execute('DELETE FROM events WHERE id=?',(event,))
            c.execute('INSERT OR REPLACE INTO deleted_events VALUES(?,?)',(event,now()))
            c.commit()
            for old in self.backup_dir.glob('temu-*.sqlite3'):old.unlink()
            self.backup(force=True)
            return True

def make_handler(database,token,allowed_hosts):
    guest_access=GuestAccess(database)
    class Handler(SimpleHTTPRequestHandler):
        def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT/'dist'),**kwargs)
        def log_message(self,fmt,*args):pass # Avoid logging credentials, QR values or guest data.
        def end_headers(self):
            if not urlsplit(self.path).path.startswith('/api/') and not any(header.lower().startswith(b'cache-control:') for header in self._headers_buffer):self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Frame-Options','DENY')
            super().end_headers()
        def safe_host(self):return self.headers.get('Host','').split(':')[0] in allowed_hosts
        def authorized(self):
            if not self.safe_host():return False
            origin=self.headers.get('Origin')
            if origin and urlsplit(origin).netloc!=self.headers.get('Host'):return False
            if self.headers.get('Sec-Fetch-Site')=='cross-site':return False
            return hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+token)
        def reply(self,status,payload,cookie=None):
            data=encode(payload).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));
            if cookie:self.send_header('Set-Cookie',cookie)
            self.end_headers()
            if self.command!='HEAD':self.wfile.write(data)
        def guest_cookie(self,value,max_age=86400):
            local=self.headers.get('Host','').split(':')[0] in ('localhost','127.0.0.1')
            return f'temu_guest={value}; Path=/api/invite; HttpOnly; SameSite=Strict; Max-Age={max_age}'+('' if local else '; Secure')
        def device_token(self):
            try:
                jar=SimpleCookie();jar.load(self.headers.get('Cookie',''));value=jar['temu_invite_device'].value
                return value if re.fullmatch(r'[A-Za-z0-9_-]{43}',value) else None
            except (KeyError,ValueError):return None
        def device_cookie(self,value):
            local=self.headers.get('Host','').split(':')[0] in ('localhost','127.0.0.1')
            return f'temu_invite_device={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'+('' if local else '; Secure')
        def invite_body(self):
            origin=self.headers.get('Origin')
            if not self.safe_host() or self.headers.get('X-Temu-Invite')!='1' or self.headers.get('Sec-Fetch-Site')=='cross-site' or (origin and urlsplit(origin).netloc!=self.headers.get('Host')):raise Denied('Permintaan tidak diizinkan.')
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=4096:raise ValueError('Permintaan tidak valid.')
            self.connection.settimeout(15);body=json.loads(self.rfile.read(size))
            if not isinstance(body,dict):raise ValueError('Permintaan tidak valid.')
            return body
        def serve_invitation_media(self,name):
            if name not in ('portrait-1.jpg','portrait-2.jpg','portrait-3.jpg','portrait-cesar.jpg','portrait-revalina.jpg','film.mp4','song.mp3'):return self.reply(404,{'error':'Media tidak ditemukan.'})
            if not database.public_event():return self.reply(404,{'error':'Undangan belum tersedia.'})
            path=Path(os.environ.get('TEMU_PRIVATE_MEDIA_DIR',str(ROOT/'private-media')))/name
            if not path.is_file():return self.reply(404,{'error':'Media belum tersedia.'})
            size=path.stat().st_size;start=0;end=size-1;status=200
            value=self.headers.get('Range')
            if value:
                m=re.fullmatch(r'bytes=(\d*)-(\d*)',value)
                if not m or not any(m.groups()):return self.reply(416,{'error':'Rentang tidak valid.'})
                if not m[1]:start=max(0,size-int(m[2]))
                else:start=int(m[1]);end=min(size-1,int(m[2])) if m[2] else size-1
                if start>end or start>=size:return self.reply(416,{'error':'Rentang tidak valid.'})
                status=206
            mime='video/mp4' if name.endswith('.mp4') else 'audio/mpeg' if name.endswith('.mp3') else 'image/jpeg'
            self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Cache-Control','no-store');self.send_header('Cross-Origin-Resource-Policy','same-origin');self.send_header('Accept-Ranges','bytes');self.send_header('Content-Length',str(end-start+1))
            if status==206:self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            self.end_headers()
            if self.command=='HEAD':return
            try:
                with path.open('rb') as f:
                    f.seek(start);remaining=end-start+1
                    while remaining:
                        chunk=f.read(min(65536,remaining))
                        if not chunk:break
                        self.wfile.write(chunk);remaining-=len(chunk)
            except (BrokenPipeError,ConnectionResetError):pass
        def do_HEAD(self):return self.do_GET()
        def do_DELETE(self):
            path=urlsplit(self.path).path
            match=re.fullmatch(r'/api/events/([A-Za-z0-9_-]{1,200})/guests',path)
            if match:
                if not self.authorized() or self.headers.get('X-Temu-Delete')!='1':return self.reply(401,{'error':'Akses pengelola diperlukan.'})
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=1024:raise ValueError('Permintaan tidak valid.')
                    body=json.loads(self.rfile.read(size))
                    result=database.clear_guests(match.group(1),body.get('revision'),body.get('pin'))
                    return self.reply(200,result)
                except (ValueError,TypeError,KeyError) as error:return self.reply(409,{'error':str(error)})
                except Exception:return self.reply(503,{'error':'Daftar tamu belum dapat dibersihkan. Coba lagi.'})
            if not path.startswith('/api/events/') or not re.fullmatch(r'[A-Za-z0-9_-]{1,200}',path[len('/api/events/'):]):return self.reply(404,{'error':'Tidak ditemukan.'})
            if not self.authorized() or self.headers.get('X-Temu-Delete')!='1':return self.reply(401,{'error':'Akses pengelola diperlukan.'})
            if not database.delete_event(path[len('/api/events/'):]):return self.reply(404,{'error':'Acara tidak ditemukan.'})
            directory=os.environ.get('TEMU_PRIVATE_MEDIA_DIR')
            if directory and not database.events():
                for name in ('portrait-1.jpg','portrait-2.jpg','portrait-3.jpg','portrait-cesar.jpg','portrait-revalina.jpg','film.mp4','song.mp3'):(Path(directory)/name).unlink(missing_ok=True)
            return self.reply(200,{'ok':True})
        def do_PUT(self):
            path=urlsplit(self.path).path
            if not path.startswith('/api/admin/media/'):return self.reply(404,{'error':'Tidak ditemukan.'})
            if not self.authorized() or self.headers.get('X-Temu-Media')!='1':return self.reply(401,{'error':'Akses pengelola diperlukan.'})
            name=path.rsplit('/',1)[-1]
            if name not in ('portrait-1.jpg','portrait-2.jpg','portrait-3.jpg','portrait-cesar.jpg','portrait-revalina.jpg','film.mp4','song.mp3'):return self.reply(404,{'error':'Media tidak ditemukan.'})
            try:size=int(self.headers.get('Content-Length','0'))
            except ValueError:return self.reply(400,{'error':'Ukuran media tidak valid.'})
            if not 12<=size<=30*1024*1024:return self.reply(413,{'error':'Media harus berukuran paling banyak 30 MB.'})
            try:
                self.connection.settimeout(60);data=self.rfile.read(size)
                if len(data)!=size:return self.reply(400,{'error':'Unggahan tidak lengkap.'})
                if name.endswith('.jpg'):valid=data.startswith(b'\xff\xd8\xff') and data.endswith(b'\xff\xd9')
                elif name.endswith('.mp3'):valid=data.startswith(b'ID3') or (data[0]==0xff and data[1]&0xe0==0xe0)
                else:valid=data[4:8]==b'ftyp'
                if not valid:return self.reply(400,{'error':'Format media tidak sesuai.'})
                directory=Path(os.environ.get('TEMU_PRIVATE_MEDIA_DIR',str(ROOT/'private-media')))
                directory.mkdir(parents=True,exist_ok=True,mode=0o700)
                with tempfile.NamedTemporaryFile(dir=directory,prefix='.upload-',delete=False) as out:
                    temp=Path(out.name);os.chmod(temp,0o600);out.write(data);out.flush();os.fsync(out.fileno())
                try:os.replace(temp,directory/name)
                finally:temp.unlink(missing_ok=True)
                return self.reply(200,{'ok':True,'name':name,'bytes':size})
            except (OSError,TimeoutError):return self.reply(503,{'error':'Media tidak dapat disimpan.'})
        def do_GET(self):
            if not self.safe_host():return self.reply(403,{'error':'Host tidak diizinkan.'})
            path=urlsplit(self.path).path
            if path=='/api/invite/calendar.ics':
                query=parse_qs(urlsplit(self.path).query)
                try:content=database.guest_calendar(query.get('g',[''])[0],query.get('c',[''])[0]).encode()
                except (Denied,ValueError):return self.reply(403,{'error':'Kalender tidak tersedia.'})
                self.send_response(200);self.send_header('Content-Type','text/calendar; charset=utf-8');self.send_header('Content-Disposition','inline');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(content)));self.end_headers();self.wfile.write(content);return
            if path in ('/api/invite/public','/api/invite/wishes') or path.startswith('/api/invite/public-media/'):
                try:database.require_invitation_device(self.device_token(),parse_qs(urlsplit(self.path).query).get('g',[None])[0])
                except Denied as error:return self.reply(403,{'error':str(error)})
            if path=='/api/invite/public':
                event=database.public_event(self.device_token(),parse_qs(urlsplit(self.path).query).get('g',[None])[0])
                return self.reply(200,{'event':event}) if event else self.reply(404,{'error':'Undangan belum tersedia.'})
            if path=='/api/invite/wishes':return self.reply(200,{'wishes':database.public_wishes()})
            if path.startswith('/api/invite/public-media/'):return self.serve_invitation_media(path.rsplit('/',1)[-1])
            if path=='/api/invite/admin/rsvp':
                if not self.authorized():return self.reply(401,{'error':'Akses pengelola diperlukan.'})
                events=database.events()
                return self.reply(200,database.rsvp_overview(events[0]['id'])) if len(events)==1 else self.reply(404,{'error':'Acara belum tersedia.'})
            if path.startswith('/api/invite/'):
                try:
                    if path=='/api/invite/view':return self.reply(200,guest_access.session(self.headers.get('Cookie','')))
                    if path.startswith('/api/invite/media/'):
                        guest_access.session(self.headers.get('Cookie',''))
                        return self.serve_invitation_media(path.rsplit('/',1)[-1])
                except Denied:return self.reply(401,{'error':'Masukkan kode akses untuk membuka undangan.'})
                return self.reply(404,{'error':'Tidak ditemukan.'})
            if path.startswith('/api/'):
                if not self.authorized():return self.reply(401,{'error':'Kunci server belum benar.'})
                if path=='/api/events':return self.reply(200,{'events':database.events()})
                return self.reply(404,{'error':'Tidak ditemukan.'})
            if path in ('/invite','/invite/','/invite.html','/invitation2','/invitation2/'):
                try:
                    database.require_invitation_device(self.device_token(),parse_qs(urlsplit(self.path).query).get('g',[None])[0])
                    opened=parse_qs(urlsplit(self.path).query).get('open')==['1']
                except Denied:opened=False
                version2=path in ('/invitation2','/invitation2/')
                page=('server/templates/invitation2.html' if opened else 'dist/invitation2-gate.html') if version2 else ('server/templates/invite.html' if opened else 'dist/invite-gate.html')
                data=(ROOT/page).read_bytes();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('X-Robots-Tag','noindex, nofollow, noarchive');self.send_header('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");self.send_header('Content-Length',str(len(data)));self.end_headers()
                if self.command!='HEAD':self.wfile.write(data)
                return
            return super().do_HEAD() if self.command=='HEAD' else super().do_GET()
        def do_POST(self):
            match=re.fullmatch(r'/api/events/([A-Za-z0-9_-]{1,200})/attendance/reset',urlsplit(self.path).path)
            if match:
                if not self.authorized() or self.headers.get('X-Temu-Reset')!='1':return self.reply(401,{'error':'Akses pengelola diperlukan.'})
                try:
                    size=int(self.headers.get('Content-Length','0'))
                    if not 0<size<=1024:raise ValueError('Permintaan tidak valid.')
                    body=json.loads(self.rfile.read(size))
                    return self.reply(200,database.reset_attendance(match.group(1),body.get('revision'),body.get('pin')))
                except (ValueError,TypeError,KeyError) as error:return self.reply(409,{'error':str(error)})
                except Exception:return self.reply(503,{'error':'Kehadiran belum dapat direset. Coba lagi.'})
            if self.path=='/api/invite/device':
                try:
                    self.invite_body()
                    return self.reply(200,{'ok':True},self.device_cookie(self.device_token() or secrets.token_urlsafe(32)))
                except (ValueError,TypeError) as error:return self.reply(400,{'error':str(error)})
                except Denied as error:return self.reply(403,{'error':str(error)})
            if self.path in ('/api/invite/guest','/api/invite/rsvp','/api/invite/wish'):
                try:
                    body=self.invite_body();guest=body.get('guest');key=body.get('key')
                    if self.path.endswith('/guest'):
                        if not self.device_token():raise Denied('Aktifkan cookie browser untuk membuka undangan pribadi Anda.')
                        info,device=database.bind_invitation_device(guest,key,self.device_token())
                        return self.reply(200,info,self.device_cookie(device))
                    database.require_invitation_device(self.device_token(),guest,key)
                    if self.path.endswith('/rsvp'):return self.reply(200,database.save_rsvp(guest,key,body.get('status'),body.get('count')))
                    return self.reply(200,database.save_wish(guest,key,body.get('message')))
                except (ValueError,TypeError) as e:return self.reply(400,{'error':str(e)})
                except Denied as e:return self.reply(403,{'error':str(e)})
            if self.path in ('/api/invite/admin/link','/api/invite/admin/reset-device'):
                if not self.authorized():return self.reply(401,{'error':'Akses pengelola diperlukan.'})
                try:
                    body=self.invite_body()
                    result=database.reset_invitation_device(body.get('event'),body.get('guest'),body.get('pin')) if self.path.endswith('/reset-device') else database.guest_link(body.get('event'),body.get('guest'))
                    return self.reply(200,result)
                except (ValueError,TypeError) as e:return self.reply(400,{'error':str(e)})
                except Denied as e:return self.reply(403,{'error':str(e)})
            if self.path in ('/api/invite/unlock','/api/invite/logout'):
                try:
                    body=self.invite_body()
                    if self.path.endswith('/unlock'):
                        session=guest_access.unlock(body.get('link'),body.get('code'),self.client_address[0]);return self.reply(200,{'ok':True},self.guest_cookie(session))
                    guest_access.logout(self.headers.get('Cookie',''));return self.reply(200,{'ok':True},self.guest_cookie('',0))
                except Denied as e:return self.reply(403,{'error':str(e)})
                except (ValueError,TypeError):return self.reply(400,{'error':'Permintaan tidak valid.'})
            if self.path in ('/api/invite/admin/issue','/api/invite/admin/revoke','/api/invite/admin/preview'):
                if not self.authorized():return self.reply(401,{'error':'Akses pengelola diperlukan.'})
                try:
                    body=self.invite_body();event=body.get('event');guest=body.get('guest')
                    if not isinstance(event,str) or not isinstance(guest,str):raise ValueError('Undangan tidak valid.')
                    if self.path.endswith('/preview'):return self.reply(200,{'ok':True},self.guest_cookie(guest_access.preview(event,guest),600))
                    if self.path.endswith('/issue'):return self.reply(200,guest_access.issue(event,guest))
                    guest_access.revoke(event,guest);return self.reply(200,{'ok':True})
                except (ValueError,Denied) as e:return self.reply(400,{'error':str(e)})
            if self.path=='/api/local-session':
                origin=self.headers.get('Origin')
                same_origin=not origin or urlsplit(origin).netloc==self.headers.get('Host')
                if allowed_hosts <= {'localhost','127.0.0.1'} and self.client_address[0]=='127.0.0.1' and self.headers.get('Host','').split(':')[0] in ('localhost','127.0.0.1') and same_origin and self.headers.get('Sec-Fetch-Site')!='cross-site' and self.headers.get('X-Temu-Local')=='1':return self.reply(200,{'token':token})
                return self.reply(403,{'error':'Hubungkan menggunakan kunci server.'})
            if not self.authorized():return self.reply(401,{'error':'Kunci server belum benar.'})
            if self.path!='/api/sync':return self.reply(404,{'error':'Tidak ditemukan.'})
            try:
                size=int(self.headers.get('Content-Length','0'))
                if not 0<size<=MAX_BODY:return self.reply(413,{'error':'Permintaan terlalu besar.'})
                self.connection.settimeout(20)
                body=json.loads(self.rfile.read(size));result=database.sync(body);self.reply(200,result)
            except (ValueError,TypeError,KeyError):self.reply(400,{'error':'Format sinkronisasi tidak valid.'})
            except Exception:self.reply(503,{'error':'Penyimpanan server belum tersedia. Perubahan lokal tetap disimpan.'})
    return Handler

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=4173);parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--data-dir',default=str(ROOT/'server-data'));parser.add_argument('--backup-dir');args=parser.parse_args()
    os.umask(0o077);database=Database(args.data_dir,args.backup_dir)
    token=os.environ.get('TEMU_SERVER_TOKEN');keypath=Path(args.data_dir)/'server-key.txt'
    if not token:
        if keypath.exists():token=keypath.read_text().strip()
        else:token=secrets.token_urlsafe(32);keypath.write_text(token);os.chmod(keypath,0o600)
    if len(token)<32:raise SystemExit('TEMU_SERVER_TOKEN minimal 32 karakter.')
    hosts={'localhost','127.0.0.1',*filter(None,os.environ.get('TEMU_ALLOWED_HOSTS','').split(','))}
    server=ThreadingHTTPServer((args.host,args.port),make_handler(database,token,hosts))
    stop=threading.Event()
    def backups():
        while not stop.wait(300):database.backup(force=True)
    database.backup(force=True);threading.Thread(target=backups,daemon=True).start()
    print(f'Temu siap di http://localhost:{args.port}. Kunci koneksi tersedia di {keypath}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:stop.set();database.backup(force=True);server.server_close()
if __name__=='__main__':main()
