"""
포트홀 Supabase 업로드 (A방식: 파이 → 서버 바로)

하는일: 사진 → Storage(pothole-images) 올리기 → potholes 테이블에 한줄 추가
인터넷 끊기면 pending_uploads/ 에 모아뒀다가 다음에 다시 보냄

다른코드에서 쓰기:
    from uploader import upload
    upload(jpg_bytes, lat, lon, impact=0.42, kmh=25, label="pothole", conf=0.81)

직접 실행:
    python3 uploader.py test    테스트사진 1장 올려보기
    python3 uploader.py retry   못보낸거 다시보내기
"""
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

SUPA_URL = os.environ.get("SUPA_URL", "https://dwejbbhrjfcqcnslheas.supabase.co")
# publishable(공개용) 키. secret/service_role 키는 절대 여기 넣지말기
SUPA_KEY = os.environ.get("SUPA_KEY", "sb_publishable_sX2k8azs-fszxaFBlg6tWA_TX1l8vrT")
BUCKET = "pothole-images"
TABLE = "potholes"
DEVICE_ID = "pi-01"
MAX_W = 640          # 사진 가로 최대(px). YOLO 입력크기랑 같게 → 50~100KB
JPG_QUALITY = 80

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PENDING = os.path.join(BASE_DIR, "pending_uploads")
HDR = {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}


def shrink(jpg):
    """사진 줄이기 (가로 MAX_W). cv2 없거나 실패하면 그대로"""
    try:
        import cv2
        import numpy as np
        img = cv2.imdecode(np.frombuffer(jpg, np.uint8), cv2.IMREAD_COLOR)
        h, w = img.shape[:2]
        if w > MAX_W:
            img = cv2.resize(img, (MAX_W, int(h * MAX_W / w)))
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPG_QUALITY])
        return buf.tobytes() if ok else jpg
    except Exception:
        return jpg


def _send(jpg, row):
    """실제로 보내기. 실패하면 예외"""
    t = datetime.fromisoformat(row["captured_at"]).astimezone()
    path = f"{DEVICE_ID}/{t:%Y-%m-%d}/{t:%H%M%S_%f}.jpg"
    if jpg:
        r = requests.post(f"{SUPA_URL}/storage/v1/object/{BUCKET}/{path}",
                          headers={**HDR, "Content-Type": "image/jpeg"},
                          data=jpg, timeout=15)
        if r.status_code >= 300:
            raise RuntimeError(f"사진 올리기 실패 {r.status_code}: {r.text[:200]}")
        row["image_url"] = f"{SUPA_URL}/storage/v1/object/public/{BUCKET}/{path}"
    r = requests.post(f"{SUPA_URL}/rest/v1/{TABLE}",
                      headers={**HDR, "Content-Type": "application/json",
                               "Prefer": "return=minimal"},
                      data=json.dumps(row), timeout=15)
    if r.status_code >= 300:
        raise RuntimeError(f"테이블 저장 실패 {r.status_code}: {r.text[:200]}")
    return row


def upload(jpg, lat, lon, impact=None, kmh=None, label="pothole", conf=None,
           title="자동 감지", when=None):
    """포트홀 1건 올리기. 성공하면 row, 실패하면 pending에 저장하고 None"""
    when = when or datetime.now(timezone.utc).astimezone()
    desc = (f"충격 {impact:.2f}g" if impact is not None else "충격 모름") + ", " + \
           (f"{kmh:.0f}km/h" if kmh is not None else "속도모름") + \
           f", {when:%Y-%m-%d %H:%M:%S}"
    row = {
        "title": title, "description": desc, "status": "발견",
        "latitude": lat, "longitude": lon,
        "source": "direct", "device_id": DEVICE_ID,
        "captured_at": when.isoformat(), "impact": impact, "speed_kmh": kmh,
        "label": label, "confidence": conf,
    }
    jpg = shrink(jpg) if jpg else None
    try:
        return _send(jpg, row)
    except Exception as e:
        print(f"업로드 실패 → 나중에 다시보냄 ({e})")
        _save_pending(jpg, row)
        return None


def _save_pending(jpg, row):
    os.makedirs(PENDING, exist_ok=True)
    name = os.path.join(PENDING, f"{time.time():.3f}")
    if jpg:
        with open(name + ".jpg", "wb") as f:
            f.write(jpg)
    with open(name + ".json", "w") as f:
        json.dump(row, f, ensure_ascii=False)


def retry_pending():
    """못보낸거 다시보내기. 보낸개수 돌려줌"""
    if not os.path.isdir(PENDING):
        return 0
    sent = 0
    for fn in sorted(os.listdir(PENDING)):
        if not fn.endswith(".json"):
            continue
        base = os.path.join(PENDING, fn[:-5])
        with open(base + ".json") as f:
            row = json.load(f)
        jpg = open(base + ".jpg", "rb").read() if os.path.exists(base + ".jpg") else None
        try:
            _send(jpg, row)
        except Exception as e:
            print(f"아직 안됨: {e}")
            break
        for ext in (".json", ".jpg"):
            if os.path.exists(base + ext):
                os.remove(base + ext)
        sent += 1
    return sent


def _test():
    import cv2
    import numpy as np
    img = np.full((480, 640, 3), 200, np.uint8)
    cv2.putText(img, "UPLOAD TEST", (120, 250), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (0, 0, 255), 3)
    jpg = cv2.imencode(".jpg", img)[1].tobytes()
    row = upload(jpg, 36.8510, 127.1483, impact=0.0, kmh=0,
                 label="test", conf=None, title="업로드 테스트")
    if row:
        print("성공!", row["image_url"])


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "test":
        _test()
    elif cmd == "retry":
        print(f"{retry_pending()}개 보냄")
    else:
        print(__doc__)
