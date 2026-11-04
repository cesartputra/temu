"""Private S3 objects with bounded I/O and AWS Signature Version 4.

No credentials or signed URLs are written to logs. New uploads use a single
multipart part; completing it invalidates the guest's PUT URL. Legacy staging
uploads are copied to final keys for compatibility with older browser queues.
"""
import atexit, base64, hashlib, hmac, http.client, os, random, re, socket, ssl, tempfile, shutil, threading, time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, urlsplit
from xml.etree import ElementTree as ET
import album_staging

class StorageError(Exception): pass
class _TransientStorageError(StorageError): pass

_connection_pools={}
_connection_pool_lock=threading.Lock()

class _ConnectionPool:
    def __init__(self,host):
        self.host=host;self._slots=threading.BoundedSemaphore(32);self._lock=threading.Lock();self._idle=[]
        self._context=ssl.create_default_context()
    def acquire(self,deadline):
        remaining=deadline-time.monotonic()
        if remaining<=0 or not self._slots.acquire(timeout=min(10,remaining)):
            raise StorageError('Koneksi Object Storage sedang sibuk. Silakan coba lagi.')
        try:
            now=time.monotonic()
            with self._lock:
                while self._idle:
                    connection,returned=self._idle.pop()
                    if now-returned<30 and connection.sock is not None:return connection
                    connection.close()
            return http.client.HTTPSConnection(self.host,timeout=min(10,remaining),context=self._context)
        except BaseException as error:
            self._slots.release()
            if isinstance(error,(OSError,http.client.HTTPException)):
                raise StorageError('Koneksi Object Storage belum berhasil. Silakan coba lagi.') from error
            raise
    def release(self,connection,reusable):
        try:
            if reusable and connection.sock is not None:
                with self._lock:self._idle.append((connection,time.monotonic()))
            else:connection.close()
        finally:self._slots.release()

def _connection_pool(host):
    with _connection_pool_lock:
        if host not in _connection_pools:_connection_pools[host]=_ConnectionPool(host)
        return _connection_pools[host]

def _close_idle_connections():
    with _connection_pool_lock:
        for pool in _connection_pools.values():
            with pool._lock:
                for connection,_ in pool._idle:
                    try:connection.close()
                    except OSError:pass
                pool._idle.clear()

atexit.register(_close_idle_connections)

_temporary_lock=threading.Lock()
_temporary_reserved=0

@contextmanager
def temporary_space(size,directory=None):
    """Reserve space across workers, including downloads not yet on disk."""
    global _temporary_reserved
    with _temporary_lock:
        if shutil.disk_usage(directory or tempfile.gettempdir()).free < _temporary_reserved+size+128*1024*1024:
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
        if p.scheme!='https' or p.hostname not in ('kencana.basic.box.cloudeka.id','s3.nevaobjects.id') or port not in (None,443) or p.path or p.username or p.password or p.query or p.fragment or not all((self.access,self.secret,self.region)) or not re.fullmatch(r'[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]',self.bucket) or not re.fullmatch(r'[A-Za-z0-9_/-]+/',self.prefix) or '..' in self.prefix:
            raise StorageError('Konfigurasi Object Storage belum lengkap.')
        self.host=p.netloc
        self._pool=_connection_pool(self.host)
    def key(self,kind,identifier,extension=''):
        if kind not in ('incoming','media','thumbnails','previews') or not re.fullmatch(r'[a-f0-9]{32}',identifier) or not re.fullmatch(r'\.[a-z0-9]+|',extension): raise StorageError('Kunci objek tidak valid.')
        return self.prefix+kind+'/'+identifier+extension
    def uri(self,key=''): return '/'+quote(self.bucket+'/'+key,safe='/-_.~')
    def presign(self,method,key,expires=300,mime=None,size=None,download=None,now=None,query=()):
        now=now or datetime.now(timezone.utc);date=now.strftime('%Y%m%d');stamp=now.strftime('%Y%m%dT%H%M%SZ')
        scope=date+'/'+self.region+'/s3/aws4_request';headers={'host':self.host}
        if mime: headers['content-type']=mime
        if size is not None: headers['content-length']=str(size)
        signed=';'.join(sorted(headers));canonical_headers=''.join(k+':'+headers[k]+'\n' for k in sorted(headers))
        values=[*query,('X-Amz-Algorithm','AWS4-HMAC-SHA256'),('X-Amz-Credential',self.access+'/'+scope),('X-Amz-Date',stamp),('X-Amz-Expires',str(expires)),('X-Amz-SignedHeaders',signed)]
        if download: values.append(('response-content-disposition','attachment; filename="'+download+'"'))
        values.append(('response-cache-control','private, no-store')) if method=='GET' else None
        query=query_string(values);canonical='\n'.join((method,self.uri(key),query,canonical_headers,signed,'UNSIGNED-PAYLOAD'))
        to_sign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
        signature=hmac.new(signing_key(self.secret,date,self.region),to_sign.encode(),'sha256').hexdigest()
        return self.endpoint+self.uri(key)+'?'+query+'&X-Amz-Signature='+signature
    def request(self,method,key='',body=b'',headers=None,query=(),limit=65536,output=None,expected=None):
        deadline=time.monotonic()+120
        for attempt in range(3):
            try:return self._request(method,key,body,headers,query,limit,output,expected,deadline)
            except StorageError as error:
                # Creating/completing multipart sessions is recovered by its caller, not replayed blindly.
                if method not in ('GET','HEAD','PUT','DELETE') or not (isinstance(error,_TransientStorageError) or isinstance(error.__cause__,(ConnectionError,TimeoutError,http.client.HTTPException))) or attempt==2:raise
                delay=.5*2**attempt+random.uniform(0,.25)
                if time.monotonic()+delay>=deadline:raise
            time.sleep(delay)
    def _request(self,method,key,body,headers,query,limit,output,expected,deadline):
        now=datetime.now(timezone.utc);date=now.strftime('%Y%m%d');stamp=now.strftime('%Y%m%dT%H%M%SZ');scope=date+'/'+self.region+'/s3/aws4_request'
        digest=hashlib.sha256();size=0
        if isinstance(body,Path):
            with body.open('rb') as f:
                for chunk in iter(lambda:f.read(65536),b''): digest.update(chunk);size+=len(chunk)
        else: digest.update(body);size=len(body)
        values={k.lower():str(v).strip() for k,v in (headers or {}).items()}
        values.update({'host':self.host,'x-amz-date':stamp,'x-amz-content-sha256':digest.hexdigest()})
        # Empty POST length can be removed by an S3 gateway before signature verification.
        if method in ('PUT','POST') and size: values['content-length']=str(size)
        # Gateways may normalize Range; the signed path still authorizes the same object.
        signed_names=sorted(k for k in values if k!='range')
        signed=';'.join(signed_names);canonical_headers=''.join(k+':'+values[k]+'\n' for k in signed_names);query=query_string(query)
        canonical='\n'.join((method,self.uri(key),query,canonical_headers,signed,digest.hexdigest()))
        to_sign='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(canonical.encode()).hexdigest()
        signature=hmac.new(signing_key(self.secret,date,self.region),to_sign.encode(),'sha256').hexdigest()
        values['authorization']='AWS4-HMAC-SHA256 Credential='+self.access+'/'+scope+', SignedHeaders='+signed+', Signature='+signature
        remaining=deadline-time.monotonic()
        if remaining<=0:raise StorageError('Transfer Object Storage terlalu lama. Silakan coba lagi.')
        connection=self._pool.acquire(deadline);response=None;reusable=False
        def transfer_budget():
            seconds=deadline-time.monotonic()
            if seconds<=0:raise StorageError('Transfer Object Storage terlalu lama. Silakan coba lagi.')
            if connection.sock:connection.sock.settimeout(min(60,seconds))
            return seconds
        def read_chunk(amount):
            transfer_budget();chunk=response.read1(amount);transfer_budget()
            if not chunk and isinstance(response.length,int) and response.length>0:raise http.client.IncompleteRead(b'',response.length)
            return chunk
        try:
            if connection.sock is None:
                connection.timeout=min(10,transfer_budget());connection.connect()
                if connection.sock:connection.sock.setsockopt(socket.SOL_SOCKET,socket.SO_KEEPALIVE,1)
            transfer_budget()
            connection.putrequest(method,self.uri(key)+('?' + query if query else ''),skip_host=True,skip_accept_encoding=True)
            for k,v in values.items(): connection.putheader(k,v)
            connection.endheaders()
            if isinstance(body,Path):
                with body.open('rb') as f:
                    for chunk in iter(lambda:f.read(65536),b''):transfer_budget();connection.send(chunk)
            elif body: connection.send(body)
            transfer_budget();response=connection.getresponse();result={k.lower():v for k,v in response.getheaders()}
            transfer_budget()
            data=b''
            if output is None or not 200<=response.status<300:
                chunks=[];remaining=limit
                while remaining:
                    chunk=read_chunk(min(65536,remaining))
                    if not chunk:break
                    chunks.append(chunk);remaining-=len(chunk)
                data=b''.join(chunks)
            if not 200<=response.status<300:
                code='Unavailable'
                try: code=ET.fromstring(data).findtext('Code') or code
                except ET.ParseError: pass
                if not re.fullmatch(r'[A-Za-z0-9]{1,64}',code): code='Unavailable'
                error=_TransientStorageError if response.status in (429,500,502,503,504) else StorageError
                raise error('Object Storage belum dapat diakses ('+code+').')
            if output is not None:
                length=result.get('content-length')
                if not isinstance(expected,int) or not 12<=expected<=100*1024*1024 or (length is not None and length!=str(expected)):raise StorageError('Ukuran salinan Object Storage tidak sesuai.')
                with Path(output).open('wb') as f:
                    remaining=expected
                    while remaining:
                        chunk=read_chunk(min(65536,remaining))
                        if not chunk:raise http.client.IncompleteRead(b'',remaining)
                        f.write(chunk);remaining-=len(chunk)
                    if read_chunk(1):raise StorageError('Ukuran salinan Object Storage tidak sesuai.')
            reusable=response.isclosed() and not response.will_close
            return result,data
        except (OSError,http.client.HTTPException) as error: raise StorageError('Koneksi Object Storage belum berhasil. Silakan coba lagi.') from error
        finally:
            try:
                if response is not None:response.close()
            finally:self._pool.release(connection,reusable)
    def inspect(self,key):
        headers,head=self.request('GET',key,headers={'Range':'bytes=0-31'},limit=32)
        try:
            if value:=headers.get('content-range'):
                match=re.fullmatch(r'bytes 0-(\d+)/(\d+)',value)
                if not match:raise ValueError()
                size=int(match[2])
                if int(match[1])!=len(head)-1 or int(headers.get('content-length',str(len(head))))!=len(head):raise ValueError()
            else:size=int(headers.get('content-length','0'))
            if size<=0 or len(head)!=min(32,size):raise ValueError()
        except ValueError:raise StorageError('Metadata Object Storage tidak sesuai.') from None
        return size,headers.get('content-type','').split(';')[0],headers.get('etag',''),head
    def start_multipart(self,key,mime):
        _,data=self.request('POST',key,headers={'Content-Type':mime,'Cache-Control':'private, no-store'},query=[('uploads','')])
        try:
            root=ET.fromstring(data);identifier=root.findtext('{*}UploadId')
            if not identifier or len(identifier)>2048:raise ValueError()
            return identifier
        except (ET.ParseError,ValueError):raise StorageError('Sesi Object Storage belum berhasil dibuat.')
    def finish_multipart(self,key,identifier,size):
        # HEAD recovers a completed request whose response was lost.
        try:
            _,data=self.request('GET',key,query=[('uploadId',identifier)])
        except StorageError as error:
            if '(NoSuchUpload)' not in str(error):raise
            return
        try:
            root=ET.fromstring(data);parts=root.findall('{*}Part')
            if len(parts)!=1 or parts[0].findtext('{*}PartNumber')!='1' or int(parts[0].findtext('{*}Size'))!=size:raise ValueError()
            etag=parts[0].findtext('{*}ETag')
            if not etag or not re.fullmatch(r'"?[a-fA-F0-9]{32}"?',etag):raise ValueError()
            body=ET.Element('CompleteMultipartUpload');part=ET.SubElement(body,'Part')
            ET.SubElement(part,'PartNumber').text='1';ET.SubElement(part,'ETag').text=etag
            _,data=self.request('POST',key,body=ET.tostring(body),headers={'Content-Type':'application/xml'},query=[('uploadId',identifier)])
            if ET.fromstring(data).tag.rsplit('}',1)[-1]!='CompleteMultipartUploadResult':raise ValueError()
        except (ET.ParseError,ValueError,TypeError):raise StorageError('Bagian unggahan belum lengkap atau ukurannya tidak sesuai.')
    def abort_multipart(self,key,identifier):
        try:self.request('DELETE',key,query=[('uploadId',identifier)])
        except StorageError as error:
            if '(NoSuchUpload)' not in str(error):raise
    def clean_multipart(self,key):
        # Listing the exact ticket key also reaps a create whose response was lost.
        _,data=self.request('GET',query=[('uploads',''),('prefix',key)])
        try:
            root=ET.fromstring(data)
            for upload in root.findall('{*}Upload'):
                if upload.findtext('{*}Key')==key:self.abort_multipart(key,upload.findtext('{*}UploadId'))
            if root.findtext('{*}IsTruncated')=='true':raise StorageError('Pembersihan sesi Object Storage masih berjalan.')
        except ET.ParseError:raise StorageError('Sesi Object Storage belum dapat dibersihkan.')
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
        # Each worker streams one file; shared reservations bound RAM or disk use.
        with album_staging.directory(size,prefix='temu-s3-copy-') as directory:
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
