"""Private S3 objects with bounded I/O and AWS Signature Version 4.

No credentials or signed URLs are written to logs. Upload URLs target staging
keys only; final objects are copied by the server and cannot be overwritten by
reusing a guest's upload URL.
"""
import base64, hashlib, hmac, http.client, os, re, ssl, tempfile, shutil, threading, time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree as ET

class StorageError(Exception): pass

_temporary_lock=threading.Lock()
_temporary_reserved=0

@contextmanager
def temporary_space(size):
    """Reserve space across workers, including downloads not yet on disk."""
    global _temporary_reserved
    with _temporary_lock:
        if shutil.disk_usage(tempfile.gettempdir()).free < _temporary_reserved+size+128*1024*1024:
            raise StorageError('Penyimpanan sementara sedang sibuk. Silakan coba lagi.')
        _temporary_reserved+=size
    try:yield
    finally:
        with _temporary_lock:_temporary_reserved-=size

def enabled(): return os.environ.get('TEMU_ALBUM_STORAGE','local')=='s3'
def escaped(value): return quote(str(value),safe='-_.~')
def query_string(values): return '&'.join(escaped(k)+'='+escaped(v) for k,v in sorted(values))
def signing_key(secret,date,region):
    key=('AWS4'+secret).encode()
    for value in (date,region,'s3','aws4_request'): key=hmac.new(key,value.encode(),'sha256').digest()
    return key

class S3Storage:
    copy_unavailable=False
    def __init__(self):
        self.endpoint=os.environ.get('TEMU_S3_ENDPOINT','').rstrip('/')
        p=urlsplit(self.endpoint)
        try: port=p.port
        except ValueError: raise StorageError('Konfigurasi Object Storage belum lengkap.')
        self.region=os.environ.get('TEMU_S3_REGION','')
        self.bucket=os.environ.get('TEMU_S3_BUCKET','')
        self.access=os.environ.get('TEMU_S3_ACCESS_KEY','')
        self.secret=os.environ.get('TEMU_S3_SECRET_KEY','')
        self.prefix=os.environ.get('TEMU_S3_PREFIX','temu-album/').strip('/')+'/'
        if p.scheme!='https' or p.hostname!='kencana.basic.box.cloudeka.id' or port not in (None,443) or p.path or p.username or p.password or p.query or p.fragment or not all((self.access,self.secret,self.region)) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',self.bucket) or not re.fullmatch(r'[A-Za-z0-9_/-]+/',self.prefix) or '..' in self.prefix:
            raise StorageError('Konfigurasi Object Storage belum lengkap.')
        self.host=p.netloc
    def key(self,kind,identifier,extension=''):
        if kind not in ('incoming','media','thumbnails') or not re.fullmatch(r'[a-f0-9]{32}',identifier) or not re.fullmatch(r'\.[a-z0-9]+|',extension): raise StorageError('Kunci objek tidak valid.')
        return self.prefix+kind+'/'+identifier+extension
    def uri(self,key=''): return '/'+quote(self.bucket+'/'+key,safe='/-_.~')
    def presign(self,method,key,expires=300,mime=None,size=None,download=None,now=None):
        now=now or datetime.now(timezone.utc);date=now.strftime('%Y%m%d');stamp=now.strftime('%Y%m%dT%H%M%SZ')
        scope=date+'/'+self.region+'/s3/aws4_request';headers={'host':self.host}
        if mime: headers['content-type']=mime
        if size is not None: headers['content-length']=str(size)
        signed=';'.join(sorted(headers));canonical_headers=''.join(k+':'+headers[k]+'\n' for k in sorted(headers))
        values=[('X-Amz-Algorithm','AWS4-HMAC-SHA256'),('X-Amz-Credential',self.access+'/'+scope),('X-Amz-Date',stamp),('X-Amz-Expires',str(expires)),('X-Amz-SignedHeaders',signed)]
        if download: values.append(('response-content-disposition','attachment; filename="'+download+'"'))
        values.append(('response-cache-control','private, no-store')) if method=='GET' else None
        query=query_string(values);canonical='\n'.join((method,self.uri(key),query,canonical_headers,signed,'UNSIGNED-PAYLOAD'))
        to_sign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
        signature=hmac.new(signing_key(self.secret,date,self.region),to_sign.encode(),'sha256').hexdigest()
        return self.endpoint+self.uri(key)+'?'+query+'&X-Amz-Signature='+signature
    def request(self,method,key='',body=b'',headers=None,query=(),limit=65536,output=None,expected=None):
        now=datetime.now(timezone.utc);date=now.strftime('%Y%m%d');stamp=now.strftime('%Y%m%dT%H%M%SZ');scope=date+'/'+self.region+'/s3/aws4_request'
        digest=hashlib.sha256();size=0
        if isinstance(body,Path):
            with body.open('rb') as f:
                for chunk in iter(lambda:f.read(65536),b''): digest.update(chunk);size+=len(chunk)
        else: digest.update(body);size=len(body)
        values={k.lower():str(v).strip() for k,v in (headers or {}).items()}
        values.update({'host':self.host,'x-amz-date':stamp,'x-amz-content-sha256':digest.hexdigest()})
        if method in ('PUT','POST'): values['content-length']=str(size)
        signed=';'.join(sorted(values));canonical_headers=''.join(k+':'+values[k]+'\n' for k in sorted(values));query=query_string(query)
        canonical='\n'.join((method,self.uri(key),query,canonical_headers,signed,digest.hexdigest()))
        to_sign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
        signature=hmac.new(signing_key(self.secret,date,self.region),to_sign.encode(),'sha256').hexdigest()
        values['authorization']='AWS4-HMAC-SHA256 Credential='+self.access+'/'+scope+', SignedHeaders='+signed+', Signature='+signature
        deadline=time.monotonic()+120
        connection=http.client.HTTPSConnection(self.host,timeout=20,context=ssl.create_default_context())
        def transfer_budget():
            seconds=deadline-time.monotonic()
            if seconds<=0:raise StorageError('Transfer Object Storage terlalu lama. Silakan coba lagi.')
            if connection.sock:connection.sock.settimeout(min(20,seconds))
        try:
            connection.putrequest(method,self.uri(key)+('?' + query if query else ''),skip_host=True,skip_accept_encoding=True)
            for k,v in values.items(): connection.putheader(k,v)
            connection.endheaders()
            if isinstance(body,Path):
                with body.open('rb') as f:
                    for chunk in iter(lambda:f.read(65536),b''):transfer_budget();connection.send(chunk)
            elif body: connection.send(body)
            response=connection.getresponse();result={k.lower():v for k,v in response.getheaders()}
            data=response.read(limit) if output is None or not 200<=response.status<300 else b''
            if not 200<=response.status<300:
                code='Unavailable'
                try: code=ET.fromstring(data).findtext('Code') or code
                except ET.ParseError: pass
                if not re.fullmatch(r'[A-Za-z0-9]{1,64}',code): code='Unavailable'
                raise StorageError('Object Storage belum dapat diakses ('+code+').')
            if output is not None:
                length=result.get('content-length')
                if not isinstance(expected,int) or not 12<=expected<=100*1024*1024 or (length is not None and length!=str(expected)):raise StorageError('Ukuran salinan Object Storage tidak sesuai.')
                with Path(output).open('wb') as f:
                    remaining=expected
                    while remaining:
                        remaining_time=deadline-time.monotonic()
                        if remaining_time<=0:raise StorageError('Transfer Object Storage terlalu lama. Silakan coba lagi.')
                        if connection.sock:connection.sock.settimeout(min(20,remaining_time))
                        chunk=response.read(min(65536,remaining))
                        if not chunk:raise StorageError('Salinan Object Storage belum lengkap.')
                        f.write(chunk);remaining-=len(chunk)
                    if response.read(1):raise StorageError('Ukuran salinan Object Storage tidak sesuai.')
            return result,data
        except (OSError,http.client.HTTPException) as error: raise StorageError('Koneksi Object Storage belum berhasil. Silakan coba lagi.') from error
        finally: connection.close()
    def inspect(self,key):
        headers,_=self.request('HEAD',key)
        _,head=self.request('GET',key,headers={'Range':'bytes=0-31'},limit=32)
        return int(headers.get('content-length','0')),headers.get('content-type','').split(';')[0],headers.get('etag',''),head
    def copy(self,source,target,etag,size,mime):
        if not self.copy_unavailable:
            try:
                _,data=self.request('PUT',target,headers={'x-amz-copy-source':self.uri(source),'x-amz-copy-source-if-match':etag})
                if ET.fromstring(data).tag.rsplit('}',1)[-1]!='CopyObjectResult':raise StorageError('Salinan Object Storage belum berhasil.')
                return
            except ET.ParseError:raise StorageError('Salinan Object Storage belum berhasil.')
            except StorageError as error:
                if '(RegionNotAvailable)' not in str(error):raise
                type(self).copy_unavailable=True
        # Each worker streams one file; shared reservations protect disk space.
        with temporary_space(size),tempfile.TemporaryDirectory(prefix='temu-s3-copy-') as directory:
            path=Path(directory)/'media'
            self.request('GET',source,headers={'If-Match':etag},output=path,expected=size)
            digest=hashlib.md5()
            with path.open('rb') as f:
                for chunk in iter(lambda:f.read(65536),b''):digest.update(chunk)
            if etag.strip('"').lower()!=digest.hexdigest():raise StorageError('File berubah saat finalisasi. Silakan bagikan ulang.')
            self.put_file(target,path,mime)
    def delete(self,key): self.request('DELETE',key)
    def put_file(self,key,path,mime): self.request('PUT',key,Path(path),{'Content-Type':mime,'Cache-Control':'private, no-store'})
    def put_bytes(self,key,data,mime): self.request('PUT',key,data,{'Content-Type':mime,'Cache-Control':'private, no-store'})
    def configure_cors(self,origins):
        ns='http://s3.amazonaws.com/doc/2006-03-01/';ET.register_namespace('',ns)
        try: _,raw=self.request('GET',query=[('cors','')]);root=ET.fromstring(raw)
        except StorageError as error:
            if 'NoSuchCORSConfiguration' not in str(error): raise
            root=ET.Element('{'+ns+'}CORSConfiguration')
        for rule in list(root):
            if rule.findtext('{'+ns+'}ID')=='temu-album': root.remove(rule)
        rule=ET.SubElement(root,'{'+ns+'}CORSRule');ET.SubElement(rule,'{'+ns+'}ID').text='temu-album'
        for origin in origins: ET.SubElement(rule,'{'+ns+'}AllowedOrigin').text=origin
        for method in ('PUT','GET','HEAD'): ET.SubElement(rule,'{'+ns+'}AllowedMethod').text=method
        ET.SubElement(rule,'{'+ns+'}AllowedHeader').text='content-type'
        ET.SubElement(rule,'{'+ns+'}ExposeHeader').text='ETag'
        ET.SubElement(rule,'{'+ns+'}MaxAgeSeconds').text='300'
        data=ET.tostring(root,encoding='utf-8',xml_declaration=True)
        self.request('PUT',body=data,query=[('cors','')],headers={'Content-Type':'application/xml','Content-MD5':base64.b64encode(hashlib.md5(data).digest()).decode()})
