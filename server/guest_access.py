"""Private invitations: hashed links + separate access code, expiring revocable sessions."""
import hashlib,hmac,json,re,secrets,time
from http.cookies import SimpleCookie

class Denied(Exception): pass

def digest(value):return hashlib.sha256(value.encode()).hexdigest()
def code_hash(code,salt):return hashlib.scrypt(code.encode(),salt=bytes.fromhex(salt),n=16384,r=8,p=1).hex()

class GuestAccess:
 def __init__(self,database):
  self.db=database
  with database.connect() as c:c.executescript('''
   CREATE TABLE IF NOT EXISTS invitation_access(link_hash TEXT PRIMARY KEY,event TEXT NOT NULL,guest TEXT NOT NULL,code_hash TEXT NOT NULL,salt TEXT NOT NULL,guest_code TEXT NOT NULL,phone TEXT NOT NULL,expires REAL NOT NULL,created REAL NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,blocked_until REAL NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS idx_invitation_guest ON invitation_access(event,guest);
   CREATE TABLE IF NOT EXISTS invitation_sessions(session_hash TEXT PRIMARY KEY,link_hash TEXT NOT NULL,expires REAL NOT NULL);
   CREATE TABLE IF NOT EXISTS invitation_rate(key TEXT PRIMARY KEY,attempts INTEGER NOT NULL,reset REAL NOT NULL);
  ''')
 def current(self,c,event,guest):
  r=c.execute('SELECT state FROM events WHERE id=?',(event,)).fetchone()
  if not r:raise Denied('Undangan tidak tersedia.')
  state=json.loads(r[0]);g=next((g for g in state['guests'] if g['id']==guest and g['active']),None)
  if not g:raise Denied('Undangan tidak tersedia.')
  return state,g
 def issue(self,event,guest):
  link=secrets.token_urlsafe(32);code=f'{secrets.randbelow(100000000):08d}';salt=secrets.token_hex(16);hashed=code_hash(code,salt);created=time.time();expiry=created+180*86400
  with self.db.lock,self.db.connect() as c:
   state,g=self.current(c,event,guest)
   if not g.get('phone'):raise ValueError('Isi nomor WhatsApp tamu dan sinkronkan terlebih dahulu.')
   c.execute('UPDATE invitation_access SET revoked=1 WHERE event=? AND guest=?',(event,guest))
   c.execute('INSERT INTO invitation_access(link_hash,event,guest,code_hash,salt,guest_code,phone,expires,created) VALUES(?,?,?,?,?,?,?,?,?)',(digest(link),event,guest,hashed,salt,g['code'],g['phone'],expiry,created))
  self.db.backup(force=True)
  return {'link':link,'code':code,'expires':expiry,'guest':g['name']}
 def preview(self,event,guest):
  stamp=time.time();link=secrets.token_urlsafe(32);session=secrets.token_urlsafe(32)
  with self.db.lock,self.db.connect() as c:
   state,g=self.current(c,event,guest)
   c.execute('INSERT INTO invitation_access(link_hash,event,guest,code_hash,salt,guest_code,phone,expires,created) VALUES(?,?,?,?,?,?,?,?,?)',(digest(link),event,guest,'','',g['code'],g.get('phone',''),stamp+600,stamp))
   c.execute('INSERT INTO invitation_sessions VALUES(?,?,?)',(digest(session),digest(link),stamp+600))
  return session
 def revoke(self,event,guest):
  with self.db.lock,self.db.connect() as c:c.execute('UPDATE invitation_access SET revoked=1 WHERE event=? AND guest=?',(event,guest))
  self.db.backup(force=True)
 def valid(self,c,row):
  if not row or row[8] or row[7]<time.time():raise Denied('Undangan tidak tersedia.')
  state,g=self.current(c,row[1],row[2])
  if g['code']!=row[5] or g.get('phone','')!=row[6]:raise Denied('Undangan tidak tersedia.')
  return state,g
 def access_row(self,c,link_hash):return c.execute('SELECT link_hash,event,guest,code_hash,salt,guest_code,phone,expires,revoked,failures,blocked_until FROM invitation_access WHERE link_hash=?',(link_hash,)).fetchone()
 def unlock(self,link,code,ip):
  if not isinstance(link,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',link) or not isinstance(code,str) or not re.fullmatch(r'[0-9]{8}',code):raise Denied('Tautan atau kode tidak valid.')
  stamp=time.time();failure=False;session=None
  with self.db.lock,self.db.connect() as c:
   key=digest(ip);rate=c.execute('SELECT attempts,reset FROM invitation_rate WHERE key=?',(key,)).fetchone()
   if rate and rate[1]>stamp and rate[0]>=30:raise Denied('Terlalu banyak percobaan. Coba lagi dalam 15 menit.')
   attempts=rate[0]+1 if rate and rate[1]>stamp else 1;reset=rate[1] if rate and rate[1]>stamp else stamp+900
   c.execute('INSERT OR REPLACE INTO invitation_rate VALUES(?,?,?)',(key,attempts,reset));c.execute('DELETE FROM invitation_rate WHERE reset<?',(stamp,));c.execute('DELETE FROM invitation_sessions WHERE expires<?',(stamp,))
   row=self.access_row(c,digest(link))
   try:self.valid(c,row)
   except Denied:row=None
   if not row or row[10]>stamp:failure=True
   elif not hmac.compare_digest(code_hash(code,row[4]),row[3]):
    failed=row[9]+1 if row[10]==0 else 1
    c.execute('UPDATE invitation_access SET failures=?,blocked_until=? WHERE link_hash=?',(failed,stamp+900 if failed>=5 else 0,row[0]));failure=True
   else:
    session=secrets.token_urlsafe(32);expiry=min(stamp+24*3600,row[7]);c.execute('UPDATE invitation_access SET failures=0,blocked_until=0 WHERE link_hash=?',(row[0],));c.execute('INSERT INTO invitation_sessions VALUES(?,?,?)',(digest(session),row[0],expiry))
  if failure:raise Denied('Tautan atau kode tidak valid, kedaluwarsa, atau akses sementara dibatasi.')
  return session
 def session(self,cookie):
  try:jar=SimpleCookie();jar.load(cookie);secret=jar['temu_guest'].value
  except Exception:raise Denied('Masukkan kode akses untuk membuka undangan.')
  with self.db.connect() as c:
   r=c.execute('SELECT link_hash FROM invitation_sessions WHERE session_hash=? AND expires>?',(digest(secret),time.time())).fetchone()
   if not r:raise Denied('Sesi berakhir. Buka kembali tautan undangan Anda.')
   state,g=self.valid(c,self.access_row(c,r[0]))
  event=state['event'];details=event.get('wedding',{})
  return {'event':{'id':event['id'],'name':event['name'],'date':event['date'],'wedding':details},'guest':{'name':g['name'],'quota':g['quota'],'code':g['code']}}
 def logout(self,cookie):
  try:jar=SimpleCookie();jar.load(cookie);secret=jar['temu_guest'].value
  except Exception:return
  with self.db.connect() as c:c.execute('DELETE FROM invitation_sessions WHERE session_hash=?',(digest(secret),))
