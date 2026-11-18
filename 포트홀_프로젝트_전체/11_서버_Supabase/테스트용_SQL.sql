-- 포트홀 프로젝트 Supabase (프로젝트 dwejbbhrjfcqcnslheas) 테스트용 SQL
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run
-- ⚠️ 아래 "test" 정책들은 누구나 올릴 수 있게 여는 테스트용. 발표 끝나면 맨 아래 ④로 닫기

-- ① 사진 저장소 (이미 있으면 건너뛰기)
insert into storage.buckets (id, name, public) values ('pothole-images', 'pothole-images', true)
on conflict (id) do nothing;
create policy "test upload pothole images" on storage.objects
for insert to anon with check (bucket_id = 'pothole-images');

-- ② 파이 → 폰 충격 신호 테이블 (A형 테스트용)
create table if not exists public.shock_events (
  id bigint generated always as identity primary key,
  created_at timestamptz default now(),
  t_ms bigint not null,      -- 충격 시각 (ms)
  photo_ms bigint,           -- 사진으로 쓸 시각 (SDK의 photo_back_ms 반영)
  score real,                -- 충격점수 (g)
  speed_kmh real,
  source text                -- 'pi' 등
);
alter table public.shock_events enable row level security;
create policy "test insert shock" on public.shock_events for insert to anon with check (true);
create policy "test read shock"   on public.shock_events for select to anon using (true);

-- ③ potholes 테스트 업로드 허용 (앱·파이가 직접 올릴 때)
create policy "test insert from app" on public.potholes for insert to anon with check (true);

-- ④ 발표 끝나고 닫기
-- drop policy "test upload pothole images" on storage.objects;
-- drop policy "test insert shock" on public.shock_events;
-- drop policy "test read shock" on public.shock_events;
-- drop policy "test insert from app" on public.potholes;
