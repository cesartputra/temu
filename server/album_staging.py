"""Small S3 staging may use bounded tmpfs; large files keep streaming to disk."""
import os, shutil, tempfile, threading
from contextlib import contextmanager
from pathlib import Path

RAM_ROOT=Path('/dev/shm/satualbum')
RAM_BUDGET=64*1024**2
_ram_reserved=0
_lock=threading.Lock()

def memory_available():
    limits=[]
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):limits.append(int(line.split()[1])*1024)
    except (OSError,ValueError):pass
    for limit,current in (('/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory.current'),('/sys/fs/cgroup/memory/memory.limit_in_bytes','/sys/fs/cgroup/memory/memory.usage_in_bytes')):
        try:limits.append(max(0,int(Path(limit).read_text())-int(Path(current).read_text())))
        except (OSError,ValueError):pass
    return min(limits,default=0)

@contextmanager
def directory(size,prefix,fallback=None):
    global _ram_reserved
    reserved=False;temporary=None
    if fallback is None and 0<size<=16*1024**2:
        with _lock:
            try:
                RAM_ROOT.mkdir(mode=0o700,exist_ok=True)
                safe=not RAM_ROOT.is_symlink() and RAM_ROOT.stat().st_uid==os.getuid() and not RAM_ROOT.stat().st_mode&0o077
                if safe and _ram_reserved+size<=RAM_BUDGET and shutil.disk_usage(RAM_ROOT).free>=_ram_reserved+size+8*1024**2 and memory_available()>=_ram_reserved+size+256*1024**2:
                    temporary=tempfile.TemporaryDirectory(dir=RAM_ROOT,prefix=prefix)
                    _ram_reserved+=size;reserved=True
            except OSError:pass
    try:
        if temporary is not None:
            with temporary as folder:yield folder
        else:
            import album_storage
            with album_storage.temporary_space(size,fallback),tempfile.TemporaryDirectory(dir=fallback,prefix=prefix) as folder:yield folder
    finally:
        if reserved:
            with _lock:_ram_reserved-=size
