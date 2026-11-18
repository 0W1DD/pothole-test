"""
라즈베리파이 홈폴더 정리

절대 안지움. 옮기기만함. 되돌리는 스크립트도 같이만듦

정리하면 이렇게됨
  ~/pothole_project/     최신코드 (pothole_project.zip 풀린거)
      01_pi/             ← 여기서 실행. threshold.json, calib_*.csv, yolo*.pt 도 여기로
      02_sdk/ 03_colab/ 04_matlab/
  ~/tests/               센서 테스트코드 (gps_once.py, adxl_test.py, tilt.py, shake_photo.py ...)
  ~/archive/날짜/         옛날코드, 옛날사진(item, no_item, photos ...), zip, 옛 SDK 폴더 등

쓰는법
  python3 tidy_pi.py          → 어떻게 옮길지 보여주기만함 (아무것도 안바뀜)
  python3 tidy_pi.py --do     → 진짜로 옮김
  되돌리기: bash ~/archive/날짜/undo.sh
"""
import argparse
import hashlib
import os
import shutil
import zipfile
from datetime import datetime

# ===== 정리규칙 (이름 → 어디로) =====
TEST_FILES = {"gps_once.py", "adxl_test.py", "tilt.py", "shake_photo.py",
              "i2c_test.py", "gps_test.py", "cam_test.py", "mpu_test.py"}
RUN_DATA = {"threshold.json", "calib_normal.csv", "calib_bump.csv"}   # 01_pi 에서 써야하는거
CODE_FILES = {"pothole_detect.py", "calibrate.py"}                  # 01_pi 에 새버전있음
OLD_RESULT_DIRS = {"item", "no_item", "boxed", "pothole", "photos", "runs"}
OLD_RESULT_FILES = {"_last.jpg", "nohup.out"}
OLD_DIRS = {"pothole_sdk", "__pycache__"}

# 안건드리는거 (라즈베리파이 기본폴더, 정리결과폴더, 숨김파일)
KEEP = {"Desktop", "Documents", "Downloads", "Music", "Pictures", "Public", "Templates",
        "Videos", "Bookshelf", "pothole_project", "tests", "archive", "tidy_pi.py"}


def same_file(a, b):
    def h(p):
        m = hashlib.md5()
        with open(p, "rb") as f:
            for blk in iter(lambda: f.read(1 << 20), b""):
                m.update(blk)
        return m.hexdigest()
    return os.path.getsize(a) == os.path.getsize(b) and h(a) == h(b)


def plan_moves(home, today):
    proj = os.path.join(home, "pothole_project")
    pi_dir = os.path.join(proj, "01_pi")
    arc = os.path.join(home, "archive", today)
    tests = os.path.join(home, "tests")
    moves, unknown, notes = [], [], []

    zip_path = os.path.join(home, "pothole_project.zip")
    need_unzip = os.path.exists(zip_path) and not os.path.isdir(proj)
    if need_unzip:
        notes.append("pothole_project.zip 풀어서 ~/pothole_project/ 만듦")
    elif not os.path.isdir(proj):
        notes.append("pothole_project 없음 → 지금있는 pothole_detect.py 등을 ~/pothole_project/01_pi/ 로 옮겨서씀")

    def new_code_exists(name):
        if need_unzip:
            with zipfile.ZipFile(zip_path) as z:
                return f"pothole_project/01_pi/{name}" in z.namelist()
        return os.path.exists(os.path.join(pi_dir, name))

    for name in sorted(os.listdir(home)):
        src = os.path.join(home, name)
        if name.startswith(".") or name in KEEP:
            continue
        low = name.lower()
        if name in TEST_FILES or low.endswith("_test.py") or (low.startswith(("gps", "pgs")) and low.endswith(".py")):  # pgs = 오타난 gps파일
            moves.append((src, os.path.join(tests, name), "테스트코드"))
        elif name in RUN_DATA or (low.startswith("yolo") and low.endswith(".pt")):
            dst = os.path.join(pi_dir, name)
            if os.path.exists(dst) and not same_file(src, dst):
                moves.append((src, os.path.join(arc, "old_data", name), "01_pi에 다른버전있음 → 보관"))
            elif os.path.exists(dst):
                moves.append((src, os.path.join(arc, "dup", name), "01_pi에 똑같은거있음 → 보관"))
            else:
                moves.append((src, dst, "실행할때 필요 → 01_pi"))
        elif name in CODE_FILES:
            if new_code_exists(name):
                moves.append((src, os.path.join(arc, "old_code", name), "옛날버전 (새버전은 01_pi)"))
            else:
                moves.append((src, os.path.join(pi_dir, name), "코드 → 01_pi"))
        elif name in OLD_RESULT_DIRS or name in OLD_RESULT_FILES:
            moves.append((src, os.path.join(arc, "old_results", name), "예전 테스트결과"))
        elif name in OLD_DIRS:
            moves.append((src, os.path.join(arc, name), "옛날폴더 (새건 pothole_project 안에)"))
        elif low.endswith(".zip"):
            moves.append((src, os.path.join(arc, "zips", name), "압축파일 보관"))
        elif low.endswith((".log", ".jpg", ".png")):
            moves.append((src, os.path.join(arc, "etc", name), "기타 보관"))
        else:
            unknown.append(name)
    return moves, unknown, notes, need_unzip, zip_path, arc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--do", action="store_true", help="진짜로옮김 (없으면 보여주기만)")
    ap.add_argument("--home", default=os.path.expanduser("~"), help="정리할폴더 (기본 홈)")
    a = ap.parse_args()
    home = os.path.abspath(a.home)
    today = datetime.now().strftime("%Y-%m-%d_%H%M")

    moves, unknown, notes, need_unzip, zip_path, arc = plan_moves(home, today)

    print(f"=== {home} 정리계획 ===")
    for n in notes:
        print("  *", n)
    if not moves:
        print("  옮길거 없음. 이미 깔끔함")
    for src, dst, why in moves:
        kind = "/" if os.path.isdir(src) else ""
        print(f"  {os.path.basename(src) + kind:28s} → ~/{os.path.relpath(dst, home):45s} ({why})")
    if unknown:
        print("\n  모르는거 (안건드림, 직접보고 판단하기):")
        for u in unknown:
            print("    -", u)

    if not a.do:
        print("\n보여주기만함. 괜찮으면: python3 tidy_pi.py --do")
        return

    # ===== 진짜로 옮기기 =====
    if need_unzip:
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(home)
        print("pothole_project.zip 풀었음")
    os.makedirs(arc, exist_ok=True)
    undo = os.path.join(arc, "undo.sh")
    log = os.path.join(arc, "정리기록.txt")
    done = []
    for src, dst, why in moves:
        if os.path.exists(dst):                       # 이름겹치면 뒤에 번호붙임
            base, ext = os.path.splitext(dst)
            k = 2
            while os.path.exists(f"{base}_{k}{ext}"):
                k += 1
            dst = f"{base}_{k}{ext}"
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.move(src, dst)
        done.append((src, dst, why))
    with open(undo, "w") as f:
        f.write("#!/bin/bash\n# 정리 되돌리기 (옮긴거 원래자리로)\n")
        for src, dst, _ in reversed(done):
            f.write(f'mv -n "{dst}" "{src}"\n')
        if need_unzip:
            f.write(f'echo "pothole_project 폴더는 그대로둠 (zip 은 archive/zips 에있음)"\n')
    with open(log, "w") as f:
        for src, dst, why in done:
            f.write(f"{src} -> {dst}  ({why})\n")
    print(f"\n{len(done)}개 옮김")
    print(f"기록: ~/{os.path.relpath(log, home)}")
    print(f"되돌리기: bash ~/{os.path.relpath(undo, home)}")
    print("\n이제 실행은: cd ~/pothole_project/01_pi && python3 pothole_detect.py")


if __name__ == "__main__":
    main()
