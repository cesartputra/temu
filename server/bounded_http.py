"""Reject excess HTTP work rather than creating unbounded request threads."""
import threading
from http.server import ThreadingHTTPServer
class BoundedHTTPServer(ThreadingHTTPServer):
    request_queue_size=128
    daemon_threads=True
    def __init__(self,*args,max_workers=32,**kwargs):
        self.slots=threading.BoundedSemaphore(max_workers);super().__init__(*args,**kwargs)
    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                body=b'{"error":"Album sedang sibuk. Coba lagi sebentar.","retryAfter":5}'
                request.sendall(b'HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: '+str(len(body)).encode()+b'\r\nRetry-After: 5\r\nConnection: close\r\n\r\n'+body)
            except OSError:pass
            finally:self.shutdown_request(request)
            return
        request.settimeout(15)
        try:super().process_request(request,address)
        except Exception:self.slots.release();raise
    def process_request_thread(self,request,address):
        try:super().process_request_thread(request,address)
        finally:self.slots.release()
