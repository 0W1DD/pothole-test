"""
pothole SDK 파이썬연결

C라이브러리(libpothole.so) 있으면 그걸쓰고, 없으면 똑같이동작하는 순수파이썬버전씀
(둘다 정수계산이라 결과 완전히같음 - tests/test_sdk.py 로 확인함)

쓰는법
    import pothole
    d = pothole.Detector(threshold_mg=300)      # 바꾸고싶은 설정만넣으면됨
    d.set_speed(kmh=32.5)                       # GPS/OBD 속도 들어올때마다 (모르면 None)
    r, ev = d.feed(t_ms, x_mg, y_mg, z_mg)      # 매샘플마다
    if r == pothole.EVENT: print(ev)

라이브러리 만들기 (파이에서 한번만):
    gcc -O2 -shared -fPIC -Iinclude src/pothole.c -o libpothole.so
"""
import ctypes
import os

__version__ = "0.1.0"

NONE, EVENT, IGNORED = 0, 1, 2
SPEED_UNKNOWN = 0xFFFF
MAX_WINDOW = 32

DEFAULTS = dict(
    threshold_mg=300,     # 감지기준 mg
    window=20,            # 평균낼 샘플수 (400Hz면 0.05초)
    cooldown_ms=2000,     # 감지후 쉬는시간
    min_speed_kmh10=100,  # 10km/h보다 느리면무시 (0이면 안봄)
    need_speed=0,         # 1이면 속도모를때도 무시
    cam_ahead_cm=600,     # 카메라가 앞 몇cm 찍는지 (사진시점계산)
    auto_gain_x10=0,      # 자동기준 (평소흔들림 몇배, x10). 0이면끔
)


class Event:
    __slots__ = ("t_ms", "score_mg", "threshold_mg", "speed_kmh10", "photo_back_ms")

    def __init__(self, t_ms, score_mg, threshold_mg, speed_kmh10, photo_back_ms):
        self.t_ms, self.score_mg, self.threshold_mg = t_ms, score_mg, threshold_mg
        self.speed_kmh10, self.photo_back_ms = speed_kmh10, photo_back_ms

    @property
    def speed_kmh(self):
        return None if self.speed_kmh10 == SPEED_UNKNOWN else self.speed_kmh10 / 10

    def as_tuple(self):
        return (self.t_ms, self.score_mg, self.threshold_mg, self.speed_kmh10, self.photo_back_ms)

    def __repr__(self):
        spd = "속도모름" if self.speed_kmh is None else f"{self.speed_kmh:.1f}km/h"
        return (f"Event(t={self.t_ms}ms, 점수={self.score_mg}mg, 기준={self.threshold_mg}mg, "
                f"{spd}, 사진={self.photo_back_ms}ms전)")


# ===================== C라이브러리 연결 =====================
class _Cfg(ctypes.Structure):
    _fields_ = [("threshold_mg", ctypes.c_uint16), ("window", ctypes.c_uint8),
                ("cooldown_ms", ctypes.c_uint16), ("min_speed_kmh10", ctypes.c_uint16),
                ("need_speed", ctypes.c_uint8), ("cam_ahead_cm", ctypes.c_uint16),
                ("auto_gain_x10", ctypes.c_uint8)]


class _Ev(ctypes.Structure):
    _fields_ = [("t_ms", ctypes.c_uint32), ("score_mg", ctypes.c_uint16),
                ("threshold_mg", ctypes.c_uint16), ("speed_kmh10", ctypes.c_uint16),
                ("photo_back_ms", ctypes.c_uint16)]


class _Det(ctypes.Structure):
    _fields_ = [("cfg", _Cfg), ("buf", ctypes.c_uint16 * MAX_WINDOW), ("sum", ctypes.c_uint32),
                ("idx", ctypes.c_uint8), ("n", ctypes.c_uint8), ("has_last", ctypes.c_uint8),
                ("last_ms", ctypes.c_uint32), ("speed_kmh10", ctypes.c_uint16),
                ("score_mg", ctypes.c_uint16), ("base_q8", ctypes.c_uint32)]


def _load_lib():
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (os.environ.get("POTHOLE_LIB", ""),
              os.path.join(here, "libpothole.so"),
              os.path.join(here, "..", "build", "libpothole.so"),
              os.path.join(here, "..", "libpothole.so")):
        if p and os.path.exists(p):
            try:
                lib = ctypes.CDLL(p)
            except OSError:
                continue
            lib.pd_sizeof_detector.restype = ctypes.c_uint32
            if lib.pd_sizeof_detector() != ctypes.sizeof(_Det):
                continue  # 구조체크기 안맞으면 안씀 (버전다름)
            lib.pd_init.argtypes = [ctypes.POINTER(_Det), ctypes.POINTER(_Cfg)]
            lib.pd_set_speed.argtypes = [ctypes.POINTER(_Det), ctypes.c_uint16]
            lib.pd_feed.argtypes = [ctypes.POINTER(_Det), ctypes.c_uint32, ctypes.c_int16,
                                    ctypes.c_int16, ctypes.c_int16, ctypes.POINTER(_Ev)]
            lib.pd_feed.restype = ctypes.c_int
            lib.pd_threshold.argtypes = [ctypes.POINTER(_Det)]
            lib.pd_threshold.restype = ctypes.c_uint16
            return lib
    return None


_lib = _load_lib()


def _to_i16(v):
    v = int(round(v))
    return -32768 if v < -32768 else 32767 if v > 32767 else v


def _speed10(kmh):
    if kmh is None:
        return SPEED_UNKNOWN
    v = int(round(kmh * 10))
    return 0 if v < 0 else min(v, 0xFFFE)


class _CDetector:
    backend = "C"

    def __init__(self, cfg):
        self._d = _Det()
        self._c = _Cfg(**cfg)
        self._e = _Ev()
        _lib.pd_init(ctypes.byref(self._d), ctypes.byref(self._c))

    def set_speed(self, kmh=None):
        _lib.pd_set_speed(ctypes.byref(self._d), _speed10(kmh))

    def feed(self, t_ms, x_mg, y_mg, z_mg):
        r = _lib.pd_feed(ctypes.byref(self._d), int(t_ms) & 0xFFFFFFFF,
                         _to_i16(x_mg), _to_i16(y_mg), _to_i16(z_mg), ctypes.byref(self._e))
        if r == EVENT:
            e = self._e
            return r, Event(e.t_ms, e.score_mg, e.threshold_mg, e.speed_kmh10, e.photo_back_ms)
        return r, None

    @property
    def score_mg(self):
        return self._d.score_mg

    @property
    def threshold_mg(self):
        return _lib.pd_threshold(ctypes.byref(self._d))


# ===================== 순수파이썬버전 (C랑 한줄한줄 똑같음) =====================
def _isqrt32(v):
    r, b = 0, 1 << 30
    while b > v:
        b >>= 2
    while b:
        if v >= r + b:
            v -= r + b
            r = (r >> 1) + b
        else:
            r >>= 1
        b >>= 2
    return r


class _PyDetector:
    backend = "python"

    def __init__(self, cfg):
        self.c = dict(cfg)
        self.c["window"] = max(1, min(MAX_WINDOW, self.c["window"]))
        self.buf = [0] * MAX_WINDOW
        self.sum = self.idx = self.n = 0
        self.has_last = False
        self.last_ms = 0
        self.speed = SPEED_UNKNOWN
        self.score_mg = 0
        self.base_q8 = 0

    def set_speed(self, kmh=None):
        self.speed = _speed10(kmh)

    @property
    def threshold_mg(self):
        th = self.c["threshold_mg"]
        if self.c["auto_gain_x10"]:
            th = max(th, (self.base_q8 * self.c["auto_gain_x10"]) // 2560)
        return min(th, 0xFFFF)

    def _too_slow(self):
        if self.speed == SPEED_UNKNOWN:
            return bool(self.c["need_speed"])
        return bool(self.c["min_speed_kmh10"]) and self.speed < self.c["min_speed_kmh10"]

    def _photo_back(self):
        if not self.c["cam_ahead_cm"] or self.speed == SPEED_UNKNOWN or self.speed < 10:
            return 0
        return min(self.c["cam_ahead_cm"] * 360 // self.speed, 0xFFFF)

    def feed(self, t_ms, x_mg, y_mg, z_mg):
        t_ms = int(t_ms) & 0xFFFFFFFF
        x, y, z = _to_i16(x_mg), _to_i16(y_mg), _to_i16(z_mg)
        mag = _isqrt32(x * x + y * y + z * z)
        shock = min(abs(mag - 1000), 0xFFFF)

        w = self.c["window"]
        if self.n == w:
            self.sum -= self.buf[self.idx]
        else:
            self.n += 1
        self.buf[self.idx] = shock
        self.sum += shock
        self.idx = (self.idx + 1) % w
        self.score_mg = min(self.sum // self.n, 0xFFFF)

        th = self.threshold_mg
        if self.score_mg > th and (not self.has_last or ((t_ms - self.last_ms) & 0xFFFFFFFF) > self.c["cooldown_ms"]):
            self.has_last = True
            self.last_ms = t_ms
            if self._too_slow():
                return IGNORED, None
            return EVENT, Event(t_ms, self.score_mg, th, self.speed, self._photo_back())

        if self.c["auto_gain_x10"] and self.score_mg <= th and not self._too_slow():
            self.base_q8 += ((self.score_mg << 8) - self.base_q8) >> 10
        return NONE, None


def Detector(backend=None, **kw):
    """감지기 만들기. 설정은 DEFAULTS 이름 그대로 넣으면됨
    backend: None(C있으면C) / "c" / "python" """
    unknown = set(kw) - set(DEFAULTS)
    if unknown:
        raise TypeError(f"모르는 설정: {', '.join(sorted(unknown))}")
    cfg = dict(DEFAULTS, **kw)
    if backend == "python" or (backend is None and _lib is None):
        return _PyDetector(cfg)
    if _lib is None:
        raise RuntimeError("libpothole.so 못찾음 (README 보고 만들기)")
    return _CDetector(cfg)


def g_to_mg(v_g):
    """g단위 → mg (센서값이 g로 나올때)"""
    return v_g * 1000.0
