"""Bounded render cache; filesystem leases also protect Node readers/streams."""
import math
import os
import re
import stat
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

KEY = re.compile(r'^[a-f0-9]{64}$')
ENTRY = re.compile(r'^([a-f0-9]{64})(?:\.(wav|json)|(?:\.[a-zA-Z0-9_-]+)?\.(?:wav|json)\.tmp)$')
LEASE = re.compile(r'^(use\.([a-f0-9]{64})|evict)\.([1-9][0-9]*)\.[a-f0-9]{32}$')

def cache_limit():
    try:
        mb = float(os.environ.get('SONORA_AUDIO_CACHE_MB', '2048'))
        if math.isfinite(mb) and mb > 0:
            return max(1, int(mb * 1024 * 1024))
    except ValueError:
        pass
    return 2048 * 1024 * 1024

def alive(pid):
    if not 0 < pid <= 2147483647:
        return False
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return ctypes.get_last_error() != 87
        try:
            code = ctypes.c_ulong()
            return not kernel.GetExitCodeProcess(ctypes.c_void_p(handle), ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(ctypes.c_void_p(handle))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

class AudioCache:
    def __init__(self, directory, max_bytes=None, clock=time.monotonic):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.leases = self.directory / '.leases'
        self.leases.mkdir(mode=0o700, exist_ok=True)
        if not stat.S_ISDIR(self.leases.lstat().st_mode):
            raise OSError('Audio cache lease directory must not be a symlink.')
        self.max_bytes = cache_limit() if max_bytes is None else max_bytes
        self.clock, self.last_scan = clock, -math.inf

    def _leases(self):
        result = []
        for file in self.leases.iterdir():
            match = LEASE.fullmatch(file.name)
            try:
                regular = stat.S_ISREG(file.lstat().st_mode)
            except FileNotFoundError:
                continue
            if not match or not regular:
                continue
            if alive(int(match[3])):
                result.append(match)
            else:
                file.unlink(missing_ok=True)
        return result

    def _claim(self, name):
        file = self.leases / f'{name}.{os.getpid()}.{uuid.uuid4().hex}'
        with file.open('xb'):
            pass
        return file

    @contextmanager
    def use(self, key):
        if not KEY.fullmatch(key):
            raise ValueError('Invalid audio cache key.')
        # Register before checking maintenance again. An evictor either sees
        # this lease, or finishes before the caller starts touching the entry.
        deadline = time.monotonic() + 30
        while True:
            if not any(match[1] == 'evict' for match in self._leases()):
                claim = self._claim('use.' + key)
                try:
                    if not any(match[1] == 'evict' for match in self._leases()):
                        break
                except BaseException:
                    claim.unlink(missing_ok=True)
                    raise
                claim.unlink(missing_ok=True)
            if time.monotonic() > deadline:
                raise TimeoutError('Audio cache maintenance did not finish.')
            time.sleep(.01)
        try:
            yield
        finally:
            claim.unlink(missing_ok=True)

    def open(self, key, suffix):
        if not KEY.fullmatch(key) or suffix not in ('.wav', '.json'):
            raise ValueError('Invalid audio cache path.')
        file = self.directory / (key + suffix)
        if not stat.S_ISREG(file.lstat().st_mode):
            raise OSError('Audio cache entry must be a regular file.')
        return os.fdopen(os.open(file, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)), 'rb')

    def touch(self, key):
        now = time.time_ns()
        for suffix in ('.wav', '.json'):
            file = self.directory / (key + suffix)
            with self.open(key, suffix) as handle:
                if os.utime in os.supports_fd:
                    os.utime(handle.fileno(), ns=(now, now))
                elif os.utime in os.supports_follow_symlinks:
                    os.utime(file, ns=(now, now), follow_symlinks=False)
                else:
                    # Older Windows Python lacks the follow_symlinks flag;
                    # open() above has already rejected non-regular entries.
                    os.utime(file, ns=(now, now))

    def prune(self, force=False):
        if not force and self.clock() - self.last_scan < 60:
            return None
        claim = self._claim('evict')
        try:
            active = {match[2] for match in self._leases() if match[2]}
            groups, total = {}, 0
            for file in self.directory.iterdir():
                match = ENTRY.fullmatch(file.name)
                if not match:
                    continue
                try:
                    info = file.lstat()
                except FileNotFoundError:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                groups.setdefault(match[1], []).append((file, match[2], info))
                total += info.st_size
            removed = 0
            def remove(files):
                nonlocal total, removed
                for file, _, info in files:
                    try:
                        file.unlink()
                        total -= info.st_size
                        removed += 1
                    except OSError:
                        pass
            entries = []
            for key, files in groups.items():
                if key in active:
                    continue
                pair = [item for item in files if item[1]]
                remove([item for item in files if not item[1]])
                if {item[1] for item in pair} != {'wav', 'json'}:
                    remove(pair)
                else:
                    entries.append((max(max(info.st_mtime_ns, info.st_atime_ns) for _, _, info in pair), key, pair))
            for _, _, pair in sorted(entries):
                if total <= self.max_bytes:
                    break
                remove(pair)
            self.last_scan = self.clock()
            return {'bytes': total, 'removed': removed}
        finally:
            claim.unlink(missing_ok=True)
