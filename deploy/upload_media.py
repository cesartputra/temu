"""Upload the four local wedding media files to Temu's private persistent volume."""
import argparse, getpass, json, sys, urllib.error, urllib.request
from pathlib import Path
from urllib.parse import urlsplit

parser=argparse.ArgumentParser()
parser.add_argument('origin',help='Origin HTTPS layanan, mis. https://temu.helipod.app')
parser.add_argument('media_dir',type=Path,help='Folder private-media pada komputer lokal')
args=parser.parse_args()
origin=args.origin.rstrip('/')
parsed=urlsplit(origin)
if parsed.scheme!='https' or not parsed.hostname or parsed.path or parsed.query or parsed.fragment:
    parser.error('Gunakan origin HTTPS tanpa path, mis. https://temu.helipod.app')
token=getpass.getpass('Kunci pengelola server: ')
if len(token)<32:parser.error('Kunci pengelola tidak valid.')
for name in ('portrait-1.jpg','portrait-2.jpg','portrait-3.jpg','film.mp4'):
    path=args.media_dir/name
    if not path.is_file():parser.error(f'Berkas tidak ada: {path}')
    data=path.read_bytes()
    req=urllib.request.Request(origin+'/api/admin/media/'+name,data=data,headers={'Authorization':'Bearer '+token,'X-Temu-Media':'1','Content-Type':'application/octet-stream'},method='PUT')
    try:
        with urllib.request.urlopen(req,timeout=90) as response:
            result=json.load(response)
            print(f"{result['name']}: {result['bytes']} byte tersimpan")
    except urllib.error.HTTPError as error:
        try:message=json.load(error).get('error','Unggahan gagal.')
        except Exception:message='Unggahan gagal.'
        sys.exit(f'{name}: HTTP {error.code} — {message}')
