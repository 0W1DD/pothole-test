# pothole SDK 빌드
#   make          → 정적라이브러리 + 공유라이브러리 + 예제
#   make test     → 테스트
#   make size     → 크기확인
CC     ?= gcc
CFLAGS ?= -std=c99 -Os -Wall -Wextra -Wpedantic -Iinclude

all: build/libpothole.a build/libpothole.so build/csv_demo

build:
	mkdir -p build

build/pothole.o: src/pothole.c include/pothole.h | build
	$(CC) $(CFLAGS) -fPIC -c src/pothole.c -o $@

build/libpothole.a: build/pothole.o
	$(AR) rcs $@ $^

build/libpothole.so: build/pothole.o
	$(CC) -shared -o $@ $^

build/csv_demo: examples/csv_demo.c build/libpothole.a
	$(CC) $(CFLAGS) examples/csv_demo.c build/libpothole.a -o $@

test: build/libpothole.so
	python3 tests/test_sdk.py

size: build/pothole.o
	size build/pothole.o

clean:
	rm -rf build

.PHONY: all test size clean
