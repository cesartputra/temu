"""Restore a verified snapshot to a NEW directory; never overwrite a running database."""
import argparse, os, sqlite3
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('snapshot');p.add_argument('destination');a=p.parse_args()
source=Path(a.snapshot).resolve();target=Path(a.destination).resolve()
if not source.is_file():raise SystemExit('Berkas cadangan tidak ditemukan.')
if target.exists():raise SystemExit('Gunakan direktori tujuan baru agar data lama tidak tertimpa.')
os.umask(0o077)
with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as c:
 if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise SystemExit('Cadangan gagal pemeriksaan integritas.')
 if not {'events','operations'}<=set(r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")):raise SystemExit('Ini bukan cadangan server Temu.')
 target.mkdir(parents=True,mode=0o700)
 with sqlite3.connect(target/'temu.sqlite3') as dest:
  c.backup(dest)
  tables=set(r[0] for r in dest.execute("SELECT name FROM sqlite_master WHERE type='table'"))
  if 'invitation_access' in tables:dest.execute('UPDATE invitation_access SET revoked=1')
  if 'invitation_sessions' in tables:dest.execute('DELETE FROM invitation_sessions')
print('Cadangan dipulihkan ke direktori baru. Jalankan server dengan --data-dir direktori tersebut. Data sumber tidak diubah. Akses undangan lama dicabut; buat akses baru setelah pemulihan.')
